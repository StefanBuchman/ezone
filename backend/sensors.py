"""MQTT sensor feed: Zigbee room sensors mapped onto e-zone zones.

Mapping is by naming convention: a Zigbee2MQTT device with friendly name
``climate-<zone name, lowercased, spaces to dashes>`` feeds that zone
(zone "Upstairs" reads from ``climate-upstairs``). The SENSOR_MAP env var
overrides per zone: ``SENSOR_MAP=z01=lounge-sensor,z02=climate-upstairs``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import urllib.parse

import aiomqtt

log = logging.getLogger("uvicorn.error")

RECONNECT_SECONDS = 10
STALE_SECONDS = 600  # readings older than this are flagged stale


def zone_sensor_name(zone_name: str) -> str:
    return "climate-" + zone_name.strip().lower().replace(" ", "-")


class SensorFeed:
    def __init__(self, mqtt_url: str, overrides: dict[str, str] | None = None):
        parsed = urllib.parse.urlparse(mqtt_url)
        self.host = parsed.hostname or "localhost"
        self.port = parsed.port or 1883
        self.overrides = overrides or {}
        self.readings: dict[str, dict] = {}  # friendly name -> latest reading
        self.connected = False

    def reading_for_zone(self, zone_id: str, zone_name: str) -> dict | None:
        name = self.overrides.get(zone_id) or zone_sensor_name(zone_name)
        reading = self.readings.get(name)
        if reading is None:
            return None
        age = round(time.time() - reading["ts"], 1)
        return {
            "sensor": name,
            "temperature": reading.get("temperature"),
            "humidity": reading.get("humidity"),
            "battery": reading.get("battery"),
            "linkquality": reading.get("linkquality"),
            "ageSeconds": age,
            "stale": age > STALE_SECONDS,
        }

    async def run(self) -> None:
        while True:
            try:
                async with aiomqtt.Client(hostname=self.host, port=self.port) as client:
                    await client.subscribe("zigbee2mqtt/+")
                    self.connected = True
                    log.info("sensor feed connected to mqtt://%s:%s", self.host, self.port)
                    async for message in client.messages:
                        self._ingest(message)
            except aiomqtt.MqttError as exc:
                self.connected = False
                log.warning("mqtt connection lost (%s); retrying in %ss", exc, RECONNECT_SECONDS)
                await asyncio.sleep(RECONNECT_SECONDS)

    def _ingest(self, message) -> None:
        name = str(message.topic).split("/", 1)[-1]
        if name.startswith("bridge"):
            return
        try:
            payload = json.loads(message.payload)
        except (ValueError, TypeError):
            return
        if not isinstance(payload, dict) or "temperature" not in payload:
            return
        payload["ts"] = time.time()
        self.readings[name] = payload


class SimFeed(SensorFeed):
    """Mock-mode stand-in: simulated room sensors driven by a small thermal
    model of the mock aircon, so the auto loop can be exercised end to end
    without hardware. `accel` speeds the physics up relative to wall time."""

    def __init__(self, get_ac, accel: float = 6.0, start_temp: float = 19.0):
        super().__init__("mqtt://sim:1883")
        self.get_ac = get_ac
        self.accel = accel
        self.temps: dict[str, float] = {}
        self.start_temp = start_temp
        self.connected = True

    async def run(self) -> None:
        import asyncio

        step = 10.0
        while True:
            ac = self.get_ac()
            on = ac["info"]["state"] == "on"
            mode = ac["info"]["mode"]
            for zid, zone in ac["zones"].items():
                name = zone_sensor_name(zone["name"])
                temp = self.temps.get(zid, self.start_temp)
                dt_h = (step / 3600) * self.accel
                flowing = on and zone["state"] == "open"
                gain = 1.8 * (zone["value"] / 100) * dt_h if flowing else 0.0
                if mode == "cool":
                    gain = -gain
                temp += gain - 0.6 * dt_h  # ambient loss pulls down
                temp = max(12.0, min(32.0, temp))
                self.temps[zid] = temp
                self.readings[name] = {
                    "temperature": round(temp, 2),
                    "humidity": 45.0,
                    "battery": 100,
                    "linkquality": 200,
                    "ts": time.time(),
                }
            await asyncio.sleep(step)
