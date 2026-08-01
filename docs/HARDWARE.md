# Hardware

The two pieces of hardware this app talks to: the Advantage Air e-zone wall tablet,
and a Zigbee sensor network. Neither is difficult, both have sharp edges that cost
an evening if you meet them cold.

- [The tablet API](#the-tablet-api)
- [Field reference](#field-reference)
- [Zigbee stack](#zigbee-stack)
- [Field notes](#field-notes)
- [Adapting this to your system](#adapting-this-to-your-system)

## The tablet API

The e-zone wall touchscreen is an Android device running Advantage Air's control
app. Alongside the UI it runs a small HTTP server on **port 2025**, on the LAN, with
**no authentication of any kind**. There is no vendor documentation; the shape below
is what this system serves, learned by observation. A capture with identifiers
scrubbed lives in [`backend/mock_data.json`](../backend/mock_data.json) — it is the
best available spec, and it is what mock mode replays.

### Check yours

```bash
curl -s http://<tablet-ip>:2025/getSystemData | head -c 400
```

If that returns a JSON document with an `aircons` key, everything in this repo
applies to you. If it times out, see the [field notes](#field-notes) — the most
likely explanation is that the tablet is asleep, not that the API is absent.

### `GET /getSystemData`

Returns the entire system document. Top-level keys on this system:

| Key | Contents |
|-----|----------|
| `aircons` | `{"ac1": {"info": {...}, "zones": {"z01": {...}, ...}}}` — everything the app cares about |
| `system` | install metadata: name, model, firmware revisions, coordinates, tablet IP |
| `myScenes` | the schedules configured on the wall panel (read-only here) |
| `myLights`, `myThings`, `myGarageRFControllers`, `myMonitors`, `mySensors`, `myAddOns`, `myView`, `snapshots` | other Advantage Air product features; empty on an aircon-only install |

The document is a few kilobytes. There is no partial-read endpoint; every poll
fetches all of it.

### `GET /setAircon?json=<url-encoded JSON>`

Writes a **partial** change object, URL-encoded into a query parameter. Only the
keys present are changed; everything else keeps its value.

```bash
# {"ac1":{"info":{"state":"on","mode":"heat","setTemp":22}}}
curl -sG http://<tablet-ip>:2025/setAircon \
  --data-urlencode 'json={"ac1":{"info":{"state":"on","mode":"heat","setTemp":22}}}'

# {"ac1":{"zones":{"z01":{"state":"open","value":60}}}}
curl -sG http://<tablet-ip>:2025/setAircon \
  --data-urlencode 'json={"ac1":{"zones":{"z01":{"state":"open","value":60}}}}'
```

The response is a small acknowledgement containing an `ack` key — that key's
presence is all the client checks, and mock mode replays it as
`{"ack": true, "request": "setAircon"}`.
`info` and `zones` can be combined in one call, and batching is worth doing — each
request is a round trip through a device that does not enjoy being talked to.

**The acknowledgement is not confirmation.** The tablet answers immediately and then
takes several seconds to reflect the change in `getSystemData`. This is the single
most important thing to know about writing to it, and the reason for the
[intent overlay](ARCHITECTURE.md#the-digital-twin).

### Protocol quirks

- **One request at a time.** Concurrent requests produce empty bodies and truncated
  JSON. `backend/ezone.py` serialises everything through one lock and validates that
  a response contains an expected key before believing it.
- **HTTP 200 means nothing on its own.** An empty body with a 200 status is a normal
  failure mode. Validate structurally.
- **Countdowns tick immediately.** Write `countDownToOff: 60` and the next read says
  59 — the value is minutes remaining, not the requested duration. Any code that
  waits for an exact echo will wait forever.
- **The Wi-Fi radio sleeps.** See the [field notes](#field-notes).
- **Temperature control is return-air only.** The unit's thermostat closes on the
  temperature of the air returning to the plant. `measuredTemp` is `0.0` for every
  zone unless the installer fitted Advantage Air's own zone temperature sensors.
  This is the whole reason for the Zigbee half of this project.

## Field reference

Fields this app reads or writes. Other fields exist; these are the ones with
verified meaning.

### `aircons.ac1.info`

| Field | Type | Notes |
|-------|------|-------|
| `state` | `"on"` \| `"off"` | writable |
| `mode` | `"heat"` \| `"cool"` \| `"vent"` \| `"dry"` | writable |
| `fan` | `"low"` \| `"medium"` \| `"high"` | writable. Some systems also expose an auto fan mode via `aaAutoFanModeEnabled`; unused here |
| `setTemp` | number | writable. Unit setpoint °C, whole degrees in practice (`24.0`) |
| `countDownToOff` | int minutes | writable. Minutes until auto-off, `0` = disabled, counts down live |
| `countDownToOn` | int minutes | writable. Same, for auto-on |
| `filterCleanStatus` | int | tablet's filter reminder flag. Installer-configured; frequently never enabled |
| `airconErrorCode` | string | `""` when healthy; surfaced as a header badge |
| `noOfZones` | int | zone count |
| `noOfConstants`, `constant1..3` | int | constant (always-open) zones. **`0` on this system — no constant zone** |
| `myZone` | int | the zone whose sensor drives the unit's thermostat, `0` = none |
| `unitType`, `cbFWRevMajor`, `cbFWRevMinor`, `uid` | — | identifiers, not used by the app |

### `aircons.ac1.zones.<zid>`

Zone ids are `z01`, `z02`, … in installation order.

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | as configured on the wall panel. **The sensor naming convention derives from this** |
| `number` | int | physical zone number |
| `state` | `"open"` \| `"close"` | writable |
| `value` | int | writable. Damper opening %, 5 % granularity |
| `setTemp` | number | per-zone setpoint; only meaningful with Advantage Air zone sensors |
| `measuredTemp` | number | `0.0` without a zone sensor. This app overwrites it with the Zigbee reading in its own API responses |
| `minDamper`, `maxDamper` | int | installer-configured damper limits |
| `error`, `rssi`, `motion`, `motionConfig`, `type`, `tempSensorClash` | — | not used by the app |

### `system`

| Field | Used for |
|-------|----------|
| `latitude`, `longitude` | passed to Open-Meteo for a real outdoor temperature |
| `suburbTemp`, `isValidSuburbTemp` | the tablet's own outdoor reading — used by the UI only as a fallback, and only when the tablet vouches for it; it can be hours stale |
| `name`, `tspIp`, `myAppRev` | shown in the app footer |
| `sysType`, `tspModel`, `aaServiceRev` | install identification |
| `postCode`, `mid`, `rid`, `deviceIds`, `deviceIdsV2`, `deviceNames` | **personal/identifying** — scrubbed in `mock_data.json`, and worth scrubbing in anything you publish. `deviceIdsV2` maps device ids to push tokens |

## Zigbee stack

Because e-zone cannot see room temperature, the closed loop needs its own sensors.
The stack is deliberately boring and entirely local:

```
SNZB-02 sensor ··Zigbee 2.4GHz··▶ USB coordinator ──▶ zigbee2mqtt ──▶ mosquitto ──▶ this app
```

None of it lives in this repo — mosquitto and zigbee2mqtt run as their own services
in the Docker host's compose project, and this app is just another MQTT subscriber.

### Coordinator

A Sonoff Zigbee 3.0 USB dongle. Which one you have decides the Z2M adapter setting:

| Dongle | Chip | Device node | Z2M `adapter` |
|--------|------|-------------|---------------|
| ZBDongle-P | TI CC2652P | `/dev/ttyUSB*` | `zstack` |
| ZBDongle-E | Silicon Labs EFR32MG21 | `/dev/ttyACM*` | `ember` |

Two things that are not optional:

- **Mount by stable path.** Pass `/dev/serial/by-id/usb-...` into the container, never
  `/dev/ttyACM0` — USB enumeration order changes across reboots and you will end up
  pointing Zigbee2MQTT at something else.
- **Use a short USB 2.0 extension cable** and keep the dongle away from USB 3 ports
  and enclosures. USB 3 radiates broadband noise right across 2.4 GHz and will halve
  your Zigbee range for no visible reason.

**Firmware.** The ZBDongle-E ships with firmware older than what Zigbee2MQTT's
`ember` driver expects, and the symptoms are miserable — the adapter starts and then
drops, or refuses to start at all. Flashing a current EmberZNet NCP build fixed it
here. Check the coordinator version Zigbee2MQTT logs at startup and compare it with
what your Z2M version wants before assuming your hardware is faulty; Z2M is explicit
in the log when the firmware is the problem.

### Broker and Zigbee2MQTT

Sketch of the companion services (they are not part of this repo's compose files):

```yaml
services:
  mosquitto:
    image: eclipse-mosquitto:2
    restart: unless-stopped
    volumes:
      - mosquitto-config:/mosquitto/config
      - mosquitto-data:/mosquitto/data
    # LAN-only. No ports published to the internet, ever.

  zigbee2mqtt:
    image: koenkk/zigbee2mqtt
    restart: unless-stopped
    depends_on: [mosquitto]
    devices:
      - /dev/serial/by-id/usb-...-if00:/dev/ttyACM0
    volumes:
      - z2m-data:/app/data
```

Relevant part of Zigbee2MQTT's `configuration.yaml`:

```yaml
mqtt:
  server: mqtt://mosquitto:1883
serial:
  port: /dev/ttyACM0
  adapter: ember          # zstack for a ZBDongle-P
```

Point this app at the same broker with `MQTT_URL`. If the app runs in a different
compose project from the broker, use the host IP
(`MQTT_URL: mqtt://10.160.1.251:1883`) rather than the service name.

### Sensors and naming

Sonoff SNZB-02 (or 02P/02D) temperature and humidity sensors, one per zone. Pair
them in Zigbee2MQTT's UI (permit join, then press and hold the sensor's button),
then **rename each to match its zone**:

```
zone "Downstairs"  →  friendly name "climate-downstairs"
zone "Upstairs"    →  friendly name "climate-upstairs"
```

The rule is `climate-` + the zone name lowercased with spaces replaced by dashes
(`backend/sensors.py:zone_sensor_name`). Get this right and there is nothing to
configure. If a device cannot be renamed, map it explicitly instead:

```
SENSOR_MAP=z01=lounge-sensor,z02=climate-upstairs
```

Verify what is actually arriving before blaming the app:

```bash
mosquitto_sub -h <broker> -t 'zigbee2mqtt/#' -v
```

The app subscribes to `zigbee2mqtt/+` and ingests any JSON object containing a
`temperature` key; `bridge*` topics are ignored, as is everything without a
temperature.

### Reporting configuration

The SNZB-02 reports on *change thresholds*, not on a fixed schedule. In a room that
drifts slowly, the default configuration can leave gaps of many minutes — long
enough for the app's 10-minute staleness rule to suspend autopilot on that zone.
Tune the reporting configuration (or `temperature_precision`) in Zigbee2MQTT rather
than assuming the defaults suit a control loop.

**These sensors are sleepy end devices.** They are radio-silent almost all the time,
so any operation that has to talk *to* them — binding, `configure_reporting`, the
"Configure" button in the Z2M UI — will time out unless the device happens to be
awake. Press the sensor's pairing button immediately before (and again during) the
operation to hold it awake. A configure step that "doesn't work" on these devices is
usually a sleeping device, not a failed binding.

## Field notes

Things that cost real time here, in rough order of how much.

**The tablet sleeps its Wi-Fi.** When the screen turns off, the Android device
suspends the radio and disappears from the network for minutes at a time. It is not
a crash, not a DHCP problem, and not something a retry loop can fix — this is why
the app has a store-and-forward queue and a persisted digital twin instead of a
spinner. Measure yours with `GET /api/health` → `tabletUptime24h`, which is computed
from real failed polls. Screen-timeout and battery-optimisation settings on the
tablet can improve it; the design assumes they won't.

**Android MAC randomization breaks the tablet's address.** If the tablet's Wi-Fi
network is set to use a "private"/randomized MAC address, it can present a different
MAC after a re-join. Your DHCP reservation no longer matches, the tablet lands on a
different lease, and the app's `EZONE_HOST` resolves to nothing while ARP entries
for the old address go stale — from the tablet's own screen everything looks
connected and fine. Set the Wi-Fi connection to use the device MAC, then give it a
static DHCP reservation.

**The filter reminder is probably not on.** `filterCleanStatus` is an
installer-configured feature, and on this system it never fired in three years of
operation. If you want to know when the filter needs cleaning, count runtime
yourself — which is what `/api/today`'s `filterRuntimeSeconds` does, from a mark you
set by tapping the filter line in the UI.

**No constant zone means airflow safety is your problem.** With `noOfConstants: 0`,
nothing prevents a system from running with every damper shut. The app refuses those
writes ([safety invariant](ARCHITECTURE.md#write-validation-and-the-safety-invariant));
if you adapt this code, check that field on your own system before touching that
logic.

**Return-air sensing makes the setpoint a lie.** Setting 24 ° on an e-zone means
"run until the return air reads 24 °", which is reached long before a cold room at
the end of a long duct run is comfortable. Measured on this install: the unit went
quiet at setTemp 22 while the room sensor still read 19.6 — a ~2.5 ° offset, which
defeated the original "target + 2" bias. That is why the autopilot now decouples
the setpoint entirely and uses it as a binary actuator: driven to 28 ° (heat) while
zones call, parked at 16 ° when they're satisfied. If your install has a `myZone`
configured, its own thermostat behaves differently and this may need rethinking.

**USB 3 kills Zigbee.** Repeating it because it is invisible when it happens: a
dongle plugged directly into a USB 3 port, or sitting next to an external SSD, gets
a fraction of the range it should. A cheap USB 2.0 extension cable is the fix.

## Adapting this to your system

Roughly in order of how likely you are to need it:

1. **`EZONE_HOST`** — your tablet's IP, with a DHCP reservation.
2. **Zone ids and names** — the app reads them from the tablet, so nothing is
   hard-coded, but your sensor friendly names must follow from your zone names (or
   use `SENSOR_MAP`).
3. **Check `noOfConstants` and `myZone`** in your own `getSystemData` before relying
   on, or relaxing, the last-open-zone invariant.
4. **`MQTT_URL`** — or `""` if you have no sensors, in which case the app is a
   well-behaved remote control and the autopilot never engages.
5. **Autopilot constants** in `backend/autopilot.py` — hysteresis, drive/park
   setpoints, cycle timers and damper strategy are tuned for a two-zone ducted
   system in a temperate climate. Change them, then run `python3 -m tests.sim_autopilot` to see whether the
   loop still reaches and holds target without short-cycling.
6. **Multiple aircons** — `ac1` is assumed throughout `backend/`. A multi-unit system
   needs real work, not configuration.
