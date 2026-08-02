import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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

test("collector authenticates, journals and decodes passive frames", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "ezone-maintenance-test-"));
  const port = await availablePort();
  const token = "integration-test-token";
  const key = randomBytes(32);
  const child = spawn(process.execPath, [join(import.meta.dirname, "server.mjs")], {
    env: {
      ...process.env,
      PORT: String(port),
      EZONE_MAINTENANCE_DATA: dataDirectory,
      EZONE_COLLECTOR_TOKEN: token,
      EZONE_BROADCAST_KEY_BASE64: key.toString("base64"),
    },
    stdio: "ignore",
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    const record = encryptedRecord(key, "getCAN 1 0703ABCDE0501020330040002");
    const ingest = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ schema: 1, records: [record] }),
    });
    assert.equal(ingest.status, 202);

    const summary = await (await fetch(`${baseUrl}/summary`)).json();
    assert.equal(summary.capture.recordsReceived, 1);
    assert.equal(summary.capture.framesReceived, 1);
    assert.equal(summary.capture.knownFrames, 1);
    assert.equal(summary.capture.unknownFrames, 0);
    assert.equal(summary.capture.devices["07:03:ABCDE"].lastDecoded["05"].values.mode, "heat");

    const files = await readdir(dataDirectory);
    assert.equal(files.some((name) => name.startsWith("capture-") && name.endsWith(".ndjson")), true);
    assert.equal(files.some((name) => name.startsWith("frame-") && name.endsWith(".ndjson")), true);
    assert.equal(files.includes("state.json"), true);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
