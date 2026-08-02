import { createDecipheriv } from "node:crypto";

export const KNOWN_CONTROLLER_MESSAGES = Object.freeze({
  "01": "Zone topology",
  "02": "Unit identity",
  "03": "Zone command and sensor state",
  "04": "Zone limits and RF health",
  "05": "System operating state",
  "06": "Control-box firmware",
  "08": "Air-conditioner error",
  "0A": "Control-box identity",
  "12": "Sensor pairing",
  "13": "Control-box information",
});

function requireByte(bytes, index) {
  const value = bytes[index];
  if (!Number.isInteger(value)) throw new Error(`Frame byte ${index} is invalid`);
  return value;
}

function modeName(value) {
  return ({ 0: "auto", 1: "cool", 2: "heat", 3: "vent", 5: "dry" })[value] ?? `unknown-${value}`;
}

function fanName(value) {
  return ({ 0: "off", 1: "low", 2: "medium", 3: "high", 4: "auto", 5: "autoAA" })[value] ?? `unknown-${value}`;
}

function freshAirName(value) {
  return ({ 0: "none", 1: "off", 2: "on" })[value] ?? `unknown-${value}`;
}

function decodeKnownControllerPayload(messageType, bytes) {
  switch (messageType) {
    case "01":
      return {
        zoneCount: requireByte(bytes, 1),
        constantZoneCount: requireByte(bytes, 2),
        constantZones: bytes.slice(3, 6).filter((value) => value > 0),
      };
    case "02":
      return {
        unitType: requireByte(bytes, 0),
        activationStatus: requireByte(bytes, 1),
        dictionaryFirmware: `${requireByte(bytes, 2)}.${requireByte(bytes, 3)}`,
      };
    case "03": {
      const stateAndValue = requireByte(bytes, 1);
      return {
        zone: requireByte(bytes, 0),
        state: (stateAndValue & 0x80) === 0x80 ? "open" : "closed",
        commandedPercent: stateAndValue & 0x7f,
        sensorType: requireByte(bytes, 2),
        setTemperature: requireByte(bytes, 3) / 2,
        measuredTemperature: Number(`${requireByte(bytes, 4)}.${requireByte(bytes, 5)}`),
      };
    }
    case "04":
      return {
        zone: requireByte(bytes, 0),
        minimumDamper: requireByte(bytes, 1),
        maximumDamper: requireByte(bytes, 2),
        motion: requireByte(bytes, 3),
        motionConfiguration: requireByte(bytes, 4),
        zoneError: requireByte(bytes, 5),
        rssi: requireByte(bytes, 6),
      };
    case "05":
      return {
        state: requireByte(bytes, 0) === 1 ? "on" : "off",
        mode: modeName(requireByte(bytes, 1)),
        fan: fanName(requireByte(bytes, 2)),
        setTemperature: requireByte(bytes, 3) / 2,
        controllingZone: requireByte(bytes, 4),
        freshAir: freshAirName(requireByte(bytes, 5)),
        rfSystemId: requireByte(bytes, 6),
      };
    case "06":
      return {
        controlBoxFirmware: `${requireByte(bytes, 0)}.${requireByte(bytes, 1)}`,
        controlBoxType: requireByte(bytes, 2),
        rfFirmwareMajor: requireByte(bytes, 3),
      };
    case "08":
      return {
        errorCode: String.fromCharCode(...bytes.slice(0, 5)).trim(),
      };
    case "0A":
      return { identityAnnouncement: true };
    case "12":
      return {
        sensorUid: bytes.slice(0, 3).map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase(),
        information: requireByte(bytes, 3),
        sensorFirmwareMajor: requireByte(bytes, 4),
      };
    case "13":
      return { information: requireByte(bytes, 0) };
    default:
      return null;
  }
}

export function parseControllerFrame(rawFrame) {
  const raw = String(rawFrame ?? "").trim().toUpperCase();
  if (raw.length !== 25) throw new Error(`Expected a 25-character controller frame, received ${raw.length}`);

  const payloadHex = raw.slice(11);
  if (!/^[0-9A-F]{14}$/.test(payloadHex)) throw new Error("Controller payload is not seven hexadecimal bytes");

  const payloadBytes = payloadHex.match(/../g).map((pair) => Number.parseInt(pair, 16));
  const systemType = raw.slice(0, 2);
  const deviceType = raw.slice(2, 4);
  const uid = raw.slice(4, 9);
  const messageType = raw.slice(9, 11);
  const isKnownController = systemType === "07" && deviceType === "03";
  const messageName = isKnownController ? KNOWN_CONTROLLER_MESSAGES[messageType] : undefined;

  return {
    raw,
    systemType,
    deviceType,
    uid,
    messageType,
    payloadHex,
    payloadBytes,
    classification: messageName ? "known" : "unknown",
    messageName: messageName ?? "Undocumented frame",
    decoded: messageName ? decodeKnownControllerPayload(messageType, payloadBytes) : null,
  };
}

export function parseGetCan(plaintext) {
  const text = String(plaintext ?? "").trim();
  const tokens = text.split(/\s+/);
  if (tokens.length < 3 || tokens[0] !== "getCAN") {
    throw new Error("Decrypted payload is not a getCAN message");
  }
  if (tokens[1] !== "0" && tokens[1] !== "1") {
    throw new Error("getCAN acknowledgement flag is invalid");
  }

  return {
    plaintext: text,
    acknowledgementRequested: tokens[1] === "1",
    frames: tokens.slice(2).map(parseControllerFrame),
  };
}

export function parseKey(base64Key) {
  const key = Buffer.from(String(base64Key ?? "").trim(), "base64");
  if (key.length !== 32) throw new Error("EZONE_BROADCAST_KEY_BASE64 must decode to exactly 32 bytes");
  return key;
}

export function decryptBroadcastPayload(payloadBase64, key) {
  const vendorEncoded = Buffer.from(String(payloadBase64 ?? ""), "base64").toString("ascii");
  if (!vendorEncoded) throw new Error("Broadcast payload is empty");

  const ciphertext = Buffer.from(vendorEncoded, "base64url");
  const decipher = createDecipheriv("aes-256-cbc", key, Buffer.alloc(16));
  const prefixedPlaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (prefixedPlaintext.length <= 3) throw new Error("Decrypted broadcast payload is too short");

  return prefixedPlaintext.subarray(3).toString("utf8");
}

export function decodeCaptureRecord(record, key) {
  if (record?.kind !== "rawCanCiphertext") return null;
  return parseGetCan(decryptBroadcastPayload(record.payloadBase64, key));
}
