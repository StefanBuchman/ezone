"""Fast-clock simulation of the autopilot against a simple thermal model.

Run: python3 -m tests.sim_autopilot
Asserts the definition-of-done from docs/PLAN-V2.md: the loop reaches and
holds the target within +/-0.6 degrees without ever short-cycling the unit.
"""

from __future__ import annotations

import sys

from backend.autopilot import Autopilot, MIN_OFF_S, MIN_RUN_S

TARGET = 21.5
START = 18.0
HOURS = 10
DT = 30  # simulated seconds per step

HEAT_RATE = 1.8   # deg/hour at 100% damper
LOSS_RATE = 0.6   # deg/hour ambient loss


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
        heating = ac["info"]["state"] == "on" and z["state"] == "open"
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


if __name__ == "__main__":
    m = run(verbose="-v" in sys.argv)
    print("metrics:", m)
    failures = []
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
