"""e-zone control app: FastAPI backend.

Proxies and guards the Advantage Air e-zone local API, keeps a cached
state snapshot fresh with a background poll loop, and records history
into SQLite for the analytics/maintenance features.
"""

from __future__ import annotations

import asyncio
import copy
import json
import os
import logging
import sqlite3
import threading
import time
import typing
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import activity
from .autopilot import Autopilot
from .ezone import EzoneClient, EzoneError, _deep_merge
from .sensors import SensorFeed

EZONE_HOST = os.environ.get("EZONE_HOST", "10.160.1.180")
EZONE_PORT = int(os.environ.get("EZONE_PORT", "2025"))
EZONE_MOCK = os.environ.get("EZONE_MOCK", "0") == "1"
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "30"))
DATA_DIR = Path(os.environ.get("DATA_DIR", "./data"))
# Default assumes mosquitto in the same compose project; set MQTT_URL="" to disable.
MQTT_URL = os.environ.get("MQTT_URL", "mqtt://mosquitto:1883")
SENSOR_MAP = dict(
    pair.split("=", 1)
    for pair in os.environ.get("SENSOR_MAP", "").split(",")
    if "=" in pair
)

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

VALID_MODES = {"heat", "cool", "vent", "dry"}
VALID_FAN = {"low", "medium", "high"}
TEMP_MIN, TEMP_MAX = 16, 32


class Cache:
    def __init__(self) -> None:
        self.data: dict | None = None
        self.fetched_at: float = 0.0
        self.ok: bool = False
        self.error: str = ""


cache = Cache()
client: EzoneClient | None = None
db: sqlite3.Connection | None = None
db_lock = threading.Lock()  # one connection shared across threads
feed: SensorFeed | None = None
log = logging.getLogger("uvicorn.error")

# Store-and-forward queue: the tablet sleeps its Wi-Fi, so changes made while
# it's unreachable are held as one merged pending diff and delivered as soon
# as it answers again (persisted so an app restart doesn't lose them).
pending: dict | None = None
pending_at: float = 0.0
PENDING_PATH = None  # set at startup, lives in DATA_DIR
offline_since: float = 0.0  # when the current tablet outage began (0 = none)

# Intent overlay: the tablet takes several seconds to apply a delivered write
# to its own reported state. Each accepted write is remembered here and wins
# over observed state until the tablet confirms it (or the TTL expires, at
# which point the UI honestly reverts).
recent: list[dict] = []  # {"path": [...], "value": v, "ts": float}
RECENT_TTL = 45
# Queued intent has a shelf life: a "turn it on" from 10 minutes ago should
# not fire whenever the tablet finally wakes. Expiries are logged to the
# activity feed so a silently dropped change is never a mystery.
PENDING_TTL = 600


def _flatten_change(change: dict, prefix: tuple = ()) -> list[tuple]:
    out = []
    for key, value in change.items():
        if isinstance(value, dict):
            out.extend(_flatten_change(value, prefix + (key,)))
        else:
            out.append((prefix + (key,), value))
    return out


def _note_recent(ac_change: dict) -> None:
    """Remember a delivered write until the tablet's state reflects it."""
    now = time.time()
    entries = _flatten_change(ac_change)
    paths = {p for p, _ in entries}
    recent[:] = [e for e in recent if tuple(e["path"]) not in paths]
    recent.extend({"path": list(p), "value": v, "ts": now} for p, v in entries)


def _get_path(node, path):
    for key in path:
        if not isinstance(node, dict) or key not in node:
            return None
        node = node[key]
    return node


def _prune_recent() -> None:
    """Drop intent entries the tablet has confirmed, plus expired ones."""
    now = time.time()
    ac = cache.data["aircons"]["ac1"] if cache.data else {}
    kept = []
    for e in recent:
        if now - e["ts"] > RECENT_TTL:
            continue
        current = _get_path(ac, e["path"])
        if e["path"][-1] in ("countDownToOff", "countDownToOn"):
            # the tablet immediately ticks countdowns below the set value
            v = e["value"]
            if (v == 0 and not current) or (v > 0 and current and 0 < current <= v):
                continue
        elif current == e["value"]:
            continue
        kept.append(e)
    recent[:] = kept


