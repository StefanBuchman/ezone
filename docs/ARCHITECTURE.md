# Architecture

How the app is put together, and why. Nearly every mechanism here exists because of
a specific way the Advantage Air wall tablet misbehaves; the design is easier to
follow if you read the failure modes first.

- [The four facts that shaped the design](#the-four-facts-that-shaped-the-design)
- [Component map](#component-map)
- [The tablet client](#the-tablet-client)
- [The digital twin](#the-digital-twin)
- [Write validation and the safety invariant](#write-validation-and-the-safety-invariant)
- [Background loops](#background-loops)
- [History and derived data](#history-and-derived-data)
- [The sensor pipeline](#the-sensor-pipeline)
- [The autopilot control loop](#the-autopilot-control-loop)
- [The frontend](#the-frontend)
- [Deployment pipeline](#deployment-pipeline)
- [Persistence](#persistence)
- [Known gaps](#known-gaps)

## The four facts that shaped the design

1. **The tablet sleeps.** When its screen goes off, the Android device drops its
   Wi-Fi association. It is simply not on the network for minutes at a time, and no
   amount of retrying inside one request will help.
2. **Its HTTP server is fragile.** One request at a time; concurrency produces empty
   bodies and truncated JSON. A 200 response is not evidence of a valid payload.
3. **Writes apply with lag.** `setAircon` acknowledges immediately, but
   `getSystemData` can report the old value for several seconds afterwards. Naive
   optimistic UI snaps back and looks broken.
4. **It only measures return air.** e-zone has no room sensors on this install
   (`measuredTemp` is `0.0` for every zone). The unit's own thermostat loop closes
   on the temperature of the air coming back to the plant, which is not the
   temperature of any room you live in.

Facts 1–3 produced the retrying client, the digital twin, and the store-and-forward
queue. Fact 4 produced the entire Zigbee sensor pipeline and the autopilot.

## Component map

```
frontend/            dependency-free PWA, served as static files by the same app
backend/ezone.py     the only code that speaks to the tablet
backend/main.py      FastAPI app, digital twin, loops, history, endpoints
backend/sensors.py   MQTT sensor feed + thermal simulator
backend/autopilot.py pure control logic, no I/O
tests/sim_autopilot.py  fast-clock validation of the control logic
```

Data flows one way in and one way out:

```
zigbee2mqtt ──MQTT──▶ SensorFeed ──┐
                                   ├──▶ Autopilot.tick() ──▶ change dict
tablet ──HTTP──▶ EzoneClient ──▶ cache ──┘                        │
                                   │                              ▼
                                   └──▶ _effective_data() ──▶ /api/state
                                                                  │
                                              _validate_change() ◀─┴─ POST /api/aircon
                                                     │
                                        EzoneClient.set_aircon() or pending queue
```

## The tablet client

`backend/ezone.py` is 80 lines and does four things.

**Single-flight.** Every request takes an `asyncio.Lock`. Reads and writes from the
poll loop, the delivery loop, the autopilot and user requests all serialise through
it, because the tablet cannot handle two at once.

**Retry with backoff.** Delays of 0.5 s, 1 s, 2 s, then give up — four attempts
total, raising `EzoneError`. Deliberately short: if the tablet is asleep, no retry
schedule will reach it, and the caller has a better strategy (queue it) than
blocking the user.

**Structural validation.** A response must parse as JSON *and* contain an expected
key (`aircons` for reads, `ack` for writes). Anything else is treated as a failure
and retried. This is what catches the empty and truncated bodies; without it, a
half-written payload propagates into the cache and the UI shows nonsense.

**Mock mode.** With `EZONE_MOCK=1` the client never opens a socket: reads return a
deep copy of `backend/mock_data.json` and writes deep-merge into that in-memory
state. The mock file is a real capture from the live system with identifiers,
coordinates and push tokens scrubbed. It is what makes the whole app developable on
a laptop.

Writes are sent exactly as the tablet expects them — the change object is
JSON-serialised, URL-encoded, and passed as a query parameter:
`GET /setAircon?json=%7B%22ac1%22%3A...`

## The digital twin

The app never answers "I don't know". `/api/state` always returns the best
available picture, assembled from three layers.

| Layer | Where | Lifetime | Means |
|-------|-------|----------|-------|
| **Observed** | `cache.data` | until the next successful poll | what the tablet last said about itself |
| **Recent** (delivered, unconfirmed) | `recent[]` | until confirmed, or 45 s (`RECENT_TTL`) | we sent this and the tablet accepted it, but hasn't admitted it yet |
| **Pending** (undelivered) | `pending` | until delivered, or 10 min (`PENDING_TTL`) | the tablet was asleep; we're holding this for it |

`_effective_data()` deep-copies the observed state, applies each `recent` entry by
path, then deep-merges `pending` on top. Everything the app exposes or reasons about
for validation uses this effective view — the UI, the safety invariant, and the
`/api/state` payload. Only the poll loop and history recording use raw observed
state.

### Life of a write

```
POST /api/aircon {"info": {"setTemp": 22}}
   │
   ├─ _validate_change()   whitelist, clamp, enforce the last-open-zone invariant
   ├─ _mark_overrides()    autopilot stands down on "setTemp" for one hour
   │
   ├─ tablet known asleep (cache.ok == False)?
   │     └─ yes → _queue_change(): merge into `pending`, persist, return {"queued": true}
   │
   └─ no → EzoneClient.set_aircon()
            ├─ EzoneError → _queue_change(), mark cache not-ok, return {"queued": true}
            └─ ack        → _note_recent(): record intent, return {"queued": false}
```

The response carries the full state payload, so the client is never a round trip
behind after a write.

### Confirmation and honest reverts

`_note_recent()` flattens the change into `(path, value)` pairs — `("info","setTemp")
→ 22` — and stores each with a timestamp, replacing any earlier entry for the same
path. On every successful poll, `_prune_recent()` drops entries where the tablet's
observed value now equals the intent (confirmed), and entries older than 45 seconds
(gave up). The overlay is therefore self-clearing: a working write disappears from
the overlay within one poll cycle, and a write the tablet silently ignored expires,
at which point the UI truthfully shows the tablet's actual state.

Countdown timers need a special case. Setting `countDownToOff: 60` never produces an
observed `60` — the tablet starts ticking immediately and reports 59, 58, … So an
intent of `0` is confirmed by any falsy current value, and an intent of `v > 0` is
confirmed by any current value in `(0, v]`.

The frontend closes the loop on the user's side: it remembers what it asked for, and
if an intent leaves the server's `recentPaths` list without the state matching, it
shows one toast — *"The tablet didn't take that change — showing its actual state"* —
instead of silently flipping a control back.

### Store-and-forward

While `pending` is non-empty, `_deliver_loop()` knocks every 12 seconds. Successive
changes made during the outage are deep-merged into the *same* pending object, so a
user who turns the system on, changes mode and opens a zone while the tablet naps
generates one delivery, not three. `pending` is persisted to `pending.json` with the
time it was queued, so an app restart or container update doesn't lose intent, and
the UI can show how long it has been waiting.

On successful delivery the pending diff is promoted to a `recent` entry, so the
display stays stable across the handover instead of flickering back to observed
state while the tablet catches up.

Queued intent has a shelf life: if the tablet stays unreachable for 10 minutes
(`PENDING_TTL`), the queue is dropped rather than fired at whatever moment the
tablet finally wakes — a "turn it on" from an hour ago is no longer anyone's
intent. The expiry is logged to the activity feed (`system` / `expired`, with the
dropped paths and how long it was held), so a vanished change is never a mystery.
Because the check runs inside the delivery loop, a stale `pending.json` left over
from a restart is also expired instead of delivered.

### Cold start

On startup, `_load_last_state()` reads `last_state.json` into the cache with
`ok = False` and the error string `"serving last-known state"`. If the tablet is
asleep when the container restarts, the app opens with the system as it was, clearly
marked stale, rather than a blank screen or a 503.

## Write validation and the safety invariant

`_validate_change()` in `backend/main.py` is the only path to the tablet for
user- and autopilot-originated changes. It:

- accepts only `state`, `mode`, `fan`, `setTemp`, `countDownToOn`, `countDownToOff`
  in `info`, and only `state` and `value` per zone. Anything else is a 422 — no
  pass-through of arbitrary fields to the hardware;
- enum-checks `state`/`mode`/`fan`/zone `state`, clamps `setTemp` to 16–32 °C,
  countdowns to 0–720 minutes, and damper `value` to 0–100 rounded to the nearest
  5 %, which is the tablet's own granularity;
- rejects unknown zone ids against the current zone list;
- enforces the last-open-zone invariant.

**The invariant.** This install has no constant zone. If the unit runs with every
damper shut, the fan has nowhere to push air. So: if the change would leave the
system on (either it is on and staying on, or it is being turned on) and no zone
would be open afterwards, the request fails with **409** and never reaches the
tablet. The check is evaluated against the effective state, so a queued zone
closure counts. The UI mirrors it by disabling the toggle on the last open zone,
but the backend is the enforcement point — the autopilot's decisions are validated
through the same function, and a blocked decision is written to the audit log.

## Background loops

Four `asyncio` tasks, started in the FastAPI lifespan and cancelled on shutdown.

| Loop | Interval | Job |
|------|----------|-----|
| `_poll_loop` | `POLL_SECONDS` (30) | fetch state, prune confirmed intent, write a history snapshot, persist last-known state |
| `_deliver_loop` | 12 s | if anything is queued, try to deliver it |
| `_outdoor_loop` | 900 s (30 s until the first success) | fetch outdoor temperature from Open-Meteo |
| `_auto_loop` | 60 s (`AUTO_INTERVAL`) | run the autopilot tick and apply its decision |

A failed poll is not silent: `_record_offline()` writes a snapshot row with
`state = 'unreachable'`, which is what makes `/api/health`'s `tabletUptime24h`
measurable. You can quantify how often your tablet naps rather than arguing about it.

Outdoor temperature uses the latitude and longitude the tablet already stores in
`system`, so there is nothing to configure; the tablet's own `suburbTemp` is used by
the frontend only as a fallback, and only when the tablet sets `isValidSuburbTemp`.
The value is served as `null` once it is over two hours old rather than shown stale.

## History and derived data

SQLite in `DATA_DIR/ezone.db`, one connection shared across threads behind a lock,
with all database work pushed off the event loop via `asyncio.to_thread`.

```sql
CREATE TABLE snapshots (
  ts INTEGER PRIMARY KEY,          -- unix seconds; one row per poll
  state TEXT,                      -- 'on' | 'off' | 'unreachable'
  mode TEXT, set_temp REAL, fan TEXT,
  zones TEXT,                      -- JSON: {zid: {state, value, measuredTemp, humidity}}
  error_code TEXT, filter_status INTEGER
);
CREATE TABLE auto_log (ts INTEGER, action TEXT, reason TEXT);
```

Room temperature and humidity are folded into the snapshot's `zones` blob at write
time (stale readings are stored as `null`), which is why `/api/temps` can serve a
per-zone history that the tablet itself has no idea about.

**Runtime accounting.** Runtime is integrated between consecutive samples where the
earlier sample was `on`, with each interval capped at `4 × POLL_SECONDS`. The cap
matters: without it, a four-hour outage between two `on` samples would be counted as
four hours of run time. `/api/today` also derives cycle counts (transitions into
`on`), a per-mode breakdown, and an hourly histogram from the same rows.

**Filter tracking.** The tablet has a `filterCleanStatus` flag, but it is
installer-configured and on this system has never fired in three years. So the app
counts its own: `filter.json` holds the timestamp you last marked the filter clean,
and `/api/today` returns unit runtime hours since then using the same capped
integration. The UI warns at 200 hours and still surfaces the tablet's own flag if it
ever does fire.

## The sensor pipeline

```
SNZB-02 ··Zigbee··▶ coordinator ──▶ zigbee2mqtt ──▶ mosquitto ──▶ SensorFeed
```

`SensorFeed` subscribes to `zigbee2mqtt/+` — a single-level wildcard, so it sees
device state topics but not `.../availability` or other sub-topics — and ignores
`bridge*` topics. A message is ingested only if it parses as a JSON object
containing `temperature`; everything else (switches, contact sensors, bridge
chatter) is dropped. Each reading is stored under the device's friendly name with an
arrival timestamp.

**Mapping to zones is by convention.** Zone `Downstairs` looks for the device
`climate-downstairs` (lowercase, spaces to dashes, `climate-` prefix). Name your
sensors that way and there is nothing to configure. `SENSOR_MAP` overrides it per
zone when you can't or won't rename a device.

**Staleness is first-class.** Every reading carries `ageSeconds` and a `stale` flag
(over 600 s). Stale readings are excluded from history, hidden from the hero
display, marked on the zone card, and — critically — suspend the autopilot for that
zone. A sensor that stops reporting must never leave a control loop acting on a
frozen number.

The connection is supervised: on any MQTT error the feed marks itself disconnected,
sleeps 10 seconds and reconnects forever. `connected` is exposed in `/api/state` and
`/api/health`, and the UI shows a "sensors offline" badge, because a silently dead
sensor feed looks exactly like a very stable house.

**SimFeed** subclasses the feed for mock mode. It runs a crude thermal model driven
by the mock aircon's own state (gain proportional to damper opening when the unit
runs and the zone is open, constant ambient loss otherwise) at `SIM_ACCEL` times
real speed, and publishes the results into the same readings dictionary. The rest of
the app cannot tell the difference, which is what makes end-to-end autopilot testing
possible without hardware.

## The autopilot control loop

`backend/autopilot.py` is pure: `tick(cfg, ac, readings, overrides, now)` returns
`(change | None, [log lines])`. No sockets, no `time.time()`, no globals. That
purity is what lets `tests/sim_autopilot.py` run ten simulated hours against a
thermal model in under a second and assert on the result.

The pilot takes per-zone config, but the product model is simpler: one master
switch and one master target (`auto.json`), which `main.py` fans out to every
sensor-equipped zone each tick (`_pilot_cfg()`). The dial edits the master target
while auto is engaged. Per-zone offsets would slot into `_pilot_cfg()` without
touching the control law.

### Tuning constants

| Constant | Value | Why |
|----------|-------|-----|
| `HYSTERESIS` | ±0.3 °C | a deadband around target; without it dampers and the compressor chatter around the setpoint |
| `SET_DRIVE_HEAT` / `SET_DRIVE_COOL` | 28 / 18 °C | while zones call, the unit's setpoint is driven past any reachable return-air temperature so its own thermostat can never satisfy before the room sensor does (a relative target+2 bias proved insufficient: return air runs ~2.5 ° above the room, and the unit went quiet at setTemp 22 with the room at 19.6) |
| `SET_PARK_HEAT` / `SET_PARK_COOL` | 16 / 32 °C | when no zone calls, the setpoint is parked where the unit stops delivering — this idles even a unit the autopilot doesn't own the power for |
| `MIN_RUN_S` | 600 s | compressors hate short cycles |
| `MIN_OFF_S` | 300 s | ditto, on the restart side |
| `STALE_S` | 600 s | a sensor quieter than this is not a control input |
| `OVERTEMP_HEAT` | 28 °C | absolute bound: never keep heating a room this warm, whatever the sensor says |
| `UNDERTEMP_COOL` | 14 °C | the same on the cooling side |
| `DAMPER_MIN` | 30 % | floor for an open auto zone, so airflow is never choked to nothing |

`AUTO_INTERVAL` (60 s) and `OVERRIDE_S` (3600 s) live in `main.py`.

### One tick

1. **Track the unit.** Note any on/off transition to maintain `last_on` / `last_off`.
   If the unit went off during a user power override, drop `owns_power` — the user
   took the system, so the autopilot no longer considers it its own to command.
2. **Evaluate each enabled zone.** In order, a zone is suspended if it has no
   sensor, a stale sensor, the unit is in a mode auto can't reason about (`vent`,
   `dry`), or the room has hit an absolute safety bound. Otherwise compute
   `error = target − room` (heat) or `room − target` (cool) and update the calling
   flag: above `+HYSTERESIS` start calling, below `−HYSTERESIS` stop, inside the band
   latch the previous state. Every state change is logged with the numbers that
   caused it.
3. **If every zone is suspended**, turn the unit off — but only if the autopilot
   turned it on, minimum run time has elapsed, and the user hasn't overridden power.
   If it can't (or won't) power off, it parks the setpoint instead, so a unit it
   doesn't own stops delivering on stale or safety-bounded sensors.
4. **Unit power.** Demand and the unit is off → turn on, respecting minimum off
   time. No demand, unit is on and `owns_power` → turn off, respecting minimum run
   time. The wait is logged, so "why is it not on yet" is answerable.
5. **Setpoint drive/park.** While auto runs, the unit's `setTemp` is not a user
   temperature — it is a binary actuator, decoupled from the room targets. Zones
   calling → drive it out of the way (28 in heat, 18 in cool); no demand while the
   unit runs → park it where the unit stops delivering (16 / 32). Changes made on
   the wall tablet or vendor app are overwritten within a tick; disabling auto
   hands the setpoint back to the room target.
6. **Dampers.** A calling zone opens: 100 % while more than 0.5 ° from target, 60 %
   inside that — a stepped profile, not a proportional taper, because a proportional
   band makes the last degree take hours while the hysteresis band already does the
   fine holding. A satisfied zone closes if another zone stays open, or falls back to
   `DAMPER_MIN` if it is the only one left open, which keeps the invariant satisfied
   without the autopilot ever having to know about it.
7. Return one batched change containing everything decided this tick, so the tablet
   takes one write, not five.

### Guard rails around the loop

- `_auto_loop` does nothing unless at least one zone has auto enabled, the tablet is
  currently reachable, and the sensor feed exists. It never queues: a decision made
  from a stale picture is worse than no decision.
- Every decision goes through `_validate_change()` like any user write. A rejected
  decision is logged as `blocked` with the reason.
- The autopilot's own writes deliberately do *not* call `_mark_overrides()` —
  otherwise it would silence itself after one action.
- Enabling auto on a zone clears the `power`, `setTemp` and `zone:<id>` overrides:
  flipping the toggle is explicit consent for the autopilot to act now.
- Disabling it clears that zone's calling and suspended state so it starts clean.
- The tick is wrapped in a catch-all: an unexpected exception is logged, not fatal.
  A control loop that dies quietly is worse than one that misses a tick.

Everything — decisions, applications, blocks, errors, config changes — is appended
to `auto_log` and readable at `GET /api/auto/log`. "Why did it turn on at 6:12" has
an answer.

### Validation

`python3 -m tests.sim_autopilot` runs the real `Autopilot` against a first-order
thermal model (1.8 °/h gain at full damper, 0.6 °/h ambient loss) for ten simulated
hours and fails on: not reaching target within four hours, spending more than 2 % of
held time outside ±0.6 °, or any on/off span shorter than the anti-short-cycle
limits. It is a simulation, not a unit test suite — it checks the control law's
emergent behaviour, which is the part that is hard to reason about by reading.

## The frontend

`frontend/` is an HTML file, a stylesheet, one script, a web manifest, icons and a
self-hosted variable font. No build step, no package manager, no runtime dependency;
the backend serves it as static files from the same origin, so there is no CORS
story and no separate deployment.

- **Rendering** is direct DOM manipulation from one `render()` function. Zone cards
  are created once and updated in place, so sliders keep focus and animation state.
- **Optimistic local state.** `state.local` is mutated immediately on interaction
  and re-rendered before the POST goes out; the server's returned payload replaces it
  when the response lands. Server-side intent overlay is what keeps that optimism
  honest.
- **Sync cues** come entirely from the server's `recentPaths`: any control with an
  unconfirmed write gets a pulsing dot (the dial pulses its handle core instead).
  Because the cue is server-driven, two phones looking at the app agree.
- **Polling** is 20 s, suppressed while the tab is hidden or the user is dragging
  something, forced on tab focus, and a single 4 s follow-up read is scheduled after
  a write so confirmation feels immediate.
- **The dial lock** exists because a 260 px drag surface in the middle of a scrolling
  page is a hazard: setpoint changes require tapping the padlock first, and it
  re-arms after 15 s idle. Power, mode, fan and zones stay one tap away.
- **Theming** is CSS custom properties with a dark default and a light set under
  `:root[data-th="l"]`, initialised from `prefers-color-scheme` and persisted in
  `localStorage`. The PWA manifest, `theme-color` meta and iOS status-bar style are
  kept in step.
- **Accessibility and motion**: switch roles and `aria-pressed`/`aria-checked` on the
  custom controls, focus-visible outlines, and a `prefers-reduced-motion` block that
  neutralises every transition and animation.

Only `SpaceGrotesk-Variable.woff2` is referenced by the stylesheet; the other font
files in `frontend/fonts/` are leftovers from earlier design iterations.

## Deployment pipeline

```
git push main ──▶ GitHub Actions ──▶ buildx (amd64 + arm64) ──▶ ghcr.io/<owner>/ezone
                                                                      │
                                                              docker compose pull
```

`.github/workflows/build.yml` builds on pushes to `main` and on `v*` tags, tagging
`latest` (default branch), a `sha-` tag, and a semver tag for releases. QEMU plus
Buildx produce a multi-arch manifest so the same tag runs on an x86 NUC or an ARM
box. Layer cache lives in GitHub Actions cache. **Pushes that only touch `docs/**` or
`*.md` do not rebuild the image** — documentation changes cost nothing.

The runtime image is `python:3.12-slim`, four Python dependencies (`fastapi`,
`uvicorn[standard]`, `httpx`, `aiomqtt`), the backend and the frontend. `DATA_DIR`
is `/data`, declared as a volume.

Companion services live in the Docker host's own compose project, not in this repo:
`eclipse-mosquitto` and `koenkk/zigbee2mqtt` with the USB coordinator passed
through. `MQTT_URL` defaults to `mqtt://mosquitto:1883` so a container recreated
beside them still finds the broker even if its environment is lost; point it at the
host IP if this app is deployed as its own stack. See
[HARDWARE.md](HARDWARE.md#zigbee-stack) for the Zigbee side.

## Persistence

Everything in `DATA_DIR` (`/data` in the container). Lose it and you lose history
and queued intent, nothing else.

| File | Contents |
|------|----------|
| `ezone.db` | `snapshots` and `auto_log` tables |
| `last_state.json` | last successful `getSystemData` plus its timestamp — cold-start for the twin |
| `pending.json` | the merged undelivered change and when it was queued |
| `auto.json` | master autopilot `{enabled, target}` |
| `filter.json` | `{cleanedAt}` |

## Known gaps

- **Single aircon.** `ac1` is hard-coded throughout. A multi-unit Advantage Air
  system would need a real loop.
- **No authentication.** Matching the tablet, and appropriate only on a trusted LAN.
- **Scenes are read-only.** The app lists the tablet's schedules; editing them is a
  wall-panel job.
- **Phase 3 (HomeKit/Siri) from [PLAN-V2.md](PLAN-V2.md) is not implemented.** There
  is no HAP-python sidecar in this repo.
- **`vent` and `dry` modes suspend the autopilot** rather than being controlled — it
  reasons only about heat and cool.
