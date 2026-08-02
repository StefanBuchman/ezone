import { createHash, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { decodeCaptureRecord, KNOWN_CONTROLLER_MESSAGES, parseKey } from "./protocol.mjs";

const port = Number.parseInt(process.env.PORT || "8787", 10);
const dataDirectory = process.env.EZONE_MAINTENANCE_DATA || "/data";
const configuredToken = process.env.EZONE_COLLECTOR_TOKEN || "";
const configuredKey = process.env.EZONE_BROADCAST_KEY_BASE64 || "";
const key = configuredKey ? parseKey(configuredKey) : null;
const statePath = join(dataDirectory, "state.json");

await mkdir(dataDirectory, { recursive: true });

function initialState() {
  return {
    schema: 1,
    startedAt: new Date().toISOString(),
    lastIngestAt: null,
    lastFrameAt: null,
    recordsReceived: 0,
    probesReceived: 0,
    heartbeatsReceived: 0,
    lastHeartbeatAt: null,
    encryptedMessages: 0,
    decodedMessages: 0,
    decryptFailures: 0,
    framesReceived: 0,
    knownFrames: 0,
    unknownFrames: 0,
    bridges: {},
    devices: {},
    patterns: {},
    recentEvents: [],
  };
}

async function loadState() {
  try {
    return { ...initialState(), ...JSON.parse(await readFile(statePath, "utf8")) };
  } catch {
    return initialState();
  }
}

let state = await loadState();
let ingestQueue = Promise.resolve();

function dateSuffix(isoTimestamp) {
  return isoTimestamp.slice(0, 10);
}

async function appendJournal(prefix, timestamp, value) {
  const path = join(dataDirectory, `${prefix}-${dateSuffix(timestamp)}.ndjson`);
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function saveState() {
  const temporaryPath = `${statePath}.next`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryPath, statePath);
}

function safeText(value, maximum = 160) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function recordBridge(record, receivedAt) {
  const collectorId = safeText(record.collectorId, 128) || "unknown";
  const bridge = state.bridges[collectorId] ?? {
    collectorId,
    firstSeen: receivedAt,
    records: 0,
    heartbeats: 0,
    lastHeartbeatAt: null,
    lastRawCanAt: null,
    androidRelease: "",
    tabletModel: "",
    appVersion: "",
  };
  bridge.lastSeen = receivedAt;
  bridge.records += 1;
  bridge.androidRelease = safeText(record.androidRelease, 32) || bridge.androidRelease || "";
  bridge.tabletModel = safeText(record.tabletModel, 80) || bridge.tabletModel || "";
  bridge.appVersion = safeText(record.appVersion, 32) || bridge.appVersion || "";
  bridge.lastSequence = Number.isFinite(record.sequence) ? record.sequence : null;
  state.bridges[collectorId] = bridge;
  return bridge;
}

function recordFrame(frame, receivedAt) {
  state.framesReceived += 1;
  if (frame.classification === "known") state.knownFrames += 1;
  else state.unknownFrames += 1;

  const deviceKey = `${frame.systemType}:${frame.deviceType}:${frame.uid}`;
  const device = state.devices[deviceKey] ?? {
    key: deviceKey,
    systemType: frame.systemType,
    deviceType: frame.deviceType,
    uid: frame.uid,
    firstSeen: receivedAt,
    frames: 0,
    messageTypes: {},
  };
  device.lastSeen = receivedAt;
  device.frames += 1;
  device.lastFrame = frame.raw;
  device.messageTypes[frame.messageType] = (device.messageTypes[frame.messageType] ?? 0) + 1;
  if (frame.decoded) {
    device.lastDecoded = device.lastDecoded ?? {};
    device.lastDecoded[frame.messageType] = {
      at: receivedAt,
      name: frame.messageName,
      values: frame.decoded,
    };
  }
  state.devices[deviceKey] = device;

  const patternKey = `${frame.systemType}:${frame.deviceType}:${frame.messageType}`;
  const pattern = state.patterns[patternKey] ?? {
    key: patternKey,
    systemType: frame.systemType,
    deviceType: frame.deviceType,
    messageType: frame.messageType,
    classification: frame.classification,
    messageName: frame.messageName,
    firstSeen: receivedAt,
    count: 0,
  };
  pattern.lastSeen = receivedAt;
  pattern.count += 1;
  pattern.lastPayload = frame.payloadHex;
  state.patterns[patternKey] = pattern;

  state.recentEvents.unshift({
    at: receivedAt,
    deviceKey,
    messageType: frame.messageType,
    messageName: frame.messageName,
    classification: frame.classification,
    payloadHex: frame.payloadHex,
    decoded: frame.decoded,
  });
  state.recentEvents = state.recentEvents.slice(0, 80);
}

function validateRecord(record) {
  if (!record || typeof record !== "object") throw new Error("Capture record must be an object");
  if (record.schema !== 1) throw new Error("Unsupported capture record schema");
  if (record.kind !== "collectorProbe" && record.kind !== "rawCanCiphertext") {
    throw new Error("Unsupported capture record kind");
  }
  if (record.kind === "rawCanCiphertext") {
    if (typeof record.payloadBase64 !== "string" || record.payloadBase64.length > 16_384) {
      throw new Error("Invalid encrypted payload");
    }
  }
}

async function ingest(records) {
  const receivedAt = new Date().toISOString();
  for (const record of records) {
    validateRecord(record);
    state.recordsReceived += 1;
    state.lastIngestAt = receivedAt;
    const bridge = recordBridge(record, receivedAt);
    await appendJournal("capture", receivedAt, { serverReceivedAt: receivedAt, ...record });

    if (record.kind === "collectorProbe") {
      if (record.probeType === "aaServiceHeartbeat") {
        state.heartbeatsReceived += 1;
        state.lastHeartbeatAt = receivedAt;
        bridge.heartbeats = (bridge.heartbeats ?? 0) + 1;
        bridge.lastHeartbeatAt = receivedAt;
      } else {
        state.probesReceived += 1;
      }
      continue;
    }

    state.encryptedMessages += 1;
    bridge.lastRawCanAt = receivedAt;
    if (!key) continue;

    try {
      const decoded = decodeCaptureRecord(record, key);
      state.decodedMessages += 1;
      state.lastFrameAt = receivedAt;
      for (const frame of decoded.frames) {
        recordFrame(frame, receivedAt);
        await appendJournal("frame", receivedAt, {
          serverReceivedAt: receivedAt,
          collectorId: safeText(record.collectorId, 128),
          sequence: record.sequence,
          acknowledgementRequested: decoded.acknowledgementRequested,
          ...frame,
        });
      }
    } catch (error) {
      state.decryptFailures += 1;
      await appendJournal("decode-error", receivedAt, {
        serverReceivedAt: receivedAt,
        collectorId: safeText(record.collectorId, 128),
        sequence: record.sequence,
        error: error instanceof Error ? error.message : "Unknown decode error",
      });
    }
  }
  await saveState();
}

function tokenMatches(header) {
  if (!configuredToken) return false;
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(configuredToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJson(request, maximumBytes = 1_048_576) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maximumBytes) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(encoded),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(encoded);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    return json(response, 200, {
      ok: true,
      collectorTokenConfigured: Boolean(configuredToken),
      decoderConfigured: Boolean(key),
      lastIngestAt: state.lastIngestAt,
    });
  }

  if (request.method === "GET" && url.pathname === "/summary") {
    const now = Date.now();
    // Heartbeat uploads are rate-limited to one per 30s, so allow two missed
    // intervals plus slack before calling a bridge offline.
    const bridges = Object.values(state.bridges).map((bridge) => ({
      ...bridge,
      online: Boolean(bridge.lastSeen && now - Date.parse(bridge.lastSeen) < 75_000),
    }));
    return json(response, 200, {
      collector: {
        state: "online",
        tokenConfigured: Boolean(configuredToken),
        dataDirectory,
      },
      decoder: {
        configured: Boolean(key),
        knownControllerMessages: KNOWN_CONTROLLER_MESSAGES,
      },
      capture: { ...state, bridges },
    });
  }

  if (request.method === "POST" && url.pathname === "/ingest") {
    if (!configuredToken) {
      return json(response, 503, { ok: false, error: "Collector token is not configured" });
    }
    if (!tokenMatches(request.headers.authorization)) {
      return json(response, 401, { ok: false, error: "Invalid collector token" });
    }
    if (!(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      return json(response, 415, { ok: false, error: "Content-Type must be application/json" });
    }

    try {
      const body = await readJson(request);
      if (body.schema !== 1 || !Array.isArray(body.records) || body.records.length < 1 || body.records.length > 500) {
        throw new Error("Supply between 1 and 500 schema-1 records");
      }
      const work = ingestQueue.then(() => ingest(body.records));
      ingestQueue = work.catch(() => undefined);
      await work;
      return json(response, 202, {
        ok: true,
        accepted: body.records.length,
        receipt: createHash("sha256").update(JSON.stringify(body.records)).digest("hex").slice(0, 16),
      });
    } catch (error) {
      return json(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : "Invalid capture payload",
      });
    }
  }

  return json(response, 404, { ok: false, error: "Not found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`e-zone maintenance collector listening on ${port}`);
  console.log(`capture token: ${configuredToken ? "configured" : "MISSING"}`);
  console.log(`frame decoder: ${key ? "configured" : "capture-only"}`);
});
