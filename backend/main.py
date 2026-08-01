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
import sqlite3
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .ezone import EzoneClient, EzoneError, _deep_merge
from .sensors import SensorFeed

EZONE_HOST = os.environ.get("EZONE_HOST", "10.160.1.180")
EZONE_PORT = int(os.environ.get("EZONE_PORT", "2025"))
EZONE_MOCK = os.environ.get("EZONE_MOCK", "0") == "1"
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "30"))
DATA_DIR = Path(os.environ.get("DATA_DIR", "./data"))
MQTT_URL = os.environ.get("MQTT_URL", "")
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
feed: SensorFeed | None = None

# Store-and-forward queue: the tablet sleeps its Wi-Fi, so changes made while
# it's unreachable are held as one merged pending diff and delivered as soon
# as it answers again (persisted so an app restart doesn't lose them).
pending: dict | None = None
pending_at: float = 0.0
PENDING_PATH = None  # set at startup, lives in DATA_DIR


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
    if pending is None:
        pending = {}
        pending_at = time.time()
    _deep_merge(pending, ac_change)
    _save_pending()


def _effective_data() -> dict | None:
    """Last-known state with any pending (undelivered) change layered on top."""
    if cache.data is None:
        return None
    data = copy.deepcopy(cache.data)
    if pending:
        _deep_merge(data["aircons"]["ac1"], pending)
    return data


def _init_db() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DATA_DIR / "ezone.db", check_same_thread=False)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS snapshots (
            ts INTEGER PRIMARY KEY,
            state TEXT, mode TEXT, set_temp REAL, fan TEXT,
            zones TEXT, error_code TEXT, filter_status INTEGER
        )"""
    )
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


def _last_state_path() -> Path:
    return DATA_DIR / "last_state.json"


async def _refresh() -> None:
    try:
        data = await client.get_system_data()
        cache.data = data
        cache.fetched_at = time.time()
        cache.ok = True
        cache.error = ""
        await asyncio.to_thread(_record_snapshot, data)
        await asyncio.to_thread(
            _last_state_path().write_text, json.dumps({"at": cache.fetched_at, "data": data})
        )
    except EzoneError as exc:
        cache.ok = False
        cache.error = str(exc)
        await asyncio.to_thread(_record_offline)


def _record_offline() -> None:
    """Log failed polls too, so tablet sleep behaviour can be measured."""
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


async def _deliver_loop() -> None:
    """Keep knocking while a queued change is waiting for the tablet."""
    global pending
    while True:
        await asyncio.sleep(12)
        if pending is None:
            continue
        try:
            await client.set_aircon({"ac1": copy.deepcopy(pending)})
            pending = None
            _save_pending()
            await asyncio.sleep(1.0)
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
    tasks = [
        asyncio.create_task(_poll_loop()),
        asyncio.create_task(_deliver_loop()),
    ]
    if MQTT_URL:
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
    return {
        "ok": cache.ok,
        "ageSeconds": round(time.time() - cache.fetched_at, 1) if cache.data else None,
        "error": cache.error,
        "mock": EZONE_MOCK,
        "mqtt": feed.connected if feed else None,
        "pending": pending is not None,
        "pendingAgeSeconds": round(time.time() - pending_at, 1) if pending else None,
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

    # The tablet takes a beat to reflect changes; give it one, then re-read.
    await asyncio.sleep(1.0)
    await _refresh()
    return {"ack": ack, "queued": False, **_state_payload()}


@app.get("/api/history")
async def get_history(hours: int = Query(24, ge=1, le=24 * 30)):
    since = int(time.time()) - hours * 3600
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


@app.get("/api/health")
async def health():
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
