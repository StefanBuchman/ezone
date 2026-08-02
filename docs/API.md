# API

The HTTP API this app serves. For the Advantage Air tablet's own API — the one this
app consumes — see [HARDWARE.md](HARDWARE.md#the-tablet-api).

Everything below is defined in `backend/main.py`.

- [Conventions](#conventions)
- [The state payload](#the-state-payload)
- [`GET /api/state`](#get-apistate)
- [`POST /api/aircon`](#post-apiaircon)
- [`POST /api/auto`](#post-apiauto)
- [`GET /api/auto/log`](#get-apiautolog)
- [`GET /api/activity`](#get-apiactivity)
- [`GET /api/history`](#get-apihistory)
- [`GET /api/temps`](#get-apitemps)
- [`GET /api/today`](#get-apitoday)
- [`POST /api/filter/cleaned`](#post-apifiltercleaned)
- [`GET /api/health`](#get-apihealth)
- [Static routes](#static-routes)
- [Errors](#errors)

## Conventions

- Base URL is the app itself: `http://<host>:8321` with the supplied compose files
  (the container listens on 8000).
- **No authentication, no CORS configuration, no rate limiting.** Anyone who can
  reach the port has full control of the air conditioner. Keep it on the LAN.
- Requests and responses are JSON. `POST` bodies require
  `Content-Type: application/json`.
- FastAPI's interactive docs are available at `/docs` and the OpenAPI schema at
  `/openapi.json`.
- Temperatures are °C, times are unix seconds unless the field name says otherwise,
  durations are seconds unless the field name says minutes.

## The state payload

Three endpoints (`GET /api/state`, `POST /api/aircon`, `POST /api/auto`) return the
same envelope. It is described once here.

| Field | Type | Meaning |
|-------|------|---------|
| `ok` | bool | the last poll of the tablet succeeded |
| `ageSeconds` | number \| null | age of the observed data; `null` if nothing has ever been fetched |
| `error` | string | last error from the tablet, `""` when healthy. `"serving last-known state"` after a cold start with the tablet asleep |
| `mock` | bool | `EZONE_MOCK` is on; no real hardware is involved |
| `mqtt` | bool \| null | sensor feed connected; `null` when no feed is configured |
| `pending` | bool | an undelivered change is queued for the tablet |
| `pendingAgeSeconds` | number \| null | how long it has been queued |
| `recentPaths` | array of string arrays | paths with delivered-but-unconfirmed intent, e.g. `[["info","setTemp"],["zones","z01","state"]]` |
| `outdoor` | number \| null | outdoor temperature from Open-Meteo; `null` if older than 2 hours |
| `data` | object \| null | the effective system state (see below) |

`data` is the tablet's whole `getSystemData` document — `aircons`, `system`,
`myScenes`, and the unused `myLights`/`myThings`/… branches — with three
app-supplied additions under each `aircons.ac1.zones[<zid>]`:

| Addition | Present when | Shape |
|----------|--------------|-------|
| `sensor` | a sensor maps to the zone | `{sensor, temperature, humidity, battery, linkquality, ageSeconds, stale}` |
| `measuredTemp` | the reading is fresh | overwritten with the sensor temperature (the tablet's own value is `0.0` on a system without e-zone temperature sensors) |
| `auto` | the zone is sensor-equipped (autopilot manages it while auto is on) | `{calling, suspended}` — `suspended` is `null` or a reason string |

The envelope also carries a top-level `auto` object — the master switch and target:
`{"enabled": bool, "target": float}`. While enabled, the dial in the UI edits this
target (0.5° steps) and every sensor-equipped zone is driven toward it.

Abridged example:

```json
{
  "ok": true,
  "ageSeconds": 4.2,
  "error": "",
  "mock": false,
  "mqtt": true,
  "pending": false,
  "pendingAgeSeconds": null,
  "recentPaths": [["info", "setTemp"]],
  "outdoor": 13.9,
  "data": {
    "aircons": {
      "ac1": {
        "info": {
          "state": "on", "mode": "heat", "fan": "medium", "setTemp": 23.0,
          "countDownToOff": 58, "countDownToOn": 0,
          "airconErrorCode": "", "filterCleanStatus": 0, "noOfZones": 2,
          "myZone": 0, "noOfConstants": 0
        },
        "zones": {
          "z01": {
            "name": "Downstairs", "number": 1, "state": "open", "value": 100,
            "setTemp": 24.0, "measuredTemp": 20.4, "minDamper": 0, "maxDamper": 100,
            "sensor": {
              "sensor": "climate-downstairs", "temperature": 20.4, "humidity": 48.1,
              "battery": 84, "linkquality": 132, "ageSeconds": 61.3, "stale": false
            },
            "auto": {"enabled": true, "target": 21.5, "calling": true, "suspended": null}
          },
          "z02": {"name": "Upstairs", "number": 2, "state": "close", "value": 100}
        }
      }
    },
    "system": {"name": "e-zone", "sysType": "e-zone", "tspIp": "10.160.1.180"},
    "myScenes": {"scenes": {}, "scenesOrder": []}
  }
}
```

---

## `GET /api/state`

The main read. Returns the effective state: last-observed tablet state with
delivered-but-unconfirmed intent and queued intent layered on top.

| Query | Type | Default | Notes |
|-------|------|---------|-------|
| `refresh` | int | `0` | non-zero forces a live read of the tablet before responding. Cheap when the tablet is awake; up to ~20 s when it is not, because the request sits through the client's four attempts. A read also happens automatically if the cache is empty. |

```bash
curl -s http://localhost:8321/api/state | jq '.ok, .data.aircons.ac1.info.state'
curl -s 'http://localhost:8321/api/state?refresh=1'
```

**503** if the app has never obtained any state at all (no cache, no
`last_state.json`, tablet unreachable). Once it has state, it serves it with
`ok: false` rather than failing.

---

## `POST /api/aircon`

The only write path to the air conditioner. Validated, clamped, guarded, and — if
the tablet is asleep — queued.

**Body**

```jsonc
{
  "info":  { },          // optional
  "zones": { }           // optional; at least one of the two must be non-empty
}
```

`info` accepts only these keys:

| Key | Type | Accepted values |
|-----|------|-----------------|
| `state` | string | `"on"` \| `"off"` |
| `mode` | string | `"heat"` \| `"cool"` \| `"vent"` \| `"dry"` |
| `fan` | string | `"low"` \| `"medium"` \| `"high"` |
| `setTemp` | number | clamped to 16–32, coerced to int |
| `countDownToOff` | number | minutes, clamped to 0–720. `0` cancels |
| `countDownToOn` | number | minutes, clamped to 0–720. `0` cancels |

**While auto is engaged**, `setTemp` is not written to the tablet — the unit's
thermostat is a drive/park actuator owned by the control loop, so a raw
setpoint write can only come from a client with a stale view of the auto
state. The value is redirected into the auto target instead (clamped 16–32,
half-degree steps), no `setTemp` manual override is marked, and the response
carries `coercedTarget` so the UI can explain what happened. Other fields in
the same request are applied normally.

`zones` is `{"<zone id>": {...}}` where the zone id must exist on the system
(`"z01"`, `"z02"`, …) and only these keys are accepted:

| Key | Type | Accepted values |
|-----|------|-----------------|
| `state` | string | `"open"` \| `"close"` |
| `value` | number | damper %, clamped to 0–100 and snapped to the nearest 5 |

Any other key in either object is rejected with **422**. See
[the safety invariant](ARCHITECTURE.md#write-validation-and-the-safety-invariant)
for the **409** case.

**Response** — the state payload, plus:

| Field | Meaning |
|-------|---------|
| `queued` | `true` if the tablet was unreachable and the change was stored for later delivery |
| `ack` | the tablet's raw acknowledgement, only present when `queued` is `false` |
| `coercedTarget` | present only when a `setTemp` write arrived while auto was engaged: the value it was redirected to as the new auto target |

```bash
# turn on, heat, 22°
curl -s -X POST http://localhost:8321/api/aircon \
  -H 'Content-Type: application/json' \
  -d '{"info": {"state": "on", "mode": "heat", "setTemp": 22}}'

# open a zone at 60% damper and close another, in one write
curl -s -X POST http://localhost:8321/api/aircon \
  -H 'Content-Type: application/json' \
  -d '{"zones": {"z01": {"state": "open", "value": 60}, "z02": {"state": "close"}}}'

# run for two hours from standby
curl -s -X POST http://localhost:8321/api/aircon \
  -H 'Content-Type: application/json' \
  -d '{"info": {"state": "on", "countDownToOff": 120}}'
```

```json
{"queued": false, "ack": {"ack": true, "request": "setAircon"}, "ok": true, "...": "state payload"}
```

Notes:

- The response is sent as soon as the tablet acknowledges; it does **not** wait for
  the tablet's reported state to change. The change appears in `recentPaths` until
  a poll confirms it.
- Every accepted change marks a one-hour manual override on the scopes it touched
  (`power` for `state`/countdowns, `setTemp`, and `zone:<id>` per zone), during which
  the autopilot will not act on them.
- A queued change is merged with anything already queued; there is at most one
  pending change object.

---

## `POST /api/auto`

Configure the master autopilot: one switch, one target. While enabled, every
sensor-equipped zone follows the target; zones without sensors stay manual.

**Body**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `enabled` | bool | no | engage or disengage auto |
| `target` | number | no | target °C, clamped to 16–32 and rounded to the nearest 0.5 |

Omitted fields are left unchanged; the defaults are `{"enabled": false,
"target": 21.0}`.

Enabling clears the `power` and `setTemp` manual overrides plus the zone override
of every sensor-equipped zone — turning auto on is consent for it to act
immediately. Disabling clears the autopilot's internal calling/suspended state and
its power ownership. Both are appended to the audit log.

**Response** — the state payload (top-level `auto` reflects the change).

```bash
curl -s -X POST http://localhost:8321/api/auto \
  -H 'Content-Type: application/json' \
  -d '{"enabled": true, "target": 21.5}'
```

---

## `GET /api/auto/log`

The autopilot audit trail, newest first.

| Query | Type | Default | Range |
|-------|------|---------|-------|
| `limit` | int | `50` | 1–500 |

| `action` | Written when |
|----------|--------------|
| `decide` | a reasoning line was produced this tick (zone started/stopped calling, waiting on a cycle timer, zone suspended) |
| `apply` | a change was sent to the tablet; `reason` is the JSON of the change |
| `blocked` | the decision failed validation (e.g. the last-open-zone invariant) |
| `error` | the tablet rejected or did not answer the write |
| `config` | the master enable/target was changed via `POST /api/auto` |

```json
{
  "entries": [
    {"ts": 1754087520, "action": "apply",  "reason": "{\"info\": {\"state\": \"on\"}}"},
    {"ts": 1754087520, "action": "decide", "reason": "z01: calling (room 19.4°, target 21.5°)"},
    {"ts": 1754086920, "action": "config", "reason": "z01: enabled=True target=21.5"}
  ]
}
```

---

## `GET /api/activity`

The unified activity feed behind the app's Activity tab: every change to the
system, newest first, attributed to whoever made it. Structured — the client
composes the sentences.

| Query | Type | Default | Notes |
|-------|------|---------|-------|
| `limit` | int | `60` | 1–200; the response's `more` says whether older entries exist |
| `before` | float | — | page backwards: return entries strictly older than this `ts` |
| `sources` | str | — | comma-separated filter, e.g. `sources=you,auto` |
| `countSince` | float | — | when set, the response gains `todayCount`: total entries with `ts >=` this value (the client passes its local midnight for the Activity summary card) |

| `source` | Meaning |
|----------|---------|
| `you` | a write made through this app |
| `auto` | an autopilot decision or write (`calling`, `satisfied`, `suspended`, `resumed`, `drive`, `park`, `handback`, `power`, `zone`, `blocked`, `error`) |
| `wall` | a change observed on the tablet that no app write explains — wall panel, vendor app, scenes, AA cloud (detected by diffing consecutive polls against in-flight intents) |
| `system` | app plumbing: `queued`, `delivered`, `expired` (queued change dropped after 10 min undelivered), `offline`, `online`, `timerDone` |

```json
{
  "entries": [
    {"ts": 1754087520.2, "source": "auto", "kind": "calling",
     "detail": {"zid": "z02", "name": "Upstairs", "room": 19.6, "target": 20.0}},
    {"ts": 1754087340.7, "source": "wall", "kind": "setTemp", "detail": {"value": 24.0}},
    {"ts": 1754087100.1, "source": "you", "kind": "power", "detail": {"state": "on"}}
  ],
  "more": true
}
```

---

## `GET /api/history`

Raw snapshot rows, oldest first. One row per poll, plus a row for every failed poll.

| Query | Type | Default | Range |
|-------|------|---------|-------|
| `hours` | int | `24` | 1–720 |

```json
{
  "points": [
    {
      "ts": 1754001600, "state": "on", "mode": "heat", "setTemp": 23.0, "fan": "medium",
      "zones": {"z01": {"state": "open", "value": 100, "measuredTemp": 20.4, "humidity": 48.1}},
      "errorCode": "", "filterStatus": 0
    },
    {
      "ts": 1754001630, "state": "unreachable", "mode": null, "setTemp": null, "fan": null,
      "zones": {}, "errorCode": "", "filterStatus": 0
    }
  ]
}
```

`state: "unreachable"` marks a poll where the tablet did not answer — these rows are
what make tablet uptime measurable. `measuredTemp` and `humidity` are `null` when
the zone's sensor reading was missing or stale at that moment.

---

## `GET /api/temps`

Bucket-averaged per-zone temperature series, for charting. Zones with no sensor
readings in the window are omitted entirely.

| Query | Type | Default | Range |
|-------|------|---------|-------|
| `hours` | int | `24` | 1–168 |

Bucket width is `max(300, hours × 3600 / 96)` seconds, i.e. at most 96 points per
zone. Points are `[bucketStartTs, averageTemp]`, rounded to two decimals.

```json
{
  "hours": 24,
  "zones": {
    "z01": {"name": "Downstairs", "points": [[1754001600, 19.82], [1754002500, 20.11]]},
    "z02": {"name": "Upstairs",   "points": [[1754001600, 18.40], [1754002500, 18.55]]}
  }
}
```

---

## `GET /api/today`

Runtime analytics for the current local day (since local midnight), plus the filter
counter. No parameters.

| Field | Type | Meaning |
|-------|------|---------|
| `runtimeSeconds` | int | total unit run time today |
| `cycles` | int | transitions into the `on` state today |
| `byMode` | object | run time per mode, e.g. `{"heat": 5400}`; empty modes omitted |
| `hourly` | array | `[[hour, seconds], …]`, hour 0–23 local, only hours with run time |
| `hourNow` | int | current hour of the local day, so a client can distinguish "idle" from "not yet" |
| `filterRuntimeSeconds` | int | unit run time since the filter was last marked clean |
| `filterCleanedAt` | int | unix seconds of that mark |

Run time is integrated between consecutive snapshots, with each interval capped at
`4 × POLL_SECONDS` so outages are not counted as running.

```json
{
  "runtimeSeconds": 7380, "cycles": 3,
  "byMode": {"heat": 7380},
  "hourly": [[6, 3600], [7, 2100], [18, 1680]],
  "hourNow": 19,
  "filterRuntimeSeconds": 155400, "filterCleanedAt": 1749000000
}
```

---

## `POST /api/filter/cleaned`

Resets the filter runtime counter to now. No body.

```bash
curl -s -X POST http://localhost:8321/api/filter/cleaned
```

```json
{"filterCleanedAt": 1754087999, "filterRuntimeSeconds": 0}
```

---

## `GET /api/health`

Liveness plus a small diagnostic surface. No parameters.

| Field | Type | Meaning |
|-------|------|---------|
| `app` | string | always `"ok"` if the process is answering |
| `ezone` | bool | the last tablet poll succeeded |
| `mock` | bool | mock mode |
| `error` | string | last tablet error |
| `mqtt` | bool \| null | sensor feed connected; `null` when no feed is configured |
| `sensors` | object | `{friendlyName: ageSecondsOfLastMessage}` for every sensor heard from since startup |
| `tabletUptime24h` | number \| null | percentage of polls in the last 24 h that reached the tablet; `null` with no history |

```json
{
  "app": "ok", "ezone": true, "mock": false, "error": "",
  "mqtt": true, "sensors": {"climate-downstairs": 62},
  "tabletUptime24h": 91.4
}
```

`tabletUptime24h` is the number worth watching. A tablet that sleeps aggressively
sits in the 80s or lower; see the [field notes](HARDWARE.md#field-notes) if yours
does.

---

## Static routes

| Route | Serves |
|-------|--------|
| `GET /` | `frontend/index.html` |
| `GET /<path>` | the rest of `frontend/` (app.js, styles.css, manifest, icons, fonts) |

The frontend is same-origin with the API, which is why no CORS handling exists.

---

## Errors

Errors raised by the app use FastAPI's shape:

```json
{"detail": "Blocked: at least one zone must stay open while the system is on (no constant zone is configured on this unit)."}
```

| Status | Raised when |
|--------|-------------|
| **409** | the change would leave the unit running with every zone closed |
| **422** | a field is not whitelisted, an enum value is invalid, the zone id is unknown, or the change is empty. Body-shape errors from Pydantic also return 422, in Pydantic's own list-of-errors format rather than `detail` as a string |
| **503** | `GET /api/state` with no cached state at all and the tablet unreachable |

Note what is *not* an error: a write made while the tablet is asleep returns
**200** with `"queued": true`. The change is accepted and will be delivered — the
client should tell the user it is waiting, not that it failed.
