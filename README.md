# e-zone

A mobile-first control app for the Advantage Air **e-zone** ducted climate system,
talking to the wall tablet's local HTTP API (port 2025). FastAPI backend +
dependency-free PWA frontend, shipped as a single Docker container.

## Run it

Images are built by GitHub Actions for amd64 + arm64 and published to
`ghcr.io/stefanbuchman/ezone:latest` on every push to `main`. On the Docker
host (or paste the compose into Dockhand as a stack):

```bash
docker compose up -d
```

Updating = pull the new image and recreate (Dockhand's auto-update /
re-pull does this natively). To build locally instead:

```bash
docker compose -f docker-compose.build.yml up -d --build
```

Then open `http://<docker-host>:8321`. On an iPhone, open it in Safari →
Share → **Add to Home Screen** for the full-screen app experience.

Configuration lives in [docker-compose.yml](docker-compose.yml):

| Env var        | Default        | Meaning                                    |
|----------------|----------------|--------------------------------------------|
| `EZONE_HOST`   | `10.160.1.180` | IP of the e-zone touchscreen               |
| `EZONE_PORT`   | `2025`         | API port                                   |
| `POLL_SECONDS` | `30`           | Background state poll + history interval   |
| `EZONE_MOCK`   | unset          | `1` = simulate the tablet (dev/demo mode)  |

History snapshots are stored in SQLite on the `ezone-data` volume —
the foundation for the V3 maintenance analytics.

## Development (no Docker)

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
EZONE_MOCK=1 .venv/bin/uvicorn backend.main:app --reload --port 8321
```

## Design notes

- **The tablet is treated as unreliable**: one request in flight at a time,
  retries with backoff, every response validated (it really does return empty
  bodies sometimes, and drops off Wi-Fi when its screen sleeps).
- **Digital twin**: the app always serves the last-known state (persisted to
  disk, survives restarts). Changes made while the tablet is asleep are queued
  as one merged pending diff and delivered automatically the moment it answers
  again (retry knock every 12s). The UI shows a `queued` badge meanwhile.
- **Run timers**: 30m/1h/1.5h/2h presets map to the tablet's native
  `countDownToOff` — tapping a preset from standby turns the system on for
  that long, mirroring how the household actually uses it.
- **Safety invariant**: this install has *no constant zone* configured, so the
  backend refuses any change that would leave the system on with every damper
  closed (HTTP 409). The UI disables the last open zone's switch too.
- **Writes are whitelisted**: only known fields with clamped values ever reach
  `setAircon` (temp 16–32, damper 0–100 in 5% steps, enum-checked mode/fan).
- The API is unauthenticated by design — keep the app LAN/VPN-only, never
  port-forward the tablet or this container to the internet.

## API (this app's, not the tablet's)

- `GET  /api/state` — cached system state (`?refresh=1` forces a live read)
- `POST /api/aircon` — `{"info": {...}, "zones": {"z01": {...}}}`, validated + guarded
- `GET  /api/history?hours=24` — logged snapshots
- `GET  /api/health` — app + tablet reachability
