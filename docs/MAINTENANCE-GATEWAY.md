# Maintenance gateway (passive hardware-diagnostic collector)

A sidecar that receives the Advantage Air CAN broadcast stream captured by the
Passive Tap APK on the wall tablet, decodes what it can, and journals
everything to disk. It is **receive-only**: it accepts capture records and
serves read-only statistics. There is no path in it that writes to the
controller, opens a serial/USB device, transmits on CAN, or changes climate
state — that surface belongs to the main app's guarded `/api/aircon`, and
nothing here touches it.

The implementation is vendored unchanged from the `ezone-codex` prototype
(`maintenance-gateway/`), so captures recorded by either stack stay
interchangeable.

## Shape

| | |
|---|---|
| Image | `ghcr.io/stefanbuchman/ezone-maintenance-gateway:latest` (built by CI, multi-arch) |
| Internal port | `8787` (fixed; the app reaches it at `http://maintenance-gateway:8787`) |
| Published port | `${EZONE_MAINTENANCE_PORT:-3081}` on the Docker host, trusted LAN only |
| Data | named volume `ezone-maintenance-data` mounted at `/data` |
| Tablet endpoint | `http://<docker-host-LAN-IP>:<published-port>/ingest` |

### Routes

| Route | Auth | Purpose |
|-------|------|---------|
| `POST /ingest` | **Bearer token required** | the only tablet-facing route; 401 on a bad token, 503 if no token is configured |
| `GET /health` | none | liveness: whether the token and decoder are configured, and the last ingest time |
| `GET /summary` | none | read-only capture statistics: bridges, devices, patterns, recent events |

`/health` and `/summary` are unauthenticated, so the published port must stay on
the trusted LAN — do not port-forward it and do not route it through Traefik
without the RFC1918 `ipallowlist` middleware. The app container reads `/summary`
over the internal compose network, which is never published.

## Configuration

The stack is designed to be git-pulled (Dockhand git-synced), so the secrets
never pass through compose interpolation and no `.env` needs to exist in the
checkout. The gateway loads its secrets from an **optional `env_file` on the
host**, checked in this order (later overrides earlier, both may be absent):

1. `./.env.maintenance` — beside the compose file (git-ignored); handy for
   local runs.
2. `/srv/ezone/maintenance-gateway.env` — fixed host path, outside the
   checkout, survives every git-synced redeploy. **Use this on the Docker
   host.**

Set it up once on the host (template: `maintenance-gateway.env.example`):

```bash
sudo mkdir -p /srv/ezone && sudo install -m 600 /dev/null /srv/ezone/maintenance-gateway.env && openssl rand -hex 32
```

- `EZONE_COLLECTOR_TOKEN` — shared secret for `/ingest`. The same value goes
  into the Passive Tap APK. **If no env file exists, the collector still starts
  and stays healthy but answers 503 on `/ingest`** — nothing is received, and
  `/health` reports `"collectorTokenConfigured": false`. That's the deploy
  check: a missing secret is visible, not fatal to the climate app.
- `EZONE_BROADCAST_KEY_BASE64` — optional decoder key. Blank is safe: captures
  are still journaled, just stored encrypted and undecoded.
- `EZONE_MAINTENANCE_PORT` — published LAN port, default `3081`
  (compose-interpolated; override in a plain `.env` or leave the default).

Rotating the token means editing the host env file, recreating the container
(`docker compose up -d`), and entering the new value in the APK; captures on
the volume are unaffected. The optional-`env_file` syntax needs Compose
v2.24+.

## Health and startup order

Both services carry health checks (`/health` on each), and `ezone` declares
`depends_on: maintenance-gateway: condition: service_healthy` so the collector
is up before the app boots. If you would rather the climate app never wait on a
diagnostics sidecar at deploy time, change that condition to `service_started` —
the app does not need the collector to control the air conditioner.

```bash
docker compose ps                      # health column for both services
docker compose logs -f maintenance-gateway
curl -s http://localhost:3081/health    # from the Docker host
```

## Validating without touching the tablet

Send a synthetic `collectorProbe` — schema-1, no CAN payload, no hardware
involved. It exercises auth, ingest, journaling and state persistence:

```bash
curl -s -X POST http://<docker-host-LAN-IP>:3081/ingest -H "Content-Type: application/json" -H "Authorization: Bearer $EZONE_COLLECTOR_TOKEN" -d '{"schema":1,"records":[{"schema":1,"kind":"collectorProbe","collectorId":"synthetic-probe","sequence":1,"appVersion":"probe"}]}'
```

A `202` with `{"ok":true,"accepted":1,"receipt":"…"}` means the path works end to
end. `probesReceived` on `/summary` increments, and the record lands in
`/data/capture-<date>.ndjson`.

## Backing up the diagnostic volume

`/data` holds `state.json` (rolling statistics) plus dated NDJSON journals:
`capture-*.ndjson` (every record as received), `frame-*.ndjson` (decoded
frames), and `decode-error-*.ndjson`. It survives restarts, image updates and
`docker compose down`; only `docker compose down -v` or an explicit
`docker volume rm` destroys it.

Back it up by streaming the volume through a throwaway container — no need to
stop the collector for a consistent-enough snapshot of append-only journals,
though stopping it guarantees one:

```bash
docker run --rm -v ezone-maintenance-data:/data:ro -v "$PWD":/backup alpine tar czf /backup/ezone-maintenance-$(date +%F).tar.gz -C /data .
```

Restore into a fresh volume:

```bash
docker run --rm -v ezone-maintenance-data:/data -v "$PWD":/backup alpine sh -c "rm -rf /data/* && tar xzf /backup/ezone-maintenance-YYYY-MM-DD.tar.gz -C /data"
```

Recreate the container afterwards so the collector reloads `state.json`. The
volume name is prefixed by the compose project on disk (e.g.
`ezone_ezone-maintenance-data`); `docker volume ls` shows the real name if you
are running the stack under a project name.

Journals grow with capture volume, so prune old dated files or fold the backup
into whatever covers the rest of the Docker host.

## Deploying

The stack is image-based, so a normal pull picks up both services:

```bash
docker compose pull && docker compose up -d
```

For a local build instead: `docker compose -f docker-compose.build.yml up -d --build`.
