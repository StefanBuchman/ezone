"""Fast-clock simulation of the autopilot against a simple thermal model.

Run: python3 -m tests.sim_autopilot
Asserts the definition-of-done from docs/PLAN-V2.md: the loop reaches and
holds the target within +/-0.6 degrees without ever short-cycling the unit.
"""

from __future__ import annotations

import sys

from backend.autopilot import (
    Autopilot,
    MIN_OFF_S,
    MIN_RUN_S,
    SET_DRIVE_HEAT,
    SET_PARK_HEAT,
)

TARGET = 21.5
START = 18.0
HOURS = 10
DT = 30  # simulated seconds per step

HEAT_RATE = 1.8   # deg/hour at 100% damper
LOSS_RATE = 0.6   # deg/hour ambient loss
# The unit's own thermostat cuts heat when RETURN AIR reaches setTemp, and
# return air runs warmer than the room sensor (live 2026-08-02: unit went
# quiet at setTemp 22 with the upstairs sensor still reading 19.6).
RETURN_OFFSET = 3.0


def run(verbose: bool = False) -> dict:
    pilot = Autopilot()
    ac = {
        "info": {"state": "off", "mode": "heat", "setTemp": 24.0, "fan": "medium"},
        "zones": {
            "z01": {"name": "Downstairs", "state": "close", "value": 100},
            "z02": {"name": "Upstairs", "state": "close", "value": 100},
        },
    }
    cfg = {"z02": {"enabled": True, "target": TARGET}}
    temp = START
    now = 0.0

    on_spans: list[float] = []
    off_spans: list[float] = []
    span_start = 0.0
    reached_at = None
    excursions = 0
    samples_after_reach = 0

    steps = int(HOURS * 3600 / DT)
    for _ in range(steps):
        now += DT
        # thermal model
        z = ac["zones"]["z02"]
        heating = (
            ac["info"]["state"] == "on"
            and z["state"] == "open"
            and temp + RETURN_OFFSET < ac["info"]["setTemp"]
        )
        gain = HEAT_RATE * (z["value"] / 100) if heating else 0.0
        temp += (gain - LOSS_RATE) * (DT / 3600)
        temp = max(10.0, temp)

        readings = {"z02": {"temperature": round(temp, 2), "ageSeconds": 5, "stale": False}}
        was_on = ac["info"]["state"] == "on"
        change, logs = pilot.tick(cfg, ac, readings, set(), now)
        if verbose:
            for line in logs:
                print(f"[{now/3600:5.2f}h {temp:5.2f}°] {line}")
        if change:
            for k, v in change.get("info", {}).items():
                ac["info"][k] = v
            for zid, patch in change.get("zones", {}).items():
                ac["zones"][zid].update(patch)
        is_on = ac["info"]["state"] == "on"
        if is_on != was_on:
            span = now - span_start
            (off_spans if is_on else on_spans).append(span)
            span_start = now

        if reached_at is None and temp >= TARGET - 0.1:
            reached_at = now
        if reached_at is not None and now > reached_at:
            samples_after_reach += 1
            if abs(temp - TARGET) > 0.6:
                excursions += 1

    return {
        "reached_h": None if reached_at is None else round(reached_at / 3600, 2),
        "excursion_pct": round(100 * excursions / max(samples_after_reach, 1), 2),
        # first span of each list is the pre-start idle period; ignore it for off
        "min_on_s": min(on_spans[1:] or on_spans, default=None),
        "min_off_s": min(off_spans[1:], default=None),
        "cycles": len(off_spans),
        "final_temp": round(temp, 2),
    }


def _ac(set_temp=24.0):
    return {
        "info": {"state": "on", "mode": "heat", "setTemp": set_temp, "fan": "medium"},
        "zones": {
            "z01": {"name": "Downstairs", "state": "close", "value": 100},
            "z02": {"name": "Upstairs", "state": "open", "value": 100},
        },
    }


def behavior_checks() -> list[str]:
    """Point checks of the setpoint drive/park actuator."""
    fails = []
    cfg = {"z02": {"enabled": True, "target": 20.0}}

    def fresh(t):
        return {"z02": {"temperature": t, "ageSeconds": 5, "stale": False}}

    # calling: setpoint driven out of the way, stomping wall-app fiddling
    change, _ = Autopilot().tick(cfg, _ac(24.0), fresh(19.0), set(), 1000.0)
    if (change or {}).get("info", {}).get("setTemp") != SET_DRIVE_HEAT:
        fails.append(f"calling should drive setTemp to {SET_DRIVE_HEAT}: {change}")

    # satisfied while a unit auto did NOT start keeps running: park the
    # setpoint so it stops delivering, but never power it off
    change, _ = Autopilot().tick(cfg, _ac(SET_DRIVE_HEAT), fresh(20.6), set(), 1000.0)
    info = (change or {}).get("info", {})
    if info.get("setTemp") != SET_PARK_HEAT:
        fails.append(f"satisfied should park setTemp at {SET_PARK_HEAT}: {change}")
    if info.get("state") == "off":
        fails.append(f"must not power off a unit auto did not start: {change}")

    # a manual setTemp override through the app is respected
    change, _ = Autopilot().tick(cfg, _ac(24.0), fresh(19.0), {"setTemp"}, 1000.0)
    if "setTemp" in (change or {}).get("info", {}):
        fails.append(f"setTemp override ignored: {change}")

    # every zone suspended (stale sensor) on an unowned running unit: park
    stale = {"z02": {"temperature": 20.0, "ageSeconds": 5, "stale": True}}
    change, _ = Autopilot().tick(cfg, _ac(SET_DRIVE_HEAT), stale, set(), 1000.0)
    if (change or {}).get("info", {}).get("setTemp") != SET_PARK_HEAT:
        fails.append(f"suspended zones should park an unowned unit: {change}")

    return fails


if __name__ == "__main__":
    m = run(verbose="-v" in sys.argv)
    print("metrics:", m)
    failures = behavior_checks()
    if m["reached_h"] is None or m["reached_h"] > 4:
        failures.append(f"did not reach target in time ({m['reached_h']}h)")
    if m["excursion_pct"] > 2:
        failures.append(f"held band violated {m['excursion_pct']}% of the time")
    if m["min_on_s"] is not None and m["min_on_s"] < MIN_RUN_S - DT:
        failures.append(f"short-cycle: on-span {m['min_on_s']}s < {MIN_RUN_S}s")
    if m["min_off_s"] is not None and m["min_off_s"] < MIN_OFF_S - DT:
        failures.append(f"short-cycle: off-span {m['min_off_s']}s < {MIN_OFF_S}s")
    if failures:
        print("FAIL:", "; ".join(failures))
        sys.exit(1)
    print("PASS: reaches and holds target without short-cycling")
