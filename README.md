# e-zone

A self-hosted control app for an Advantage Air **e-zone** ducted air conditioner.
The system's wall tablet exposes a small, unauthenticated HTTP API on the LAN;
this app puts a usable phone UI in front of it, keeps a durable model of the
system's state so the UI still works when the tablet is asleep, records history,
and — where a room has a Zigbee temperature sensor — closes the control loop that
the e-zone hardware itself cannot close.

It was written for one specific installation (a two-zone e-zone with no constant
zone, a Sonoff Zigbee coordinator on the Docker host, deployed from GHCR). Nothing
here is a product. It is documented well enough that you can read the code, decide
whether your install is close enough, and adapt it. If you have a different zone
count, zone names, or a constant zone, expect to change configuration and to
re-check the safety logic in `backend/main.py` against your own system.

## Why it exists

The tablet's own app works, but the hardware it runs on is unreliable in specific,
reproducible ways: it sleeps its Wi-Fi radio and disappears from the network for
minutes at a time, its HTTP server is single-threaded and occasionally answers with
an empty body or truncated JSON, and it takes several seconds to reflect a write in
its own reported state. On top of that, e-zone measures temperature at the return
air grille only — it has no idea how warm any individual room actually is, so
"set 24°" means "run until the air coming back to the unit is 24°", not "make the
bedroom 24°".

Most of this codebase is a response to those four facts.

## Features

