import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForHealth(baseUrl) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw lastError ?? new Error("Collector did not start");
}

const TOKEN = "integration-test-token";

async function startCollector({ key, seedState } = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "ezone-maintenance-test-"));
  if (seedState) {
    await writeFile(join(dataDirectory, "state.json"), JSON.stringify(seedState), "utf8");
  }
  const port = await availablePort();
  const child = spawn(process.execPath, [join(import.meta.dirname, "server.mjs")], {
    env: {
      ...process.env,
      PORT: String(port),
      EZONE_MAINTENANCE_DATA: dataDirectory,
      EZONE_COLLECTOR_TOKEN: TOKEN,
      ...(key ? { EZONE_BROADCAST_KEY_BASE64: key.toString("base64") } : {}),
    },
    stdio: "ignore",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl);
  } catch (error) {
    child.kill("SIGTERM");
    await rm(dataDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    baseUrl,
    dataDirectory,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      await rm(dataDirectory, { recursive: true, force: true });
    },
  };
}

function ingest(baseUrl, records, { token = TOKEN, headers = {} } = {}) {
  return fetch(`${baseUrl}/ingest`, {
    method: "POST",
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ schema: 1, records }),
  });
}

async function summary(baseUrl) {
  return (await fetch(`${baseUrl}/summary`)).json();
}

function encryptedRecord(key, plaintext) {
  const cipher = createCipheriv("aes-256-cbc", key, Buffer.alloc(16));
  const encrypted = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from("abc"), Buffer.from(plaintext)])),
    cipher.final(),
  ]).toString("base64url");
  return {
    schema: 1,
    kind: "rawCanCiphertext",
    capturedAtMs: Date.now(),
    collectorId: "integration-test",
    sequence: 1,
    payloadBase64: Buffer.from(encrypted, "ascii").toString("base64"),
  };
}

function heartbeatRecord(overrides = {}) {
  return {
    schema: 1,
    kind: "collectorProbe",
    probeType: "aaServiceHeartbeat",
    sourceRequest: "aaServiceInfo",
    encryptedPayloadBytes: 128,
    capturedAtMs: Date.now(),
    collectorId: "bridge-1",
    sequence: 10,
    transport: "aaService-explicit-broadcast",
    appVersion: "0.1.1",
    androidRelease: "10",
    tabletModel: "PIC7GS10-A",
    ...overrides,
  };
}