def _load_pending() -> None:
    global pending, pending_at
    try:
        stored = json.loads(PENDING_PATH.read_text())
        pending, pending_at = stored["change"], stored["at"]
    except (OSError, ValueError, KeyError):
        pending, pending_at = None, 0.0


def _save_pending() -> None:
    if pending is None:
        PENDING_PATH.unlink(missing_ok=True)
    else:
        PENDING_PATH.write_text(json.dumps({"change": pending, "at": pending_at}))


def _queue_change(ac_change: dict) -> None:
    global pending, pending_at
    first = pending is None
    if pending is None:
        pending = {}
        pending_at = time.time()
    _deep_merge(pending, ac_change)
    _save_pending()
    if first:
        _activity("system", [("queued", {})])


def _expire_pending() -> bool:
    """Drop a queued change that outlived its usefulness, and say so."""
    global pending
    if pending is None or time.time() - pending_at <= PENDING_TTL:
        return False
    age = round(time.time() - pending_at)
    paths = [".".join(p) for p, _ in _flatten_change(pending)]
    pending = None
    _save_pending()
    _activity("system", [("expired", {"ageSeconds": age, "paths": paths})])
    log.warning("queued change expired after %ss undelivered: %s", age, paths)
    return True


def _effective_data() -> dict | None:
    """Last-observed state, with delivered-but-unconfirmed intent layered on,
    then undelivered (queued) intent on top of that."""
    if cache.data is None:
        return None
    data = copy.deepcopy(cache.data)
    ac = data["aircons"]["ac1"]
    for e in recent:
        node = ac
        for key in e["path"][:-1]:
            node = node.setdefault(key, {})
        node[e["path"][-1]] = e["value"]
    if pending:
        _deep_merge(ac, pending)
    return data


def _init_db() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DATA_DIR / "ezone.db", check_same_thread=False, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS snapshots (
            ts INTEGER PRIMARY KEY,
            state TEXT, mode TEXT, set_temp REAL, fan TEXT,
            zones TEXT, error_code TEXT, filter_status INTEGER
        )"""
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS activity (ts REAL, source TEXT, kind TEXT, detail TEXT)"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity (ts)")
    conn.commit()
    return conn


def _record_snapshot(data: dict) -> None:
    info = data["aircons"]["ac1"]["info"]
    zones = {}
    for zid, z in data["aircons"]["ac1"]["zones"].items():
        reading = feed.reading_for_zone(zid, z["name"]) if feed else None
        zones[zid] = {
            "state": z["state"],
            "value": z["value"],
            "measuredTemp": reading["temperature"] if reading and not reading["stale"] else None,
            "humidity": reading["humidity"] if reading and not reading["stale"] else None,
        }
    with db_lock:
        db.execute(
            "INSERT OR REPLACE INTO snapshots VALUES (?,?,?,?,?,?,?,?)",
            (
                int(time.time()),
                info.get("state"),
                info.get("mode"),
                info.get("setTemp"),
                info.get("fan"),
                json.dumps(zones),
                info.get("airconErrorCode", ""),
                info.get("filterCleanStatus", 0),
            ),
        )
        db.commit()


def _activity(source: str, events: list) -> None:
    try:
        activity.record(db, db_lock, source, events)
    except Exception:  # noqa: BLE001 — the feed must never break control flow
        log.warning("activity write failed: %s %s", source, events)


def _zone_names() -> dict:
    if cache.data is None:
        return {}
    return {zid: z.get("name", zid) for zid, z in cache.data["aircons"]["ac1"]["zones"].items()}


def _explained_intents() -> set:
    """(path, value) for every in-flight write of ours, so observed changes
    they caused aren't blamed on the wall panel."""
    out = set()
    for e in recent:
        out.add((tuple(e["path"]), activity._norm(e["value"])))
    for path, value in _flatten_change(pending or {}):
        out.add((path, activity._norm(value)))
    return out


