# e-zone passive maintenance telemetry handoff

Status: verified live on 2026-08-02 (Australia/Melbourne)

> Repository note: the collector container source referenced below
> (`maintenance-gateway`) lives in this repository — see
> [MAINTENANCE-GATEWAY.md](MAINTENANCE-GATEWAY.md) for its deployment guide.
> The Android bridge source (`android/passive-tap`), its signed APK artifacts
> and the combined 12-test suite live in the `ezone-codex` working repository.

This document is the source-of-truth handoff for the receive-only maintenance
telemetry path built around an Advantage Air e-zone installation. It covers the
observed AAService contract, Android bridge, collector container, persistence,
decoder, validation evidence, operational boundaries and the next diagnostic
step.

It is safe to commit this document. Runtime token and decoder-key values are
intentionally omitted. They are maintained by the operator's existing secret
and `.env` process.

## 1. Verified outcome

The following path is operating successfully:

```text
HVAC control box / CAN
  -> USB stream owned by Advantage Air AAService
  -> explicit Android broadcast on the wall tablet
  -> e-zone Passive Tap v0.1.1
  -> local SQLite store-and-forward queue
  -> authenticated HTTP POST /ingest
  -> maintenance collector container
  -> append-only journals, state summary and frame decoder
```

Verified live endpoints and equipment:

| Item | Observed value |
| --- | --- |
| Wall tablet / controller | `10.160.1.180` |
| Controller read API | TCP `2025` |
| AAService | `14.116` |
| Tablet | Android 10, `PIC7GS10-A` |
| Passive Tap | `0.1.1`, version code `2` |
| Collector ingress | `http://10.160.1.251:3081/ingest` |
| Collector health | `http://10.160.1.251:3081/health` |
| Collector summary | `http://10.160.1.251:3081/summary` |

At `2026-08-02T03:04:15.256Z`, the live collector reported:

```json
{
  "collectorTokenConfigured": true,
  "decoderConfigured": true,
  "recordsReceived": 49,
  "probesReceived": 34,
  "heartbeatsReceived": 15,
  "encryptedMessages": 0,
  "decodedMessages": 0,
  "decryptFailures": 0,
  "framesReceived": 0,
  "bridgeAppVersion": "0.1.1",
  "bridgeOnline": true
}
```

The 34 ordinary probes include manual Save & Test records and heartbeats that
arrived before the heartbeat-aware collector was deployed. Historical state is
preserved but is not retroactively reclassified. New heartbeats are categorized
correctly.

No genuine raw-CAN frame has yet been observed. The live HVAC unit was off and
idle during validation. A read-only `GET /getSystemData` request returned the
cached system snapshot but did not cause a raw-CAN broadcast.

## 2. Safety and authority boundary

This telemetry path is deliberately receive-only.

- AAService retains ownership of the USB accessory and serial stream.
- Passive Tap does not request USB permission or declare a USB accessory.
- Passive Tap has only `INTERNET` and `ACCESS_NETWORK_STATE` permissions.
- It has no boot receiver, background service or CAN-transmit action.
- It contains no Advantage Air control-box write broadcast.
- The collector has no endpoint that writes to the controller.
- The telemetry path does not use the controller's port-2025 control API.
- Do not issue HVAC, zone, mode, fan or temperature changes without the user
  present and explicitly agreeing to the exact change.

Closing the Passive Tap activity normally is safe; its manifest receiver can
still receive explicit AAService broadcasts. Do not Android **Force stop** the
app, because a force-stopped package will not receive broadcasts until it is
opened again.

## 3. AAService broadcast contract

This contract was recovered from AAService 14.116, matching the version reported
by the live system.

AAService sends a no-permission broadcast to an explicit Android component:

```text
Package:   com.air.advantage.zone10
Receiver:  com.air.advantage.ReceiverDataUartForNoPermissionBroadcast
Action:    com.air.advantage.MESSAGE_TO_CB_NO_PERMISSION_BROADCAST
```

The intent contains:

```text
Request-name extra:
  com.air.advantage.GET_DATA_REQUEST

Encrypted byte-array extra:
  com.air.advantage.MESSAGE_TO_CB_NO_PERMISSION_BROADCAST
```

Relevant request-name values are:

