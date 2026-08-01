# V2 — Closed-loop climate control

**Decisions locked (2026-08-01):** No Home Assistant — fully self-owned stack.
Sonoff Zigbee 3.0 dongle moves from the retired Raspberry Pi to the docker
host. Start with the one Sonoff SNZB-02 owned today (Downstairs); Upstairs
joins when its sensor arrives. Moes/Tuya wall thermostat on the future todo
as a physical control point. Siri via a HomeKit bridge built into this repo
(HAP-python) — no cloud, no HA, no Alexa.

## Architecture

```
SNZB-02 (Downstairs) ··Zigbee·· Sonoff dongle (USB on docker host)
                                     │
                                Zigbee2MQTT ──▶ Mosquitto (MQTT broker)
                                                    │ zigbee2mqtt/#
                        ┌───────────────────────────┤
                   ezone app ◀── REST ── ezone-homekit (HAP-python, host net)
              (control loop · UI · history)              │ mDNS / HAP
                        │ HTTP :2025                iPhone · Siri · Home app
                   e-zone tablet
                        │
                   dampers + AC unit
```

All services live in the host's docker-compose; app images keep flowing
through the GitHub → GHCR → Dockhand pipeline.

## Phase 0 — Zigbee infrastructure (no AC behaviour changes)

1. Physically move the dongle to the docker host. Use a short USB **2.0**
   extension cable if possible — USB3 ports radiate 2.4 GHz interference
   that cripples Zigbee range.
2. Identify the device: `ls -l /dev/serial/by-id/` (ZBDongle-P → `ttyUSB*`,
   adapter `zstack`; ZBDongle-E → `ttyACM*`, adapter `ember`). Always mount
   by `/dev/serial/by-id/...` so reboots can't renumber it.
3. Add `mosquitto` (eclipse-mosquitto:2) and `zigbee2mqtt`
   (koenkk/zigbee2mqtt) services. MQTT stays LAN-only, user/pass auth.
   Z2M frontend behind Traefik with the same `ezone-lanonly` allowlist.
4. This is a **fresh Zigbee network** — anything paired to the Pi's old ZHA
   network re-pairs here.
5. Pair the SNZB-02, friendly name `climate-downstairs`; tune Z2M reporting
   so temperature updates land at least every few minutes.

**Done when:** MQTT publishes downstairs temperature/humidity/battery and
survives a host reboot.

## Phase 1 — Sensors into the app (read-only)

- App subscribes via MQTT (aiomqtt); config maps friendly names → zones
  (`z01: climate-downstairs`), stored in `/data`.
- Zone cards show measured temperature + humidity, sensor freshness and
  battery. History records measured temps alongside the existing snapshots.

**Done when:** the UI shows live room temperature and the history API
returns a temperature series.

## Phase 2 — Closed-loop AUTO mode (the point of all this)

Per-zone **target temperature + Auto toggle**, only offered on sensor-mapped
zones. Control loop every 60s:

- **Hysteresis** ±0.3 °C around target — no damper/compressor chatter.
- **Anti-short-cycle:** minimum 10 min run, 5 min off for the unit.
- **Setpoint bias:** unit setTemp driven to room-target +2 °C in heat
  (−2 in cool) so the return-air loop never satisfies before the room does.
- **Damper strategy:** calling zones open (proportional 30–100% in 5%
  steps); satisfied zones taper/close — the existing last-open-zone
  invariant is never violated.
- **Mixed mode:** Upstairs stays fully manual until it has a sensor; auto
  logic only touches its own zone damper and the shared unit.
- **Manual always wins:** any manual change (app or wall panel) sets an
  override window (60 min) during which auto stands down for that scope.
- **Fail-safes:** sensor stale >10 min → auto suspends with a visible
  badge and the system reverts to plain e-zone behaviour; absolute temp
  bounds force-off with an alert.
- Every auto decision is logged — "why did it turn on at 6:12" is always
  answerable.

**Done when:** in mock (simulated sensor feed) the loop reaches and holds
target ±0.5 °C without short-cycling, and Downstairs does the same on the
real system through a full morning warm-up.

## Phase 3 — HomeKit / Siri

- New sidecar `ezone-homekit` (HAP-python, `network_mode: host` for mDNS)
  exposing one Thermostat accessory per mapped zone: current temp, target,
  mode. Pairs with the Home app via setup code.
- "Hey Siri, set downstairs to 22" → sets the zone target (and engages
  auto when the sensor is healthy).

**Done when:** the Home app shows a live Downstairs thermostat and Siri can
read and set it.

## Phase 4 — Expansion (todo list)

- [ ] Buy 1× Sonoff SNZB-02P/02D for Upstairs (~$20) → full-house closed loop.
- [ ] Buy a Moes/Tuya Zigbee wall thermostat — used as a physical target
      dial + display mapped to a zone target over MQTT (its relay unused).
- [ ] Remove the stale `ha.buchman.org` service from the host compose
      (HA/Pi retired).
- [ ] Later candidates: per-room sensors (room-weighted control), window
      sensors, occupancy auto-off via UniFi.

## Risks & notes

- Old coordinator firmware on the dongle may need a one-time flash — Z2M
  reports this clearly at startup.
- SNZB-02 reports on temperature *change* thresholds; if a room drifts very
  slowly, tune `temperature_precision`/reporting in Z2M rather than trust
  defaults.
- Mosquitto is LAN-only and never exposed through Traefik.