def _log_external(prev_data, was_ok: bool, explained: set) -> None:
    """Narrate observed changes nobody in this app asked for."""
    global offline_since
    by_src: dict[str, list] = {}
    if not was_ok and offline_since:
        by_src.setdefault("system", []).append(
            ("online", {"downSeconds": round(time.time() - offline_since)})
        )
        offline_since = 0.0
    prev_ac = prev_data["aircons"]["ac1"] if prev_data else {}
    new_ac = cache.data["aircons"]["ac1"] if cache.data else {}
    for kind, detail, src in activity.diff_external(prev_ac, new_ac, explained):
        by_src.setdefault(src, []).append((kind, detail))
    for src, events in by_src.items():
        _activity(src, events)


def _last_state_path() -> Path:
    return DATA_DIR / "last_state.json"


async def _refresh() -> None:
    global offline_since
    was_ok, prev_data = cache.ok, cache.data
    try:
        data = await client.get_system_data()
        cache.data = data
        cache.fetched_at = time.time()
        cache.ok = True
        cache.error = ""
        explained = _explained_intents()
        await asyncio.to_thread(_log_external, prev_data, was_ok, explained)
        _prune_recent()
        await asyncio.to_thread(_record_snapshot, data)
        await asyncio.to_thread(
            _last_state_path().write_text, json.dumps({"at": cache.fetched_at, "data": data})
        )
    except EzoneError as exc:
        cache.ok = False
        cache.error = str(exc)
        if was_ok:
            offline_since = time.time()
            await asyncio.to_thread(_activity, "system", [("offline", {})])
        await asyncio.to_thread(_record_offline)


def _record_offline() -> None:
    """Log failed polls too, so tablet sleep behaviour can be measured."""
    with db_lock:
        db.execute(
            "INSERT OR REPLACE INTO snapshots VALUES (?,?,?,?,?,?,?,?)",
            (int(time.time()), "unreachable", None, None, None, "{}", "", 0),
        )
        db.commit()


def _load_last_state() -> None:
    """Cold-start the digital twin from disk so a sleeping tablet doesn't
    leave the app blank after a restart."""
    try:
        stored = json.loads(_last_state_path().read_text())
        cache.data = stored["data"]
        cache.fetched_at = stored["at"]
        cache.ok = False
        cache.error = "serving last-known state"
    except (OSError, ValueError, KeyError):
        pass


async def _poll_loop() -> None:
    while True:
        await _refresh()
        await asyncio.sleep(POLL_SECONDS)


outdoor = {"temp": None, "at": 0.0}

# Filter tracking: the tablet's own reminder counter is installer-configured
# and typically never enabled, so we count unit runtime hours ourselves from
# a user-set "last cleaned" mark.
filter_state = {"cleanedAt": 0}

# ---- Phase 2: closed-loop auto ----
AUTO_INTERVAL = 60
OVERRIDE_S = 3600  # manual changes silence auto on that scope for an hour

pilot = Autopilot()
# One master switch and one master target: when auto is on, the dial's value
# IS the target and the loop manages sensor-equipped zones toward it.
auto_cfg: dict = {"enabled": False, "target": 21.0}
overrides: dict[str, float] = {}  # scope -> expiry timestamp


def _auto_path() -> Path:
    return DATA_DIR / "auto.json"


def _load_auto() -> None:
    global auto_cfg
    try:
        stored = json.loads(_auto_path().read_text())
        if "target" in stored and not isinstance(stored.get("target"), dict):
            auto_cfg = {"enabled": bool(stored.get("enabled")), "target": float(stored["target"])}
        else:  # migrate the short-lived per-zone shape
            zones = [c for c in stored.values() if isinstance(c, dict)]
            enabled = [c for c in zones if c.get("enabled")]
            auto_cfg = {
                "enabled": bool(enabled),
                "target": float((enabled or zones or [{"target": 21.0}])[0].get("target", 21.0)),
            }
    except (OSError, ValueError, TypeError):
        auto_cfg = {"enabled": False, "target": 21.0}
        return
    # Restore autopilot ownership so a redeploy doesn't forget the unit is
    # auto's to power off (the timestamps keep min-run/min-off honest too).
    p = stored.get("pilot") if isinstance(stored, dict) else None
    if isinstance(p, dict):
        pilot.owns_power = bool(p.get("owns_power"))
        pilot.last_on = float(p.get("last_on", 0.0))
        pilot.last_off = float(p.get("last_off", 0.0))