| Value | Meaning | Bridge treatment |
| --- | --- | --- |
| `aaServiceInfo` | AAService information, normally sent about every five seconds | Count locally; upload one heartbeat every 30 seconds |
| `rawCan` | One or more validated controller CAN frames | Queue and forward encrypted payload unchanged |
| `backupMessage` | AAService backup data | Ignored by Passive Tap |

The heartbeat proves Android component routing, AAService execution and network
forwarding. It does **not** prove that the control box emitted a CAN frame.

AAService emits `rawCan` only after parsing and validating a qualifying message
from its USB stream. There is no separate receiver-registration request.

Despite the legacy action name containing `TO_CB`, this observed code path is an
AAService-to-application broadcast. Passive Tap never sends this action.

## 4. Broadcast encryption envelope

AAService 14.116 uses the following compatibility envelope:

1. Prefix plaintext with three randomized ASCII bytes.
2. Encrypt with AES-256-CBC and PKCS padding.
3. Use a 16-byte all-zero IV.
4. Encode the ciphertext using Android Base64 URL-safe/no-wrap behavior.
5. Place those encoded bytes in the broadcast byte-array extra.
6. Passive Tap standard-Base64 wraps the received byte array for JSON transport.

The collector reverses the outer JSON-safe Base64, decodes the vendor Base64,
decrypts AES-256-CBC, removes the three-byte prefix and parses the remaining
UTF-8 text.

`EZONE_BROADCAST_KEY_BASE64` must decode to exactly 32 bytes. Its runtime value
was recovered from the matching AAService APK and is now configured on the live
collector. Do not commit or log it.

This vendor envelope should be treated as compatibility encoding, not strong
transport security. Keep the collector on a trusted network and retain bearer
authentication on ingestion.

## 5. Android bridge v0.1.1

Source: `android/passive-tap`

Application identity must remain exact because AAService targets it explicitly:

```text
applicationId: com.air.advantage.zone10
receiver:      com.air.advantage.ReceiverDataUartForNoPermissionBroadcast
```

The real Zone10e app cannot be installed simultaneously under the same package.
Android's package installer provides the final conflict/signature check.

### Configuration

The operator opens the app once and supplies:

- the full collector URL ending in `/ingest`;
- the dynamically generated collector token; and
- whether capture is armed.

The endpoint and token are held in app-private SharedPreferences. The decoder
key never goes on the tablet.

### Tablet status UI

The UI refreshes every two seconds and displays:

- installed bridge version;
- capture armed/paused;
- AAService link: `LIVE`, `STALE` or `WAITING`;
- collector link: `REACHABLE`, `IDLE`, `WAITING`, `ISSUE` or `NOT CONFIGURED`;
- CAN stream: `FRAMES SEEN` or `WAITING`;
- raw CAN frames received;
- AAService heartbeats received;
- records forwarded and queued;
- last CAN frame, heartbeat and successful upload; and
- the most recent upload error.

AAService is considered stale locally after 15 seconds without a heartbeat.
Collector reachability is considered recent for 75 seconds, matching the
30-second heartbeat-upload interval with tolerance for scheduling/network delay.

### Store and forward

- Every raw-CAN ciphertext is written to SQLite before upload.
- The queue retains up to 100,000 records and trims only the oldest overflow.
- Upload batches contain up to 250 records.
- A flush processes up to four batches before rescheduling if work remains.
- HTTP connect timeout is three seconds; read timeout is six seconds.
- Records are removed only after a 2xx collector response.
- Failed records stay queued and retry on the next incoming broadcast or manual
  Save & Test probe.

### Record envelope

The bridge sends:

```json
{
  "schema": 1,
  "records": [
    "one or more records"
  ]
}
```

with:

```http
Authorization: Bearer <dynamic collector token>
Content-Type: application/json
```

Common record metadata includes:

```json
{
  "schema": 1,
  "capturedAtMs": 0,
  "collectorId": "stable bridge UUID",
  "sequence": 1,
  "transport": "aaService-explicit-broadcast",
  "appVersion": "0.1.1",
  "androidRelease": "10",
  "tabletModel": "PIC7GS10-A"
}
```

Manual configuration test:

```json
{
  "kind": "collectorProbe",
  "probeType": "configurationTest"
}
```

Rate-limited AAService heartbeat:

```json
{
  "kind": "collectorProbe",
  "probeType": "aaServiceHeartbeat",
  "sourceRequest": "aaServiceInfo",
  "encryptedPayloadBytes": 128
}
```

Raw controller capture:

```json
{
  "kind": "rawCanCiphertext",
  "payloadBase64": "outer JSON-safe Base64 payload"
}
```

Using `collectorProbe` for the heartbeat is intentional backward compatibility:
an older collector accepts it as an ordinary probe instead of rejecting it and
blocking the tablet's FIFO queue.

## 6. Collector container contract

Source: `maintenance-gateway`

The collector is built by the owning GitHub repository's existing workflow and
published to its GitHub container registry. Runtime deployment, token generation
and `.env` maintenance are separate operator concerns.

Do not hard-code, generate or replace the token in collector code.

### Runtime configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | Internal HTTP port; default `8787` |
| `EZONE_MAINTENANCE_DATA` | Persistent data directory; default `/data` |
| `EZONE_COLLECTOR_TOKEN` | Dynamically generated ingestion bearer token |
| `EZONE_BROADCAST_KEY_BASE64` | Runtime-only 32-byte decoder key encoded as Base64 |

### HTTP API

| Method and path | Authentication | Behaviour |
| --- | --- | --- |
| `POST /ingest` | Bearer token required | Validate, journal, decode and summarize 1-500 schema-1 records; returns `202` |
| `GET /health` | None currently | Collector/token/decoder readiness and last ingestion time |
| `GET /summary` | None currently | Read-only bridge, capture, device, pattern and recent-event summary |

The request-body maximum is 1 MiB. A raw encrypted payload is limited to 16,384
characters. Authentication uses timing-safe comparison. The collector refuses
ingestion when no token is configured.

Because health and summary are currently unauthenticated, do not expose the
collector directly to the public internet. Restrict it to the trusted LAN or a
protected reverse proxy.

### Heartbeat-aware state

Top-level persisted fields include:

```text
heartbeatsReceived
lastHeartbeatAt
probesReceived
encryptedMessages
decodedMessages
decryptFailures
framesReceived
knownFrames
unknownFrames
```

Bridge state includes:

```text
appVersion
androidRelease
tabletModel
heartbeats
lastHeartbeatAt
lastRawCanAt
lastSeen
online
```

Heartbeat probes increment `heartbeatsReceived`, not `probesReceived`. Legacy or
configuration probes continue to increment `probesReceived`. A bridge is online
when its last record was received less than 75 seconds ago.

Later records with missing optional metadata must not erase a previously known
app version, Android release or tablet model.

### Persistence

The `/data` volume contains:

```text
state.json
capture-YYYY-MM-DD.ndjson
frame-YYYY-MM-DD.ndjson
decode-error-YYYY-MM-DD.ndjson
```

Every accepted record is appended to the capture journal. Successfully decoded
frames are also appended individually to the frame journal. Decode failures are
journaled separately. `state.json` is written through a temporary file and
rename.

Persisted state from an older collector loads with migration-safe heartbeat
defaults. Historical generic probes are not rewritten. The current service does
not automatically replay old encrypted captures when a decoder key is added;
build a deliberate offline replay command before relying on retroactive decode.

## 7. Controller frame decoder

After decryption, the expected plaintext is:

```text
getCAN <acknowledgement-flag> <frame> [additional frames...]
```

The acknowledgement flag is `0` or `1`. Each controller frame is exactly 25
characters:

| Characters | Length | Field |
| --- | ---: | --- |
| `0..1` | 2 | System type |
| `2..3` | 2 | Device type |
| `4..8` | 5 | Device UID |
| `9..10` | 2 | Message type |
| `11..24` | 14 | Seven payload bytes as hexadecimal |

The currently known decoder applies to system/device family `07:03` and maps:

| Message | Meaning | Selected decoded values |
| --- | --- | --- |
| `01` | Zone topology | zone count, constant-zone count/list |
| `02` | Unit identity | unit type, activation status, dictionary firmware |
| `03` | Zone command and sensor state | zone, commanded open/closed and percentage, sensor type, set/measured temperature |
| `04` | Zone limits and RF health | min/max damper, motion, error, RSSI |
| `05` | System operating state | on/off, mode, fan, set temperature, controlling zone, fresh air, RF system ID |
| `06` | Control-box firmware | firmware, control-box type, RF firmware |
| `08` | Air-conditioner error | error code |
| `0A` | Control-box identity | identity announcement |
| `12` | Sensor pairing | sensor UID, information, firmware |
| `13` | Control-box information | information byte |

Unknown device families and message types are retained with raw payloads and
classified as undocumented rather than discarded.

