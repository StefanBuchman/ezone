import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import test from "node:test";
import {
  decodeCaptureRecord,
  parseControllerFrame,
  parseGetCan,
} from "./protocol.mjs";

const systemFrame = "0703ABCDE0501020330040002";

test("parses the 25-character Advantage Air controller envelope", () => {
  const frame = parseControllerFrame(systemFrame);
  assert.equal(frame.systemType, "07");
  assert.equal(frame.deviceType, "03");
  assert.equal(frame.uid, "ABCDE");
  assert.equal(frame.messageType, "05");
  assert.equal(frame.classification, "known");
  assert.deepEqual(frame.decoded, {
    state: "on",
    mode: "heat",
    fan: "high",
    setTemperature: 24,
    controllingZone: 4,
    freshAir: "none",
    rfSystemId: 2,
  });
});

test("keeps undocumented frames visible", () => {
  const frame = parseControllerFrame("0904ABCDE7F01020304050607");
  assert.equal(frame.classification, "unknown");
  assert.equal(frame.payloadHex, "01020304050607");
});

test("parses a getCAN message with multiple frames", () => {
  const message = parseGetCan(`getCAN 1 ${systemFrame} 0904ABCDE7F01020304050607`);
  assert.equal(message.acknowledgementRequested, true);
  assert.equal(message.frames.length, 2);
});

test("decrypts the AAService-compatible AES envelope", () => {
  const key = randomBytes(32);
  const plaintext = `getCAN 1 ${systemFrame}`;
  const prefixed = Buffer.concat([Buffer.from("xyz"), Buffer.from(plaintext)]);
  const cipher = createCipheriv("aes-256-cbc", key, Buffer.alloc(16));
  const vendorPayload = Buffer.concat([cipher.update(prefixed), cipher.final()]).toString("base64url");
  const record = {
    kind: "rawCanCiphertext",
    payloadBase64: Buffer.from(vendorPayload, "ascii").toString("base64"),
  };
  const decoded = decodeCaptureRecord(record, key);
  assert.equal(decoded.plaintext, plaintext);
  assert.equal(decoded.frames[0].messageName, "System operating state");
});