def _pilot_cfg() -> dict:
    """Sensor-equipped zones all follow the master target while auto is on."""
    if not auto_cfg["enabled"] or cache.data is None or feed is None:
        return {}
    cfg = {}
    for zid, zone in cache.data["aircons"]["ac1"]["zones"].items():
        if feed.reading_for_zone(zid, zone["name"]) is not None:
            cfg[zid] = {"enabled": True, "target": auto_cfg["target"]}
    return cfg


def _save_auto() -> None:
    _auto_path().write_text(json.dumps({
        **auto_cfg,
        "pilot": {
            "owns_power": pilot.owns_power,
            "last_on": pilot.last_on,
            "last_off": pilot.last_off,
        },
    }))


def _active_overrides() -> set:
    now = time.time()
    for scope in [s for s, exp in overrides.items() if exp <= now]:
        del overrides[scope]
    return set(overrides)


def _mark_overrides(change: dict) -> None:
    """A user-made change silences auto on the touched scopes for an hour."""
    exp = time.time() + OVERRIDE_S
    info = change.get("info", {})
    if "state" in info or "countDownToOff" in info or "countDownToOn" in info:
        overrides["power"] = exp
    if "setTemp" in info:
        overrides["setTemp"] = exp
    for zid in change.get("zones", {}):
        overrides[f"zone:{zid}"] = exp


def _auto_log(action: str, reason: str) -> None:
    try:
        with db_lock:
            db.execute("INSERT INTO auto_log VALUES (?,?,?)", (int(time.time()), action, reason))
            db.commit()
    except sqlite3.Error:
        log.warning("auto_log write failed: %s %s", action, reason)


async def _auto_loop() -> None:
    while True:
        await asyncio.sleep(AUTO_INTERVAL)
        try:
            await _auto_tick()
        except Exception:  # noqa: BLE001 — the loop must never die
            log.exception("auto tick failed")


async def _auto_tick() -> None:
    if not auto_cfg["enabled"]:
        return
    if not cache.ok or cache.data is None or feed is None:
        return  # tablet asleep or no sensors: stand down this tick
    ac = cache.data["aircons"]["ac1"]
    readings = {
        zid: feed.reading_for_zone(zid, z["name"]) for zid, z in ac["zones"].items()
    }
    cfg = _pilot_cfg()
    prev_calling, prev_susp = dict(pilot.calling), dict(pilot.suspended)
    before = (pilot.owns_power, pilot.last_on, pilot.last_off)
    change, logs = pilot.tick(cfg, ac, readings, _active_overrides(), time.time())
    if (pilot.owns_power, pilot.last_on, pilot.last_off) != before:
        await asyncio.to_thread(_save_auto)
    names = _zone_names()
    acts = []
    for zid in cfg:
        s_now, s_was = pilot.suspended.get(zid), prev_susp.get(zid)
        if s_now != s_was:
            acts.append((
                "suspended" if s_now else "resumed",
                {"zid": zid, "name": names.get(zid, zid), "reason": s_now},
            ))
        c_now, c_was = pilot.calling.get(zid, False), prev_calling.get(zid, False)
        if c_now != c_was:
            r = readings.get(zid) or {}
            acts.append((
                "calling" if c_now else "satisfied",
                {"zid": zid, "name": names.get(zid, zid),
                 "room": r.get("temperature"), "target": cfg[zid]["target"]},
            ))
    if acts:
        await asyncio.to_thread(_activity, "auto", acts)
    for line in logs:
        await asyncio.to_thread(_auto_log, "decide", line)
    if not change:
        return
    try:
        payload = _validate_change(AirconChange(**change))
    except HTTPException as exc:
        await asyncio.to_thread(_auto_log, "blocked", f"{change} -> {exc.detail}")
        await asyncio.to_thread(_activity, "auto", [("blocked", {"detail": str(exc.detail)})])
        return
    try:
        await client.set_aircon(payload)
        _note_recent(payload["ac1"])
        await asyncio.to_thread(_auto_log, "apply", json.dumps(change))
        await asyncio.to_thread(
            _activity, "auto", activity.events_from_change(payload["ac1"], names, auto=True)
        )
        await _refresh()
    except EzoneError as exc:
        await asyncio.to_thread(_auto_log, "error", str(exc))


