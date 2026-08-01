"""Unified activity log: every change to the system, whoever made it.

Sources:
- "you"    — writes made through this app
- "auto"   — the autopilot's decisions and writes
- "wall"   — changes observed on the tablet that no app write explains
             (wall panel, vendor app, scenes, AA cloud)
- "system" — the app's own plumbing (queued deliveries, tablet offline)

Events are stored structured (kind + JSON detail) and composed into
sentences client-side, so the feed can render them richly. The wall
attribution works by diffing consecutive polls: any watched field that
changed without a matching in-flight intent (recent/pending write from
this app) was changed by someone else.
"""

from __future__ import annotations

import json
import time

from .autopilot import SET_DRIVE_HEAT, SET_PARK_HEAT, SET_DRIVE_COOL, SET_PARK_COOL

# info fields worth narrating; measuredTemp/rssi/etc. are telemetry, not acts
WATCHED_INFO = ("state", "mode", "setTemp", "fan")
DRIVE_PARK = {SET_DRIVE_HEAT, SET_PARK_HEAT, SET_DRIVE_COOL, SET_PARK_COOL}


def record(conn, lock, source: str, events: list[tuple[str, dict]]) -> None:
    """Append events to the activity table. Call from a worker thread."""
    if not events:
        return
    now = time.time()
    with lock:
        conn.executemany(
            "INSERT INTO activity VALUES (?,?,?,?)",
            [(now, source, kind, json.dumps(detail)) for kind, detail in events],
        )
        conn.commit()


def _norm(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v


def events_from_change(ac_change: dict, names: dict, auto: bool = False) -> list:
    """Map a validated write payload onto activity events. `auto` marks the
    autopilot as author, which turns setTemp writes into drive/park events
    (the decoupled actuator) rather than a person choosing a temperature."""
    out: list[tuple[str, dict]] = []
    info = ac_change.get("info", {})
    if "state" in info:
        out.append(("power", {"state": info["state"]}))
    if "setTemp" in info:
        v = info["setTemp"]
        if auto and v in DRIVE_PARK:
            kind = "drive" if v in (SET_DRIVE_HEAT, SET_DRIVE_COOL) else "park"
            out.append((kind, {"value": v}))
        else:
            out.append(("setTemp", {"value": v}))
    if "mode" in info:
        out.append(("mode", {"value": info["mode"]}))
    if "fan" in info:
        out.append(("fan", {"value": info["fan"]}))
    if "countDownToOff" in info:
        out.append(("timer", {"minutes": info["countDownToOff"]}))
    if "countDownToOn" in info:
        out.append(("timerOn", {"minutes": info["countDownToOn"]}))
    for zid, z in ac_change.get("zones", {}).items():
        d: dict = {"zid": zid, "name": names.get(zid, zid)}
        if "state" in z:
            d["state"] = z["state"]
        if "value" in z:
            d["value"] = z["value"]
        out.append(("zone", d))
    return out


def diff_external(prev_ac: dict, new_ac: dict, explained: set) -> list:
    """Events for observed changes this app didn't make.

    `explained` is {(path tuple, normalized value)} for every in-flight
    intent (recent + pending) at diff time — diff BEFORE pruning intents,
    or our own confirmed writes get blamed on the wall.
    Returns (kind, detail, source) tuples: mostly "wall", but a countdown
    running out is narrated as the timer acting, not a person.
    """
    out: list[tuple[str, dict, str]] = []
    if not prev_ac or not new_ac:
        return out
    pi, ni = prev_ac.get("info", {}), new_ac.get("info", {})

    # a countdown reaching zero turns the unit off by itself; near-zero
    # before the flip means natural expiry (a wall cancel clears from high)
    prev_cd, new_cd = pi.get("countDownToOff", 0) or 0, ni.get("countDownToOff", 0) or 0
    timer_fired = (
        prev_cd and not new_cd and prev_cd <= 2
        and pi.get("state") == "on" and ni.get("state") == "off"
    )
    if timer_fired:
        out.append(("timerDone", {"minutes": prev_cd}, "system"))

    for key in WATCHED_INFO:
        pv, nv = _norm(pi.get(key)), _norm(ni.get(key))
        if pv == nv or nv is None:
            continue
        if (("info", key), nv) in explained:
            continue
        if key == "state":
            if timer_fired:
                continue
            out.append(("power", {"state": nv}, "wall"))
        elif key == "setTemp":
            out.append(("setTemp", {"value": nv}, "wall"))
        else:
            out.append((key, {"value": nv}, "wall"))

    # countdown set or cleared at the wall (ignore the natural tick-down)
    if new_cd > prev_cd and (("info", "countDownToOff"), _norm(new_cd)) not in explained:
        out.append(("timer", {"minutes": new_cd}, "wall"))
    elif prev_cd > 2 and not new_cd and (("info", "countDownToOff"), 0.0) not in explained:
        out.append(("timer", {"minutes": 0}, "wall"))

    pz, nz = prev_ac.get("zones", {}), new_ac.get("zones", {})
    for zid, z in nz.items():
        p = pz.get(zid, {})
        d: dict = {"zid": zid, "name": z.get("name", zid)}
        changed = False
        if p.get("state") != z.get("state") and (("zones", zid, "state"), z.get("state")) not in explained:
            d["state"] = z.get("state")
            changed = True
        if _norm(p.get("value")) != _norm(z.get("value")) and (("zones", zid, "value"), _norm(z.get("value"))) not in explained:
            d["value"] = z.get("value")
            changed = True
        if changed:
            out.append(("zone", d, "wall"))
    return out
