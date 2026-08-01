"""Point checks for activity-event mapping and wall-change attribution.

Run: python3 -m tests.test_activity
"""

from __future__ import annotations

import sys

from backend.activity import diff_external, events_from_change
from backend.autopilot import SET_DRIVE_HEAT, SET_PARK_HEAT

NAMES = {"z01": "Downstairs", "z02": "Upstairs"}


def _ac(state="on", mode="heat", set_temp=22.0, fan="medium", cd=0, zones=None):
    return {
        "info": {"state": state, "mode": mode, "setTemp": set_temp, "fan": fan,
                 "countDownToOff": cd},
        "zones": zones or {
            "z01": {"name": "Downstairs", "state": "close", "value": 100},
            "z02": {"name": "Upstairs", "state": "open", "value": 60},
        },
    }


fails: list[str] = []


def check(name: str, cond: bool, got=None):
    if not cond:
        fails.append(f"{name}: {got!r}")


# ---- events_from_change ----
ev = events_from_change({"info": {"state": "on", "setTemp": 22}}, NAMES)
check("manual power+set", [k for k, _ in ev] == ["power", "setTemp"], ev)

ev = events_from_change({"info": {"setTemp": SET_DRIVE_HEAT}}, NAMES, auto=True)
check("auto drive", ev == [("drive", {"value": SET_DRIVE_HEAT})], ev)

ev = events_from_change({"info": {"setTemp": SET_PARK_HEAT}}, NAMES, auto=True)
check("auto park", ev == [("park", {"value": SET_PARK_HEAT})], ev)

ev = events_from_change({"info": {"setTemp": 22}}, NAMES, auto=False)
check("manual 22 is setTemp even near park range", ev[0][0] == "setTemp", ev)

ev = events_from_change({"zones": {"z02": {"state": "open", "value": 80}}}, NAMES)
check("zone event named", ev == [("zone", {"zid": "z02", "name": "Upstairs", "state": "open", "value": 80})], ev)

# ---- diff_external ----
# wall setTemp change: no intent explains it
ev = diff_external(_ac(set_temp=22.0), _ac(set_temp=24.0), set())
check("wall setTemp", ev == [("setTemp", {"value": 24.0}, "wall")], ev)

# our own write confirming is explained, not blamed on the wall
ev = diff_external(_ac(set_temp=22.0), _ac(set_temp=24.0), {(("info", "setTemp"), 24.0)})
check("explained setTemp silent", ev == [], ev)

# int/float mismatch between intent and tablet echo still explains
ev = diff_external(_ac(set_temp=22.0), _ac(set_temp=24), {(("info", "setTemp"), 24.0)})
check("int echo explained", ev == [], ev)

# countdown ticking down naturally is not activity
ev = diff_external(_ac(cd=25), _ac(cd=24), set())
check("countdown tick silent", ev == [], ev)

# countdown set at the wall
ev = diff_external(_ac(cd=0), _ac(cd=60), set())
check("wall timer set", ev == [("timer", {"minutes": 60}, "wall")], ev)

# countdown we set ourselves is explained
ev = diff_external(_ac(cd=0), _ac(cd=60), {(("info", "countDownToOff"), 60.0)})
check("our timer silent", ev == [], ev)

# timer expiry: unit turns itself off — narrated as the timer, not a person
ev = diff_external(_ac(state="on", cd=1), _ac(state="off", cd=0), set())
check("timer expiry", ev == [("timerDone", {"minutes": 1}, "system")], ev)

# wall power-off with no timer involved
ev = diff_external(_ac(state="on"), _ac(state="off"), set())
check("wall power off", ev == [("power", {"state": "off"}, "wall")], ev)

# wall cancel of a long countdown logs a cleared timer, not an expiry
ev = diff_external(_ac(cd=45), _ac(cd=0), set())
check("wall timer cleared", ev == [("timer", {"minutes": 0}, "wall")], ev)

# zone toggled at the wall
prev = _ac()
new = _ac(zones={
    "z01": {"name": "Downstairs", "state": "open", "value": 100},
    "z02": {"name": "Upstairs", "state": "open", "value": 60},
})
ev = diff_external(prev, new, set())
check("wall zone open", ev == [("zone", {"zid": "z01", "name": "Downstairs", "state": "open"}, "wall")], ev)

# auto's own damper write is explained via its recent intent
new = _ac(zones={
    "z01": {"name": "Downstairs", "state": "close", "value": 100},
    "z02": {"name": "Upstairs", "state": "open", "value": 100},
})
ev = diff_external(prev, new, {(("zones", "z02", "value"), 100.0)})
check("explained damper silent", ev == [], ev)

# mode changed on the wall
ev = diff_external(_ac(mode="heat"), _ac(mode="cool"), set())
check("wall mode", ev == [("mode", {"value": "cool"}, "wall")], ev)

# no prev state (first poll): nothing to say
ev = diff_external({}, _ac(), set())
check("first poll silent", ev == [], ev)


if __name__ == "__main__":
    if fails:
        print("FAIL:")
        for f in fails:
            print(" ", f)
        sys.exit(1)
    print("PASS: activity mapping and attribution")