Commanded damper percentage is not proof of physical damper position. Component
health claims must distinguish directly reported state from inferred behaviour.

## 8. Build and audit evidence

Passive Tap v0.1.1 release artifact:

```text
android/passive-tap/dist/ezone-passive-tap-v0.1.1.apk
SHA-256: 5c1ba33ef0894eeec0df6a95a741a3a140fefc1a0a2c42feebb45a729bcac1f2
Signing certificate SHA-256:
9770241bc0e4084f1530fa7ce005defc85f14991a80195753a426e7bac7266e5
```

Verified packaged properties:

- version code `2`, version name `0.1.1`;
- package `com.air.advantage.zone10`;
- minimum SDK 17, target SDK 28;
- release signed with APK v1 and v2 schemes;
- same certificate as v0.1.0, allowing an in-place upgrade;
- non-debuggable release manifest;
- only the two network permissions;
- exact receive component and action;
- no USB classes, CAN-transmit actions or `sendBroadcast` call in the packaged
  DEX; and
- full Android release lint passed.

The combined project suite currently contains 12 passing tests covering the
protocol, AES envelope, collector authentication/journaling/decoding, heartbeat
classification, Android manifest/source safety, versioning, web build and
unsafe-control rejection.

The private signing directory must be backed up. Losing it prevents future APKs
from updating the installed bridge in place.

## 9. Deployment runbook

The owning repository and CI workflow are responsible for publishing the
collector image. After the image is available and the operator has updated the
maintained `.env`, refresh only the collector service:

```bash
docker compose pull <collector-service>
docker compose up -d --force-recreate --no-deps <collector-service>
```

Do not use `docker compose down -v`; that removes the persistent capture volume.

Verify without exposing secrets:

```bash
curl -fsS http://10.160.1.251:3081/health
curl -fsS http://10.160.1.251:3081/summary
```

Expected health indicators are:

```json
{
  "ok": true,
  "collectorTokenConfigured": true,
  "decoderConfigured": true,
  "lastIngestAt": "recent ISO timestamp"
}
```

Expected summary indicators while the bridge is healthy but the CAN bus is
idle:

```text
capture.heartbeatsReceived increases about twice per minute
capture.encryptedMessages remains unchanged
capture.framesReceived remains unchanged
capture.bridges[0].appVersion == "0.1.1"
capture.bridges[0].online == true
```

## 10. Failure interpretation

| Observation | Likely layer |
| --- | --- |
| No local tablet heartbeat | AAService stopped, receiver/package issue, capture paused or app force-stopped |
| Local heartbeat increases but upload is stale and queue grows | endpoint, token, routing, firewall or collector availability |
| Collector heartbeats increase but raw messages remain zero | Android path is healthy; control-box CAN stream is idle or has not emitted a qualifying frame |
| Encrypted messages increase but decoded messages do not | decoder disabled or decrypt/format failure |
| `decryptFailures` increases | key/envelope/version mismatch; preserve evidence before changing anything |
| Frames decode but all are unknown | capture is working; protocol mapping requires evidence-led expansion |

## 11. Next diagnostic step

The next objective is the first genuine raw-CAN capture. Do not automate a live
system change.

1. Confirm heartbeats are current, queue is zero and decoder is configured.
2. Record the pre-test `/summary` counters.
3. Agree interactively with the user on one small, reversible system action and
   its original state.
4. Have the user perform or explicitly authorize that single action.
5. Record the exact timestamp and action label.
6. Observe `encryptedMessages`, `decodedMessages`, `framesReceived`, devices,
   patterns and recent events.
7. Restore the original HVAC state if it changed.
8. Correlate the frame delta with the action without claiming physical state
   that the bus did not directly report.

If no raw frame appears, add observation and logging before considering any USB
ownership or transmit-capable approach.

## 12. Recommended follow-ups (not yet implemented)

- Expose collector image version and Git commit SHA through `/health` so a
  deployment can be identified as clearly as the Android bridge.
- Add an offline journal replay command for decoder changes and newly mapped
  message types.
- Authenticate `/summary` or place it behind a trusted reverse proxy.
- Add volume-retention/backup policy and disk-usage alarms.
- Alert on stale bridge heartbeat, growing tablet queue, decrypt failures and
  newly observed undocumented frame families.
- Preserve a timestamped test-event ledger so frame correlations are auditable.