def _filter_path() -> Path:
    return DATA_DIR / "filter.json"


def _load_filter() -> None:
    try:
        filter_state.update(json.loads(_filter_path().read_text()))
    except (OSError, ValueError):
        filter_state["cleanedAt"] = int(time.time())
        _filter_path().write_text(json.dumps(filter_state))


def _runtime_since(since: int) -> int:
    with db_lock:
        rows = db.execute(
            "SELECT ts, state FROM snapshots WHERE ts >= ? ORDER BY ts", (since,)
        ).fetchall()
    total = 0
    prev_ts = prev_state = None
    for ts, st in rows:
        if prev_ts is not None and prev_state == "on":
            total += min(ts - prev_ts, POLL_SECONDS * 4)
        prev_ts, prev_state = ts, st
    return total


async def _outdoor_loop() -> None:
    """Real outdoor temperature via Open-Meteo (the tablet's suburb feed can
    lag by hours). Uses the coordinates the tablet already knows."""
    async with httpx.AsyncClient(timeout=10.0) as web:
        while True:
            lat = lng = None
            if cache.data:
                sysd = cache.data.get("system", {})
                lat, lng = sysd.get("latitude"), sysd.get("longitude")
            if lat and lng:
                try:
                    r = await web.get(
                        "https://api.open-meteo.com/v1/forecast",
                        params={"latitude": lat, "longitude": lng, "current": "temperature_2m"},
                    )
                    outdoor["temp"] = r.json()["current"]["temperature_2m"]
                    outdoor["at"] = time.time()
                except Exception:  # noqa: BLE001 — weather is best-effort
                    pass
            # retry quickly until the first reading, then quarter-hourly
            await asyncio.sleep(900 if outdoor["temp"] is not None else 30)


async def _deliver_loop() -> None:
    """Keep knocking while a queued change is waiting for the tablet."""
    global pending
    while True:
        await asyncio.sleep(12)
        if pending is None:
            continue
        if _expire_pending():
            continue
        try:
            delivered = copy.deepcopy(pending)
            await client.set_aircon({"ac1": delivered})
            _note_recent(delivered)  # hold the display until the tablet confirms
            pending = None
            _save_pending()
            await asyncio.to_thread(_activity, "system", [("delivered", {})])
            await _refresh()
        except EzoneError:
            pass  # still asleep; try again next round


@asynccontextmanager
async def lifespan(app: FastAPI):
    global client, db, PENDING_PATH, feed
    client = EzoneClient(EZONE_HOST, EZONE_PORT, mock=EZONE_MOCK)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PENDING_PATH = DATA_DIR / "pending.json"
    _load_pending()
    _load_last_state()
    db = _init_db()
    db.execute("CREATE TABLE IF NOT EXISTS auto_log (ts INTEGER, action TEXT, reason TEXT)")
    db.commit()
    _load_filter()
    _load_auto()
    tasks = [
        asyncio.create_task(_poll_loop()),
        asyncio.create_task(_deliver_loop()),
        asyncio.create_task(_outdoor_loop()),
        asyncio.create_task(_auto_loop()),
    ]
    if EZONE_MOCK and os.environ.get("MOCK_SENSOR") == "1":
        from .sensors import SimFeed

        feed = SimFeed(
            get_ac=lambda: client._mock_state["aircons"]["ac1"],
            accel=float(os.environ.get("SIM_ACCEL", "6")),
        )
        tasks.append(asyncio.create_task(feed.run()))
    elif MQTT_URL:
        feed = SensorFeed(MQTT_URL, SENSOR_MAP)
        tasks.append(asyncio.create_task(feed.run()))
    yield
    for task in tasks:
        task.cancel()
    await client.aclose()
    db.close()


app = FastAPI(title="e-zone", lifespan=lifespan)