test("collector authenticates, journals and decodes passive frames", async () => {
  const key = randomBytes(32);
  const collector = await startCollector({ key });

  try {
    const record = encryptedRecord(key, "getCAN 1 0703ABCDE0501020330040002");
    const ingestResponse = await ingest(collector.baseUrl, [record]);
    assert.equal(ingestResponse.status, 202);

    const result = await summary(collector.baseUrl);
    assert.equal(result.capture.recordsReceived, 1);
    assert.equal(result.capture.framesReceived, 1);
    assert.equal(result.capture.knownFrames, 1);
    assert.equal(result.capture.unknownFrames, 0);
    assert.equal(result.capture.devices["07:03:ABCDE"].lastDecoded["05"].values.mode, "heat");

    const bridge = result.capture.bridges.find((entry) => entry.collectorId === "integration-test");
    assert.match(bridge.lastRawCanAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(bridge.heartbeats, 0);

    const files = await readdir(collector.dataDirectory);
    assert.equal(files.some((name) => name.startsWith("capture-") && name.endsWith(".ndjson")), true);
    assert.equal(files.some((name) => name.startsWith("frame-") && name.endsWith(".ndjson")), true);
    assert.equal(files.includes("state.json"), true);
  } finally {
    await collector.stop();
  }
});

test("legacy and configurationTest probes count as ordinary probes", async () => {
  const collector = await startCollector();

  try {
    const legacyProbe = {
      schema: 1,
      kind: "collectorProbe",
      capturedAtMs: Date.now(),
      collectorId: "bridge-1",
      sequence: 1,
    };
    assert.equal((await ingest(collector.baseUrl, [legacyProbe])).status, 202);

    const configurationTest = heartbeatRecord({ probeType: "configurationTest", sequence: 2 });
    assert.equal((await ingest(collector.baseUrl, [configurationTest])).status, 202);

    const result = await summary(collector.baseUrl);
    assert.equal(result.capture.probesReceived, 2);
    assert.equal(result.capture.heartbeatsReceived, 0);
    assert.equal(result.capture.lastHeartbeatAt, null);
  } finally {
    await collector.stop();
  }
});

test("aaServiceHeartbeat counts as a heartbeat and updates bridge metadata", async () => {
  const collector = await startCollector();

  try {
    assert.equal((await ingest(collector.baseUrl, [heartbeatRecord()])).status, 202);

    const result = await summary(collector.baseUrl);
    assert.equal(result.capture.heartbeatsReceived, 1);
    assert.equal(result.capture.probesReceived, 0);
    assert.match(result.capture.lastHeartbeatAt, /^\d{4}-\d{2}-\d{2}T/);

    const bridge = result.capture.bridges.find((entry) => entry.collectorId === "bridge-1");
    assert.equal(bridge.heartbeats, 1);
    assert.equal(bridge.lastHeartbeatAt, result.capture.lastHeartbeatAt);
    assert.equal(bridge.lastSeen, result.capture.lastHeartbeatAt);
    assert.equal(bridge.appVersion, "0.1.1");
    assert.equal(bridge.androidRelease, "10");
    assert.equal(bridge.tabletModel, "PIC7GS10-A");
    assert.equal(bridge.online, true);

    const captureJournal = (await readdir(collector.dataDirectory)).find((name) => name.startsWith("capture-"));
    const journalled = (await readFile(join(collector.dataDirectory, captureJournal), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(journalled.length, 1);
    assert.equal(journalled[0].probeType, "aaServiceHeartbeat");
  } finally {
    await collector.stop();
  }
});

test("missing metadata on a later record does not erase bridge identity", async () => {
  const collector = await startCollector();

  try {
    assert.equal((await ingest(collector.baseUrl, [heartbeatRecord()])).status, 202);
    const bareHeartbeat = {
      schema: 1,
      kind: "collectorProbe",
      probeType: "aaServiceHeartbeat",
      capturedAtMs: Date.now(),
      collectorId: "bridge-1",
      sequence: 11,
    };
    assert.equal((await ingest(collector.baseUrl, [bareHeartbeat])).status, 202);

    const result = await summary(collector.baseUrl);
    assert.equal(result.capture.heartbeatsReceived, 2);

    const bridge = result.capture.bridges.find((entry) => entry.collectorId === "bridge-1");
    assert.equal(bridge.heartbeats, 2);
    assert.equal(bridge.appVersion, "0.1.1");
    assert.equal(bridge.androidRelease, "10");
    assert.equal(bridge.tabletModel, "PIC7GS10-A");
  } finally {
    await collector.stop();
  }
});

test("old persisted state without heartbeat fields loads safely and uses the 75s online window", async () => {
  const sixtySecondsAgo = new Date(Date.now() - 60_000).toISOString();
  const twoMinutesAgo = new Date(Date.now() - 120_000).toISOString();
  const collector = await startCollector({
    seedState: {
      schema: 1,
      startedAt: twoMinutesAgo,
      lastIngestAt: sixtySecondsAgo,
      lastFrameAt: null,
      recordsReceived: 3,
      probesReceived: 3,
      encryptedMessages: 0,
      decodedMessages: 0,
      decryptFailures: 0,
      framesReceived: 0,
      knownFrames: 0,
      unknownFrames: 0,
      bridges: {
        "bridge-recent": {
          collectorId: "bridge-recent",
          firstSeen: twoMinutesAgo,
          lastSeen: sixtySecondsAgo,
          records: 2,
          androidRelease: "10",
          tabletModel: "PIC7GS10-A",
          appVersion: "0.1.0",
          lastSequence: 2,
        },
        "bridge-stale": {
          collectorId: "bridge-stale",
          firstSeen: twoMinutesAgo,
          lastSeen: twoMinutesAgo,
          records: 1,
          androidRelease: "",
          tabletModel: "",
          appVersion: "",
          lastSequence: 1,
        },
      },
      devices: {},
      patterns: {},
      recentEvents: [],
    },
  });

  try {
    const result = await summary(collector.baseUrl);
    assert.equal(result.capture.heartbeatsReceived, 0);
    assert.equal(result.capture.lastHeartbeatAt, null);
    assert.equal(result.capture.probesReceived, 3);

    const recent = result.capture.bridges.find((entry) => entry.collectorId === "bridge-recent");
    const stale = result.capture.bridges.find((entry) => entry.collectorId === "bridge-stale");
    assert.equal(recent.online, true);
    assert.equal(stale.online, false);

    assert.equal((await ingest(collector.baseUrl, [heartbeatRecord({ collectorId: "bridge-recent" })])).status, 202);
    const afterHeartbeat = await summary(collector.baseUrl);
    assert.equal(afterHeartbeat.capture.heartbeatsReceived, 1);
    const upgraded = afterHeartbeat.capture.bridges.find((entry) => entry.collectorId === "bridge-recent");
    assert.equal(upgraded.heartbeats, 1);
    assert.equal(upgraded.appVersion, "0.1.1");
    assert.equal(upgraded.records, 3);
  } finally {
    await collector.stop();
  }
});

test("ingest rejects missing and invalid tokens", async () => {
  const collector = await startCollector();

  try {
    assert.equal((await ingest(collector.baseUrl, [heartbeatRecord()], { token: null })).status, 401);
    assert.equal((await ingest(collector.baseUrl, [heartbeatRecord()], { token: "wrong-token" })).status, 401);

    const result = await summary(collector.baseUrl);
    assert.equal(result.capture.recordsReceived, 0);
    assert.equal(result.capture.heartbeatsReceived, 0);
  } finally {
    await collector.stop();
  }
});