- **Mobile-first PWA** — arc dial with drag-to-set (behind a padlock, so scrolling
  the page doesn't change the temperature), mode pills, fan and timer chips,
  per-zone damper cards, dark/light themes. No build step, no framework, no CDN.
- **Digital twin** — the app always has an answer for "what is the system doing",
  even when the tablet is unreachable. Last-observed state is persisted to disk and
  survives restarts.
- **Store-and-forward writes** — changes made while the tablet is asleep are merged
  into one pending diff and delivered the moment it answers again. The UI says so
  rather than pretending the change landed.
- **Intent overlay** — an accepted write is shown immediately and held until the
  tablet's own state confirms it, so the UI never snaps back mid-apply. If the
  tablet never confirms, the UI reverts once and says why.
- **Safety guardrails** — writes are whitelisted and clamped, and the backend
  refuses any change that would leave the unit running with every damper closed.
- **Room sensors** — Zigbee2MQTT temperature/humidity sensors are mapped onto zones
  and shown on the zone cards with staleness and low-battery flags.
- **Autopilot** — one Auto button, one target: when engaged, the dial sets the
  temperature the house holds (0.5° steps) and a 60-second closed-loop controller
  drives every sensor-equipped zone toward it — hysteresis, anti-short-cycle
  timers, setpoint bias, damper strategy, fail-safes, and an audit log of every
  decision. Sensorless zones stay manual.
- **History and maintenance** — SQLite snapshots every poll, a 24-hour per-zone
  temperature chart, today's runtime by hour and by mode, tablet-reachability
  statistics, and a filter-hours counter you reset when you clean the filter.
- **Real outdoor temperature** from Open-Meteo, using the coordinates the tablet
  already knows (the tablet's own suburb feed can be hours stale).

## Quick start

Images are built by GitHub Actions for `linux/amd64` and `linux/arm64` and pushed
to `ghcr.io/stefanbuchman/ezone:latest` on every push to `main`.

```bash
# edit EZONE_HOST first
docker compose up -d
```

```yaml
# docker-compose.yml
services:
  ezone:
    image: ghcr.io/stefanbuchman/ezone:latest
    container_name: ezone
    restart: unless-stopped
    ports:
      - "8321:8000"
    environment:
      EZONE_HOST: 10.160.1.180   # your e-zone touchscreen
      EZONE_PORT: "2025"
      POLL_SECONDS: "30"
      MQTT_URL: mqtt://mosquitto:1883   # "" to disable the sensor feed
    volumes:
      - ezone-data:/data

volumes:
  ezone-data:
```

Open `http://<docker-host>:8321`. On iOS, Safari → Share → **Add to Home Screen**
gives you the standalone app. Updating is a pull and recreate.

To build locally instead of pulling:

```bash
docker compose -f docker-compose.build.yml up -d --build
```

To try it with no hardware at all, set `EZONE_MOCK: "1"` — the backend serves a
simulated tablet from `backend/mock_data.json` and accepts writes against it.

### Finding your tablet

The e-zone touchscreen serves its API on port 2025 with no authentication. Check
that it answers before deploying:

```bash
curl -s http://<tablet-ip>:2025/getSystemData | head -c 400
```

Give the tablet a static DHCP reservation. See [docs/HARDWARE.md](docs/HARDWARE.md)
for the protocol, the Zigbee setup, and the field notes that make both stay up.

## Development (no Docker)

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
EZONE_MOCK=1 .venv/bin/uvicorn backend.main:app --reload --port 8321
```

Autopilot has a fast-clock simulation with pass/fail assertions:

```bash
python3 -m tests.sim_autopilot        # add -v for the decision log
```

For an end-to-end feel of auto mode without hardware, add simulated rooms that
respond to the mock aircon:

```bash
EZONE_MOCK=1 MOCK_SENSOR=1 SIM_ACCEL=30 .venv/bin/uvicorn backend.main:app --port 8321
```

## Configuration

All configuration is environment variables, read once at startup in
`backend/main.py`.

| Variable       | Default              | Meaning |
|----------------|----------------------|---------|
| `EZONE_HOST`   | `10.160.1.180`       | IP or hostname of the e-zone touchscreen. |
| `EZONE_PORT`   | `2025`               | Tablet API port. |
| `EZONE_MOCK`   | `0`                  | `1` serves a simulated tablet from `backend/mock_data.json`; writes mutate the simulation. No network traffic to any tablet. |
| `POLL_SECONDS` | `30`                 | Interval of the background state poll. Also caps how much runtime a single history sample may account for (`4 ×` this value), so an outage can't be billed as run time. |
| `DATA_DIR`     | `./data` (`/data` in the image) | SQLite database and the JSON state files. Must be a persistent volume. |
| `MQTT_URL`     | `mqtt://mosquitto:1883` | Broker for the Zigbee2MQTT sensor feed. Set to `""` to disable sensors entirely. Only the host and port are used. |
| `SENSOR_MAP`   | *(empty)*            | Per-zone sensor override, `z01=lounge-sensor,z02=climate-upstairs`. Without it, zones map by naming convention: zone `Upstairs` reads Zigbee2MQTT device `climate-upstairs`. |
| `MOCK_SENSOR`  | *(unset)*            | `1` **and** `EZONE_MOCK=1` replaces the MQTT feed with a thermal simulation of the rooms. |
| `SIM_ACCEL`    | `6`                  | Time acceleration for that simulation. |

Behaviour that is deliberately *not* configurable lives as named constants near the
top of the relevant module — the intent TTL and override window in
`backend/main.py`, the whole control-law tuning in `backend/autopilot.py`. They are
documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

The container listens on port 8000; the compose files publish it as 8321.

## Architecture

```
      iPhone / browser
             │  HTTP :8321  (PWA + JSON API, same origin)
  ┌──────────▼───────────────────────────────────────┐
  │ ezone container                                  │
  │                                                  │
  │   FastAPI ── digital twin ──┬── SQLite history   │
  │      │                      └── /data JSON state │
  │      │ single-flight        │                    │
  │      │ retrying client      │ MQTT               │
  └──────┼──────────────────────┼────────────────────┘
         │ HTTP :2025           │
   e-zone tablet          mosquitto ◀── zigbee2mqtt
         │                                   ╎ Zigbee
   dampers + AC unit                   room sensors
```

Three loose parts, each with its own failure mode handled locally:

- `backend/ezone.py` — the only code that talks to the tablet. One request in
  flight at a time, three retries with backoff, every response structurally
  validated before it is believed.
- `backend/main.py` — the FastAPI app and the digital twin. State the app serves is
  last-observed tablet state, plus a layer of delivered-but-unconfirmed intent, plus
  a layer of undelivered queued intent. It also owns the poll loop, the SQLite
  history, outdoor temperature, filter runtime, and the manual-override bookkeeping.
- `backend/autopilot.py` — pure decision logic for closed-loop control. No I/O, an
  injected clock, so it can be simulated ten hours in a second by
  `tests/sim_autopilot.py`.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the layers interact and
why each one exists.

## Safety and guardrails

- **The last open zone cannot be closed while the unit runs.** This install has no
  constant zone, so closing every damper would send full airflow into a sealed duct
  system. Any write that would result in a running unit with zero open zones is
  rejected with HTTP 409, evaluated against the *effective* state (including queued
  and unconfirmed intent), not just the last poll. The UI also disables the toggle
  on the last open zone. **If your system has a constant zone this check is merely
  conservative; if it has none, do not remove it.**
- **Writes are whitelisted.** Only `state`, `mode`, `fan`, `setTemp`,
  `countDownToOn`, `countDownToOff` and per-zone `state` / `value` can ever reach
  the tablet. Values are enum-checked or clamped: temperature 16–32 °C, damper
  0–100 % snapped to 5 % steps, countdowns 0–720 minutes. Unknown fields are a 422,
  not a silent pass-through.
- **Manual always wins.** Any change you make through the app silences the autopilot
  on the scopes it touched (power, setpoint, or that zone) for one hour.
- **Autopilot only turns off what it turned on**, respects minimum run and minimum
  off times, and suspends a zone whose sensor has gone stale rather than guessing.
- **The API is unauthenticated, by design, like the tablet's.** Keep it on the LAN
  or behind a VPN. Do not port-forward this container or the tablet to the internet.
  Anyone who can reach port 8321 can run your air conditioner.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — digital twin, control loop, sensor
  pipeline, deployment pipeline, and the reasoning behind each.
- [docs/API.md](docs/API.md) — every endpoint this app serves, with examples.
- [docs/HARDWARE.md](docs/HARDWARE.md) — the tablet's protocol, the Zigbee stack,
  and the field notes.
- [docs/PLAN-V2.md](docs/PLAN-V2.md) — the original phased plan for closed-loop
  control. Historical: phases 0–2 are built, phase 3 (HomeKit/Siri) is not.

## Status

Phases 0–2 of the plan are implemented and running. Not implemented: the HomeKit
sidecar, any editing of the tablet's scenes/schedules (the app lists them read-only —
edit them on the wall panel), and multi-unit systems (`ac1` is assumed throughout).