def _state_payload() -> dict:
    data = _effective_data()
    if data and feed:
        for zid, zone in data["aircons"]["ac1"]["zones"].items():
            reading = feed.reading_for_zone(zid, zone["name"])
            if reading:
                zone["sensor"] = reading
                if not reading["stale"] and reading["temperature"] is not None:
                    zone["measuredTemp"] = reading["temperature"]
    if data and feed:
        for zid, zone in data["aircons"]["ac1"]["zones"].items():
            if zone.get("sensor") is not None:
                zone["auto"] = pilot.zone_status(zid)
    return {
        "ok": cache.ok,
        "ageSeconds": round(time.time() - cache.fetched_at, 1) if cache.data else None,
        "error": cache.error,
        "mock": EZONE_MOCK,
        "mqtt": feed.connected if feed else None,
        "pending": pending is not None,
        "pendingAgeSeconds": round(time.time() - pending_at, 1) if pending else None,
        "recentPaths": [e["path"] for e in recent],
        "auto": dict(auto_cfg),
        "outdoor": outdoor["temp"] if time.time() - outdoor["at"] < 7200 else None,
        "data": data,
    }


@app.get("/api/state")
async def get_state(refresh: int = Query(0)):
    if refresh or cache.data is None:
        await _refresh()
    if cache.data is None:
        raise HTTPException(503, f"e-zone unreachable: {cache.error}")
    return _state_payload()


class AirconChange(BaseModel):
    info: dict = {}
    zones: dict = {}


def _validate_change(change: AirconChange) -> dict:
    """Whitelist fields, clamp values, and enforce safety invariants."""
    info: dict = {}
    for key, value in change.info.items():
        if key == "state":
            if value not in {"on", "off"}:
                raise HTTPException(422, f"bad state '{value}'")
        elif key == "mode":
            if value not in VALID_MODES:
                raise HTTPException(422, f"bad mode '{value}'")
        elif key == "fan":
            if value not in VALID_FAN:
                raise HTTPException(422, f"bad fan '{value}'")
        elif key == "setTemp":
            value = max(TEMP_MIN, min(TEMP_MAX, int(value)))
        elif key in {"countDownToOn", "countDownToOff"}:
            value = max(0, min(720, int(value)))
        else:
            raise HTTPException(422, f"field '{key}' not allowed")
        info[key] = value

    effective = _effective_data()
    zones: dict = {}
    known_zones = effective["aircons"]["ac1"]["zones"] if effective else {}
    for zid, zchange in change.zones.items():
        if zid not in known_zones:
            raise HTTPException(422, f"unknown zone '{zid}'")
        clean: dict = {}
        for key, value in zchange.items():
            if key == "state":
                if value not in {"open", "close"}:
                    raise HTTPException(422, f"bad zone state '{value}'")
            elif key == "value":
                value = max(0, min(100, int(round(int(value) / 5) * 5)))
            else:
                raise HTTPException(422, f"zone field '{key}' not allowed")
            clean[key] = value
        zones[zid] = clean

    # Safety invariant: this system has no constant zone, so never let the
    # last open zone close while the unit is (or is being turned) on.
    if effective:
        current = effective["aircons"]["ac1"]
        would_be_on = info.get("state", current["info"]["state"]) == "on"
        if would_be_on:
            any_open = False
            for zid, zone in current["zones"].items():
                state = zones.get(zid, {}).get("state", zone["state"])
                if state == "open":
                    any_open = True
                    break
            if not any_open:
                raise HTTPException(
                    409,
                    "Blocked: at least one zone must stay open while the system is on "
                    "(no constant zone is configured on this unit).",
                )

    payload: dict = {}
    if info:
        payload["info"] = info
    if zones:
        payload["zones"] = zones
    if not payload:
        raise HTTPException(422, "no changes supplied")
    return {"ac1": payload}


@app.post("/api/aircon")
async def set_aircon(change: AirconChange):
    if cache.data is None:
        await _refresh()
    payload = _validate_change(change)
    _mark_overrides(payload["ac1"])  # manual wins: auto stands down on these scopes
    await asyncio.to_thread(
        _activity, "you", activity.events_from_change(payload["ac1"], _zone_names())
    )

    # If the tablet is known to be asleep, don't make the user wait through
    # a doomed retry cycle — queue immediately.
    if not cache.ok:
        _queue_change(payload["ac1"])
        return {"queued": True, **_state_payload()}

    try:
        ack = await client.set_aircon(payload)
    except EzoneError:
        _queue_change(payload["ac1"])
        cache.ok = False
        return {"queued": True, **_state_payload()}

    # Respond immediately: the intent overlay covers the tablet's apply lag,
    # and the poll loop confirms (and releases) it within a cycle.
    _note_recent(payload["ac1"])
    return {"ack": ack, "queued": False, **_state_payload()}


