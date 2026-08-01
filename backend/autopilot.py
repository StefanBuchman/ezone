"""Closed-loop zone temperature control for the e-zone system.

Pure decision logic with an injected clock so it can be simulated at any
speed. Each tick reads the observed system state plus fresh sensor
readings and returns at most one batched change for the tablet, plus an
audit trail of why.

Principles (see docs/PLAN-V2.md):
- hysteresis band around the target so dampers and the compressor never chatter
- anti-short-cycle: minimum run and minimum off times for the unit
- setpoint bias: the unit's own return-air loop must never satisfy before
  the room sensor does
- manual always wins: user-touched scopes are off-limits for an hour
- fail safe: stale sensors suspend the zone; auto only powers off what
  auto powered on
"""

from __future__ import annotations

HYSTERESIS = 0.3          # degrees either side of target
SETPOINT_BIAS = 2         # push the unit's own setpoint past the room target
MIN_RUN_S = 600           # compressor minimum on time
MIN_OFF_S = 300           # compressor minimum off time
STALE_S = 600             # sensor readings older than this suspend the zone
OVERTEMP_HEAT = 28.0      # absolute bound: force off above this in heat
UNDERTEMP_COOL = 14.0     # absolute bound: force off below this in cool
DAMPER_MIN = 30           # never drive an open auto zone below this
TEMP_MIN, TEMP_MAX = 16, 32


def _damper_for(error: float) -> int:
    """Damper opening for a calling zone. Full airflow until close to
    target, then a gentler approach — a proportional taper just makes the
    last degree take hours (the hysteresis band does the fine holding)."""
    return 100 if abs(error) >= 0.5 else 60


class Autopilot:
    def __init__(self):
        self.calling: dict[str, bool] = {}
        self.suspended: dict[str, str | None] = {}
        self.owns_power = False
        self.last_on = 0.0
        self.last_off = 0.0
        self._prev_unit_on: bool | None = None

    # ---- public status for the API payload ----
    def zone_status(self, zid: str) -> dict:
        return {
            "calling": self.calling.get(zid, False),
            "suspended": self.suspended.get(zid),
        }

    def tick(self, cfg: dict, ac: dict, readings: dict, overrides: set, now: float):
        """cfg: {zid: {"enabled": bool, "target": float}}
        ac: the observed aircons.ac1 dict; readings: {zid: reading dict|None}
        overrides: active manual-override scope names.
        Returns (change dict or None, [log strings])."""
        logs: list[str] = []
        info = ac["info"]
        unit_on = info["state"] == "on"
        mode = info["mode"]

        # track unit transitions regardless of who caused them
        if self._prev_unit_on is not None and unit_on != self._prev_unit_on:
            if unit_on:
                self.last_on = now
            else:
                self.last_off = now
                if "power" in overrides:
                    self.owns_power = False  # user took it off; not ours anymore
        self._prev_unit_on = unit_on

        enabled = {z: c for z, c in cfg.items() if c.get("enabled")}
        if not enabled:
            self.owns_power = False
            return None, logs

        heat = mode == "heat"
        cool = mode == "cool"

        # ---- per-zone demand ----
        any_call = False
        for zid, c in enabled.items():
            target = c["target"]
            r = readings.get(zid)
            if r is None:
                self.suspended[zid] = "no sensor"
                self.calling[zid] = False
                continue
            if r.get("stale") or r.get("ageSeconds", 1e9) > STALE_S:
                if self.suspended.get(zid) != "sensor stale":
                    logs.append(f"{zid}: sensor stale, auto suspended")
                self.suspended[zid] = "sensor stale"
                self.calling[zid] = False
                continue
            if not (heat or cool):
                self.suspended[zid] = f"mode {mode}"
                self.calling[zid] = False
                continue
            temp = r["temperature"]
            # absolute safety bounds
            if (heat and temp >= OVERTEMP_HEAT) or (cool and temp <= UNDERTEMP_COOL):
                if self.suspended.get(zid) != "temp bound":
                    logs.append(f"{zid}: {temp}° hit safety bound, auto suspended")
                self.suspended[zid] = "temp bound"
                self.calling[zid] = False
                continue
            self.suspended[zid] = None
            error = (target - temp) if heat else (temp - target)
            was = self.calling.get(zid, False)
            if error > HYSTERESIS:
                self.calling[zid] = True
            elif error < -HYSTERESIS:
                self.calling[zid] = False
            # inside the band: latch previous state
            if self.calling[zid] != was:
                logs.append(
                    f"{zid}: {'calling' if self.calling[zid] else 'satisfied'} "
                    f"(room {temp}°, target {target}°)"
                )
            any_call = any_call or self.calling[zid]

        active = [z for z in enabled if self.suspended.get(z) is None]
        if not active:
            # every auto zone is suspended; shut down anything we own
            if self.owns_power and unit_on and "power" not in overrides:
                if now - self.last_on >= MIN_RUN_S:
                    self.owns_power = False
                    logs.append("all auto zones suspended: turning unit off")
                    return {"info": {"state": "off"}}, logs
            return None, logs

        change_info: dict = {}
        change_zones: dict = {}

        # ---- unit power ----
        if any_call and not unit_on and "power" not in overrides:
            if now - self.last_off >= MIN_OFF_S:
                change_info["state"] = "on"
                self.owns_power = True
                logs.append("demand present: turning unit on")
            else:
                logs.append("demand present but respecting minimum off time")
        elif not any_call and unit_on and self.owns_power and "power" not in overrides:
            if now - self.last_on >= MIN_RUN_S:
                change_info["state"] = "off"
                self.owns_power = False
                logs.append("all targets satisfied: turning unit off")
            else:
                logs.append("satisfied but respecting minimum run time")

        unit_will_run = change_info.get("state", "on" if unit_on else "off") == "on"

        # ---- unit setpoint bias ----
        if unit_will_run and any_call and "setTemp" not in overrides:
            targets = [enabled[z]["target"] for z in active if self.calling.get(z)]
            if targets:
                want = (max(targets) + SETPOINT_BIAS) if heat else (min(targets) - SETPOINT_BIAS)
                want = max(TEMP_MIN, min(TEMP_MAX, round(want)))
                if want != round(info["setTemp"]):
                    change_info["setTemp"] = want

        # ---- dampers ----
        zones = ac["zones"]
        for zid in active:
            if f"zone:{zid}" in overrides:
                continue
            zone = zones[zid]
            target = enabled[zid]["target"]
            r = readings[zid]
            if self.calling.get(zid):
                want_value = _damper_for((target - r["temperature"]) if heat else (r["temperature"] - target))
                patch = {}
                if zone["state"] != "open":
                    patch["state"] = "open"
                if abs(zone["value"] - want_value) >= 10 or patch:
                    patch["value"] = want_value
                if patch:
                    change_zones[zid] = patch
            elif unit_will_run:
                # satisfied while the unit keeps running for someone else:
                # choke this zone to minimum, or close it if another zone stays open
                others_open = any(
                    z["state"] == "open" for zz, z in zones.items()
                    if zz != zid and zz not in change_zones
                ) or any(p.get("state") == "open" for zz, p in change_zones.items() if zz != zid)
                if others_open and zone["state"] == "open":
                    change_zones[zid] = {"state": "close"}
                elif not others_open and zone["value"] != DAMPER_MIN:
                    change_zones[zid] = {"state": "open", "value": DAMPER_MIN}

        change = {}
        if change_info:
            change["info"] = change_info
        if change_zones:
            change["zones"] = change_zones
        return (change or None), logs
