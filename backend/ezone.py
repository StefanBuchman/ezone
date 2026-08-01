"""Client for the Advantage Air e-zone local API.

The touchscreen's HTTP server is single-threaded and flaky (empty bodies,
truncated JSON), so every request goes through one lock, gets validated,
and retries with backoff. Mock mode simulates the tablet from a captured
getSystemData payload so the app can be developed and tested without
touching the live system.
"""

from __future__ import annotations

import asyncio
import copy
import json
import urllib.parse
from pathlib import Path

import httpx

RETRY_DELAYS = (0.5, 1.0, 2.0)

MOCK_DATA_PATH = Path(__file__).parent / "mock_data.json"


class EzoneError(Exception):
    """The tablet could not be reached or returned garbage after retries."""


def _deep_merge(target: dict, patch: dict) -> None:
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _deep_merge(target[key], value)
        else:
            target[key] = value


class EzoneClient:
    def __init__(self, host: str, port: int = 2025, mock: bool = False):
        self.base = f"http://{host}:{port}"
        self.mock = mock
        self._lock = asyncio.Lock()
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(8.0, connect=4.0))
        self._mock_state: dict | None = None
        if mock:
            self._mock_state = json.loads(MOCK_DATA_PATH.read_text())

    async def aclose(self) -> None:
        await self._client.aclose()

    async def get_system_data(self) -> dict:
        if self.mock:
            return copy.deepcopy(self._mock_state)
        async with self._lock:
            return await self._request("/getSystemData", validate_key="aircons")

    async def set_aircon(self, change: dict) -> dict:
        """change is the full payload, e.g. {"ac1": {"info": {...}, "zones": {...}}}."""
        if self.mock:
            _deep_merge(self._mock_state["aircons"], change)
            return {"ack": True, "request": "setAircon"}
        payload = urllib.parse.quote(json.dumps(change, separators=(",", ":")))
        async with self._lock:
            return await self._request(f"/setAircon?json={payload}", validate_key="ack")

    async def _request(self, path: str, validate_key: str) -> dict:
        last_error: Exception | None = None
        for attempt, delay in enumerate((*RETRY_DELAYS, None)):
            try:
                response = await self._client.get(self.base + path)
                response.raise_for_status()
                data = response.json()
                if validate_key not in data:
                    raise ValueError(f"response missing '{validate_key}'")
                return data
            except (httpx.HTTPError, ValueError, json.JSONDecodeError) as exc:
                last_error = exc
                if delay is not None:
                    await asyncio.sleep(delay)
        raise EzoneError(f"e-zone unreachable after {attempt + 1} attempts: {last_error}")