@app.get("/api/history")
async def get_history(hours: int = Query(24, ge=1, le=24 * 30)):
    since = int(time.time()) - hours * 3600
    with db_lock:
        rows = db.execute(
            "SELECT ts, state, mode, set_temp, fan, zones, error_code, filter_status "
            "FROM snapshots WHERE ts >= ? ORDER BY ts",
            (since,),
        ).fetchall()
    return {
        "points": [
            {
                "ts": r[0], "state": r[1], "mode": r[2], "setTemp": r[3],
                "fan": r[4], "zones": json.loads(r[5]), "errorCode": r[6],
                "filterStatus": r[7],
            }
            for r in rows
        ]
    }


@app.get("/api/today")
async def today():
    """Today's runtime (total, per mode, per hour) and cycle count."""
    lt = time.localtime()
    midnight = int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1)))
    with db_lock:
        rows = db.execute(
            "SELECT ts, state, mode FROM snapshots WHERE ts >= ? ORDER BY ts", (midnight,)
        ).fetchall()
    runtime = 0
    cycles = 0
    by_mode: dict[str, int] = {}
    hourly: dict[int, int] = {}
    prev_ts = prev_state = prev_mode = None
    for ts, st, mode in rows:
        if prev_ts is not None and prev_state == "on":
            dur = min(ts - prev_ts, POLL_SECONDS * 4)  # cap over gaps/outages
            runtime += dur
            by_mode[prev_mode] = by_mode.get(prev_mode, 0) + dur
            hour = (prev_ts - midnight) // 3600
            hourly[hour] = hourly.get(hour, 0) + dur
        if st == "on" and prev_state != "on":
            cycles += 1
        prev_ts, prev_state, prev_mode = ts, st, mode
    return {
        "runtimeSeconds": runtime,
        "cycles": cycles,
        "byMode": {m: s for m, s in by_mode.items() if m and s},
        "hourly": [[h, s] for h, s in sorted(hourly.items())],
        "hourNow": (int(time.time()) - midnight) // 3600,
        "filterRuntimeSeconds": await asyncio.to_thread(_runtime_since, filter_state["cleanedAt"]),
        "filterCleanedAt": filter_state["cleanedAt"],
    }


@app.post("/api/filter/cleaned")
async def filter_cleaned():
    filter_state["cleanedAt"] = int(time.time())
    _filter_path().write_text(json.dumps(filter_state))
    return {"filterCleanedAt": filter_state["cleanedAt"], "filterRuntimeSeconds": 0}


class AutoChange(BaseModel):
    enabled: typing.Optional[bool] = None
    target: typing.Optional[float] = None


@app.post("/api/auto")
async def set_auto(change: AutoChange):
    if cache.data is None:
        await _refresh()
    if change.target is not None:
        auto_cfg["target"] = max(16.0, min(32.0, round(change.target * 2) / 2))
    if change.enabled is not None:
        was_enabled = auto_cfg["enabled"]
        auto_cfg["enabled"] = change.enabled
        if change.enabled:
            # engaging auto is consent for auto to act now on every scope it drives
            overrides.pop("power", None)
            overrides.pop("setTemp", None)
            for zid in _pilot_cfg():
                overrides.pop(f"zone:{zid}", None)
        else:
            pilot.calling.clear()
            pilot.suspended.clear()
            pilot.owns_power = False
            if was_enabled:
                # hand the unit's thermostat back: while auto ran, setTemp was
                # a drive/park actuator value, not a temperature anyone chose
                payload = {"ac1": {"info": {"setTemp": int(round(auto_cfg["target"]))}}}
                if cache.ok:
                    try:
                        await client.set_aircon(payload)
                        _note_recent(payload["ac1"])
                    except EzoneError:
                        _queue_change(payload["ac1"])
                        cache.ok = False
                else:
                    _queue_change(payload["ac1"])
                await asyncio.to_thread(
                    _auto_log, "handback",
                    f"setTemp -> {payload['ac1']['info']['setTemp']}",
                )
                await asyncio.to_thread(
                    _activity, "auto",
                    [("handback", {"value": payload["ac1"]["info"]["setTemp"]})],
                )
    acts = []
    if change.enabled is not None:
        acts.append(("autoMode", {"enabled": auto_cfg["enabled"]}))
    if change.target is not None:
        acts.append(("target", {"value": auto_cfg["target"]}))
    await asyncio.to_thread(_activity, "you", acts)
    _save_auto()
    await asyncio.to_thread(
        _auto_log, "config",
        f"auto enabled={auto_cfg['enabled']} target={auto_cfg['target']}",
    )
    return _state_payload()


@app.get("/api/auto/log")
async def auto_log(limit: int = Query(50, ge=1, le=500)):
    with db_lock:
        rows = db.execute(
            "SELECT ts, action, reason FROM auto_log ORDER BY ts DESC LIMIT ?", (limit,)
        ).fetchall()
    return {"entries": [{"ts": r[0], "action": r[1], "reason": r[2]} for r in rows]}


@app.get("/api/activity")
async def get_activity(
    before: float = Query(0),
    limit: int = Query(60, ge=1, le=200),
    sources: str = Query(""),
):
    """Unified activity feed, newest first. `before` pages backwards."""
    conds, args = [], []
    if before:
        conds.append("ts < ?")
        args.append(before)
    src = [s for s in sources.split(",") if s]
    if src:
        conds.append(f"source IN ({','.join('?' * len(src))})")
        args.extend(src)
    q = "SELECT ts, source, kind, detail FROM activity"
    if conds:
        q += " WHERE " + " AND ".join(conds)
    q += " ORDER BY ts DESC, rowid DESC LIMIT ?"
    args.append(limit + 1)
    with db_lock:
        rows = db.execute(q, args).fetchall()
    return {
        "entries": [
            {"ts": r[0], "source": r[1], "kind": r[2], "detail": json.loads(r[3])}
            for r in rows[:limit]
        ],
        "more": len(rows) > limit,
    }


@app.get("/api/temps")
async def temps(hours: int = Query(24, ge=1, le=168)):
    """Per-zone measured-temperature series (bucket-averaged) for the chart."""
    since = int(time.time()) - hours * 3600
    bucket = max(300, hours * 3600 // 96)
    with db_lock:
        rows = db.execute(
            "SELECT ts, zones FROM snapshots WHERE ts >= ? ORDER BY ts", (since,)
        ).fetchall()
    acc: dict[str, dict[int, list]] = {}
    for ts, zones_json in rows:
        try:
            zones = json.loads(zones_json)
        except ValueError:
            continue
        b = ts - ts % bucket
        for zid, z in zones.items():
            t = z.get("measuredTemp")
            if t in (None, 0):
                continue
            slot = acc.setdefault(zid, {}).setdefault(b, [0.0, 0])
            slot[0] += t
            slot[1] += 1
    names = {}
    if cache.data:
        names = {zid: z["name"] for zid, z in cache.data["aircons"]["ac1"]["zones"].items()}
    return {
        "hours": hours,
        "zones": {
            zid: {
                "name": names.get(zid, zid),
                "points": [[b, round(s / c, 2)] for b, (s, c) in sorted(buckets.items())],
            }
            for zid, buckets in acc.items()
        },
    }


@app.get("/api/health")
async def health():
    with db_lock:
        total, offline = db.execute(
            "SELECT COUNT(*), COALESCE(SUM(state = 'unreachable'), 0) FROM snapshots WHERE ts >= ?",
            (int(time.time()) - 86400,),
        ).fetchone()
    return {
        "app": "ok",
        "ezone": cache.ok,
        "mock": EZONE_MOCK,
        "error": cache.error,
        "mqtt": feed.connected if feed else None,
        "sensors": {name: round(time.time() - r["ts"]) for name, r in feed.readings.items()} if feed else {},
        "tabletUptime24h": round(100 * (1 - offline / total), 1) if total else None,
    }


@app.get("/")
async def index():
    return FileResponse(FRONTEND_DIR / "index.html")


app.mount("/", StaticFiles(directory=FRONTEND_DIR), name="frontend")
