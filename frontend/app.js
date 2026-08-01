/* e-zone · concept 2a "Tape + Thermal" */
"use strict";

const TEMP_MIN = 16, TEMP_MAX = 32;
const DIAL = { cx: 130, cy: 130, r: 102, start: 150, sweep: 240 };
const POLL_MS = 20000;
const STALE_S = 600;

const MODES = [
  { id: "heat", label: "Heat", fill: true,
    d: "M12 2.5c.5 2.9 2.3 4.5 3.8 6.2 1.5 1.7 2.7 3.4 2.7 5.8a6.5 6.5 0 1 1-13 0c0-1.8.7-3.3 1.7-4.7.3 1.3 1 2.2 2 2.7-.5-2.7.5-7 2.8-10z" },
  { id: "cool", label: "Cool", fill: false, d: "M12 3.5v17M4.6 7.8l14.8 8.4M19.4 7.8L4.6 16.2" },
  { id: "vent", label: "Vent", fill: false, d: "M3.5 8.5h9.7a2.9 2.9 0 1 0-2.9-2.9M3.5 13h13.7a3.1 3.1 0 1 1-3.1 3.1M3.5 17.5h6.5" },
  { id: "dry",  label: "Dry",  fill: false, d: "M12 3.5c3.1 3.8 5.9 7 5.9 10.4a5.9 5.9 0 1 1-11.8 0C6.1 10.5 8.9 7.3 12 3.5z" },
];
const FANS = [["low", "low"], ["medium", "med"], ["high", "high"]];
const TIMERS = [[30, "30m"], [60, "1h"], [90, "1.5h"], [120, "2h"]];

const $ = (id) => document.getElementById(id);

const state = {
  remote: null,
  local: null,
  scenes: null,
  system: null,
  today: null,
  temps: null,
  interacting: false,
  tempTimer: null,
  sent: new Map(), // pathKey -> {value, ts}; for the honest-revert toast
};

/* ================= theme ================= */

function applyTheme(theme) {
  if (theme === "l") document.documentElement.setAttribute("data-th", "l");
  else document.documentElement.removeAttribute("data-th");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === "l" ? "#F1F0ED" : "#0A0D16";
}
function initTheme() {
  const saved = localStorage.getItem("ezone-theme");
  const preferLight = window.matchMedia("(prefers-color-scheme: light)").matches;
  applyTheme(saved || (preferLight ? "l" : "d"));
  $("themeBtn").addEventListener("click", () => {
    const next = document.documentElement.hasAttribute("data-th") ? "d" : "l";
    localStorage.setItem("ezone-theme", next);
    applyTheme(next);
  });
}

/* ================= helpers ================= */

function roomReading() {
  if (!state.local) return null;
  for (const z of Object.values(state.local.zones)) {
    const s = z.sensor;
    if (s && !s.stale && s.temperature != null) return s;
  }
  return null;
}

function statusText(info, room, target) {
  if (info.state !== "on") return "off";
  if (info.mode === "vent") return "venting";
  if (info.mode === "dry") return "drying";
  if (room) {
    if (info.mode === "heat" && room.temperature < target - 0.2) return "heating";
    if (info.mode === "cool" && room.temperature > target + 0.2) return "cooling";
    return "standby";
  }
  return info.mode === "heat" ? "heating" : "cooling";
}

function fmtTemp(t) {
  return Number.isInteger(Number(t)) ? String(Math.round(t)) : Number(t).toFixed(1);
}

function autoState() {
  return state.remote?.auto || { enabled: false, target: 21 };
}
function dialValue() {
  const a = autoState();
  return a.enabled ? a.target : state.local.info.setTemp;
}

function fmtMins(mins) {
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ================= arc dial ================= */

function tempAngle(t) {
  return DIAL.start + ((t - TEMP_MIN) / (TEMP_MAX - TEMP_MIN)) * DIAL.sweep;
}
function polar(angleDeg, radius = DIAL.r) {
  const a = (angleDeg * Math.PI) / 180;
  return [DIAL.cx + radius * Math.cos(a), DIAL.cy + radius * Math.sin(a)];
}
function arcPath(fromDeg, toDeg) {
  const [x1, y1] = polar(fromDeg);
  const [x2, y2] = polar(toDeg);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${DIAL.r} ${DIAL.r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

function buildDial() {
  $("dialTrack").setAttribute("d", arcPath(DIAL.start, DIAL.start + DIAL.sweep));
}

function renderDial(setTemp, mode) {
  const end = tempAngle(setTemp);
  const arc = $("dialArc");
  arc.setAttribute("d", arcPath(DIAL.start, Math.max(end, DIAL.start + 0.01)));
  arc.style.stroke =
    mode === "heat" ? "url(#heatGrad)" :
    mode === "vent" ? "var(--ok)" : "var(--cool)";

  const [hx, hy] = polar(end);
  $("handleO").setAttribute("cx", hx); $("handleO").setAttribute("cy", hy);
  $("handleI").setAttribute("cx", hx); $("handleI").setAttribute("cy", hy);

  const room = roomReading();
  const dot = $("roomDot");
  if (room && room.temperature >= TEMP_MIN && room.temperature <= TEMP_MAX) {
    const [rx, ry] = polar(tempAngle(room.temperature));
    dot.setAttribute("cx", rx); dot.setAttribute("cy", ry);
    dot.setAttribute("visibility", "visible");
  } else {
    dot.setAttribute("visibility", "hidden");
  }
}

/* dial lock: the drag surface is a scroll hazard, so setpoint changes are
   gated behind an explicit unlock that re-arms itself after 15s idle */
const lock = { locked: true, timer: null, warned: false };

function renderLock() {
  const btn = $("dialLock");
  btn.classList.toggle("unlocked", !lock.locked);
  btn.setAttribute("aria-pressed", String(lock.locked));
  btn.setAttribute("aria-label", lock.locked ? "Unlock temperature dial" : "Lock temperature dial");
  $("shackle").setAttribute("d", lock.locked ? "M8 11V8a4 4 0 0 1 8 0v3" : "M8 11V8a4 4 0 0 1 8 0");
  $("dial").classList.toggle("locked", lock.locked);
  $("tempDown").classList.toggle("locked", lock.locked);
  $("tempUp").classList.toggle("locked", lock.locked);
}

function armRelock() {
  clearTimeout(lock.timer);
  lock.timer = setTimeout(() => { lock.locked = true; renderLock(); }, 15000);
}

function lockedNudge() {
  const btn = $("dialLock");
  btn.classList.remove("nudge");
  void btn.offsetWidth; // restart the animation
  btn.classList.add("nudge");
  if (!lock.warned) {
    lock.warned = true;
    toast("Dial is locked — tap the padlock to adjust the temperature.");
  }
}

function initDialLock() {
  renderLock();
  $("dialLock").addEventListener("click", () => {
    lock.locked = !lock.locked;
    renderLock();
    if (!lock.locked) armRelock();
  });
}

function initDialDrag() {
  const wrap = $("dial");
  let dragging = false, moved = false;

  const pointToTemp = (e) => {
    const rect = wrap.getBoundingClientRect();
    const scale = rect.width / 260;
    const dx = (e.clientX - rect.left) / scale - DIAL.cx;
    const dy = (e.clientY - rect.top) / scale - DIAL.cy;
    let a = ((Math.atan2(dy, dx) * 180) / Math.PI - DIAL.start + 360) % 360;
    if (a > DIAL.sweep) a = a > DIAL.sweep + (360 - DIAL.sweep) / 2 ? 0 : DIAL.sweep;
    const raw = TEMP_MIN + (a / DIAL.sweep) * (TEMP_MAX - TEMP_MIN);
    // auto targets are software-side: half-degree resolution
    const snap = autoState().enabled ? 2 : 1;
    return Math.max(TEMP_MIN, Math.min(TEMP_MAX, Math.round(raw * snap) / snap));
  };

  const applyDialValue = (t) => {
    if (autoState().enabled) state.remote.auto.target = t;
    else state.local.info.setTemp = t;
    renderHero();
  };

  wrap.addEventListener("pointerdown", (e) => {
    if (!state.local) return;
    if (e.target.closest(".dial-lock")) return; // the lock button is not a drag
    if (lock.locked) { lockedNudge(); return; }
    armRelock();
    dragging = true; moved = false;
    wrap.classList.add("dragging");
    wrap.setPointerCapture(e.pointerId);
    state.interacting = true;
    const t = pointToTemp(e);
    if (t !== dialValue()) { moved = true; applyDialValue(t); }
  });
  wrap.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const t = pointToTemp(e);
    if (t !== dialValue()) { moved = true; applyDialValue(t); }
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    wrap.classList.remove("dragging");
    state.interacting = false;
    if (moved) commitDial();
  };
  wrap.addEventListener("pointerup", end);
  wrap.addEventListener("pointercancel", end);
}

/* ================= rendering ================= */

function renderHero() {
  const info = state.local.info;
  const on = info.state === "on";
  const auto = autoState();
  const value = dialValue();
  const room = roomReading();

  $("setTemp").textContent = fmtTemp(value);
  document.querySelector(".dial-center .lbl").textContent = auto.enabled ? "Target" : "Set to";
  renderDial(value, info.mode);

  const autoBtn = $("autoBtn");
  autoBtn.classList.toggle("on", auto.enabled);
  autoBtn.setAttribute("aria-pressed", String(auto.enabled));

  const st = statusText(info, room, value);
  $("roomLine").innerHTML = room
    ? `room <b>${Number(room.temperature).toFixed(1)}&deg;</b> &middot; ${st}`
    : st === "off" ? "system off" : st;

  const chip = $("deltaChip");
  let delta, color = "var(--dim)";
  if (!on) delta = auto.enabled ? "auto &middot; waiting" : "system off";
  else if (!room) delta = st;
  else {
    const dd = value - room.temperature;
    if (Math.abs(dd) <= 0.2) delta = "at temperature";
    else if (dd > 0) delta = `+${dd.toFixed(1)}&deg; to go`;
    else delta = `${dd.toFixed(1)}&deg; over`;
  }
  if (on && st !== "standby") {
    color = info.mode === "heat" ? "var(--acc)" : info.mode === "vent" ? "var(--ok)" : "var(--cool)";
  }
  chip.innerHTML = delta;
  chip.style.color = color;

  const pwr = $("powerBtn");
  pwr.classList.toggle("on", on);
  pwr.title = on ? "Turn off" : "Turn on";
  $("dial").classList.toggle("off", !on);

  document.querySelectorAll(".mode-pill").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === info.mode);
  });
  document.querySelectorAll("#fanChips .chip-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.fan === info.fan);
  });
  renderTimerChips(info);
}

function renderTimerChips(info) {
  const off = Number(info.countDownToOff) || 0;
  const chips = [...document.querySelectorAll("#timerChips .chip-btn")];
  chips.forEach((b) => { b.classList.remove("active"); b.textContent = b.dataset.label; });
  if (off > 0) {
    // the nearest preset at/above the remaining time shows the live countdown
    const target = chips.find((b) => Number(b.dataset.min) >= off) || chips[chips.length - 1];
    target.classList.add("active");
    target.textContent = fmtMins(off);
  }
}

function renderZones() {
  const ac = state.local;
  const on = ac.info.state === "on";
  const list = $("zoneList");
  const ids = Object.keys(ac.zones).sort();
  const openCount = ids.filter((z) => ac.zones[z].state === "open").length;

  for (const zid of ids) {
    const z = ac.zones[zid];
    let card = document.getElementById(`zone-${zid}`);
    if (!card) {
      card = document.createElement("div");
      card.id = `zone-${zid}`;
      card.className = "zone";
      card.innerHTML = `
        <div class="zone-head">
          <div>
            <div class="zone-name"></div>
            <div class="zone-sub"></div>
          </div>
          <button class="ztog" role="switch" aria-label="zone open"></button>
        </div>
        <div class="zone-auto-row" hidden>
          <span class="chip-btn auto-tag">auto</span>
          <span class="auto-status"></span>
        </div>
        <div class="zone-slider-row">
          <input type="range" min="5" max="100" step="5" aria-label="damper percentage">
          <span class="pct"></span>
        </div>`;
      list.appendChild(card);

      card.querySelector(".ztog").addEventListener("click", () => {
        const zone = state.local.zones[zid];
        sendChange({ zones: { [zid]: { state: zone.state === "open" ? "close" : "open" } } }, card);
      });
      const slider = card.querySelector("input");
      slider.addEventListener("input", () => {
        state.interacting = true;
        card.querySelector(".pct").textContent = `${slider.value}%`;
        slider.style.setProperty("--fill", `${slider.value}%`);
      });
      slider.addEventListener("change", () => {
        state.interacting = false;
        sendChange({ zones: { [zid]: { value: Number(slider.value) } } }, card);
      });

    }

    const isOpen = z.state === "open";
    card.querySelector(".zone-name").textContent = z.name;

    const s = z.sensor;
    let sub = isOpen ? `damper open &middot; ${Number(z.value)}%` : "closed";
    if (s && s.temperature != null) {
      sub = s.stale
        ? `<span class="stale-tag">sensor stale</span> &middot; ${sub}`
        : `<b>${Number(s.temperature).toFixed(1)}&deg;</b> &middot; ${Math.round(Number(s.humidity))}% rh &middot; ${sub}`;
      if (s.battery != null && s.battery <= 20) sub += ' &middot; <span class="stale-tag">low batt</span>';
    }
    card.querySelector(".zone-sub").innerHTML = sub;

    const tog = card.querySelector(".ztog");
    tog.classList.toggle("on", isOpen);
    tog.setAttribute("aria-checked", String(isOpen));
    tog.disabled = on && isOpen && openCount === 1;
    tog.title = tog.disabled ? "At least one zone must stay open while the system is on" : "";

    // auto status row: sensor-equipped zones while master auto is engaged
    const autoRow = card.querySelector(".zone-auto-row");
    const globalAuto = autoState().enabled;
    const zoneAuto = z.auto; // {calling, suspended} for sensor zones
    autoRow.hidden = !(globalAuto && zoneAuto);
    if (!autoRow.hidden) {
      card.querySelector(".auto-tag").classList.add("active");
      const statusEl = card.querySelector(".auto-status");
      statusEl.textContent = zoneAuto.suspended
        ? `suspended: ${zoneAuto.suspended}`
        : zoneAuto.calling ? "calling for " + (state.local.info.mode === "cool" ? "cooling" : "heat") : "holding";
      statusEl.classList.toggle("warn", !!zoneAuto.suspended);
    }

    const sliderRow = card.querySelector(".zone-slider-row");
    sliderRow.classList.toggle("hidden", !isOpen || (globalAuto && !!zoneAuto));
    if (!state.interacting) {
      const slider = card.querySelector("input");
      slider.value = Number(z.value);
      slider.style.setProperty("--fill", `${Number(z.value)}%`);
      card.querySelector(".pct").textContent = `${Number(z.value)}%`;
    }
  }
}

async function sendAutoGlobal(patch) {
  try {
    const res = await fetch("/api/auto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.detail || res.statusText);
    state.remote = payload;
    if (payload.data) state.local = structuredClone(payload.data.aircons.ac1);
    render();
    if (patch.enabled === true) toast("Auto engaged — the dial now sets the target the house holds.");
    if (patch.enabled === false) toast("Auto off — you're flying manual.");
  } catch (err) {
    toast(err.message, true);
  }
}

function renderScenes() {
  const list = $("schedList");
  if (!state.scenes) { list.innerHTML = ""; return; }
  const order = state.scenes.scenesOrder || Object.keys(state.scenes.scenes || {});
  list.innerHTML = order.map((sid) => {
    const s = state.scenes.scenes[sid];
    if (!s) return "";
    const time = `${fmtClock(s.startTime)}–${s.airconStopTimeEnabled ? fmtClock(s.airconStopTime) : "…"}`;
    return `<div class="sched-row">
      <div>
        <div class="sched-name">${esc(s.name)}</div>
        <div class="sched-sub">${fmtDays(s.activeDays)} &middot; ${time}</div>
      </div>
      <span class="tag ${s.timerEnabled ? "en" : "off"}">${s.timerEnabled ? "Enabled" : "Off"}</span>
    </div>`;
  }).join("");
}
function fmtClock(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  const ampm = h >= 12 ? "pm" : "am";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}${ampm}`;
}
function fmtDays(mask) {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const on = names.filter((_, i) => mask & (1 << i));
  if (on.length === 7) return "every day";
  if (on.join() === "Mon,Tue,Wed,Thu,Fri") return "weekdays";
  if (on.join() === "Sun,Sat") return "weekends";
  return on.join(" ");
}

function renderHeader() {
  const info = state.local?.info;
  const badges = [];
  if (state.remote?.mock) badges.push('<span class="chip-sm warn">mock</span>');
  if (state.remote?.pending) badges.push('<span class="chip-sm warn">queued</span>');
  if (state.remote?.mqtt === false) badges.push('<span class="chip-sm warn">sensors offline</span>');
  if (autoState().enabled) {
    const zoneAutos = Object.values(state.local?.zones || {}).map((z) => z.auto).filter(Boolean);
    if (!zoneAutos.length || zoneAutos.every((a) => a.suspended)) {
      badges.push('<span class="chip-sm warn">auto suspended</span>');
    }
  }
  if (info?.filterCleanStatus) badges.push('<span class="chip-sm warn">filter due</span>');
  if (info?.airconErrorCode) badges.push(`<span class="chip-sm bad">err ${esc(info.airconErrorCode)}</span>`);
  $("badges").innerHTML = badges.join("");

  const sys = state.system;
  const chipEl = $("outdoorChip");
  // prefer live weather from the backend; fall back to the tablet's suburb
  // feed only when the tablet itself vouches for it
  let t = Number(state.remote?.outdoor);
  if (!isFinite(t) || state.remote?.outdoor == null) {
    t = sys?.isValidSuburbTemp ? Number(sys.suburbTemp) : NaN;
  }
  if (isFinite(t) && t > -25 && t < 55) {
    chipEl.hidden = false;
    chipEl.textContent = `${t.toFixed(1).replace(/\.0$/, "")}° outside`;
  } else {
    chipEl.hidden = true;
  }
}

const MODE_TITLES = { heat: "Heating today", cool: "Cooling today", vent: "Venting today", dry: "Drying today" };
const FILTER_WARN_HOURS = 200; // typical clean-the-return-filter interval

/* our own filter counter: unit runtime hours since the user last marked it
   cleaned (the tablet's built-in reminder is installer-configured and was
   never enabled on this system). Tap once to arm, tap again to reset. */
const filterUi = { confirm: false, timer: null };

function renderFilter(t) {
  const btn = $("filterBtn");
  if (t.filterRuntimeSeconds == null) { btn.hidden = true; return; }
  btn.hidden = false;
  if (filterUi.confirm) {
    btn.textContent = "mark filter cleaned?";
    btn.className = "lbl filter-btn confirm";
    return;
  }
  const hours = t.filterRuntimeSeconds / 3600;
  const shown = hours < 1 ? "<1h" : `${Math.round(hours)}h`;
  const due = hours >= FILTER_WARN_HOURS;
  const tabletDue = state.local?.info?.filterCleanStatus;
  btn.textContent = `filter ${shown} since clean${due ? " · clean soon" : ""}${tabletDue ? " · tablet says due" : ""}`;
  btn.className = `lbl filter-btn${due || tabletDue ? " warn" : ""}`;
}

async function markFilterCleaned() {
  try {
    const res = await fetch("/api/filter/cleaned", { method: "POST" });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    if (state.today) {
      state.today.filterRuntimeSeconds = data.filterRuntimeSeconds;
      state.today.filterCleanedAt = data.filterCleanedAt;
    }
    toast("Filter counter reset — nice work.");
  } catch (err) {
    toast(`Couldn't reset the filter counter: ${err.message}`, true);
  }
}

function renderToday() {
  const card = $("todayCard");
  const t = state.today;
  if (!t) { card.hidden = true; return; }
  card.hidden = false;

  const modes = Object.keys(t.byMode || {});
  $("todayTitle").textContent =
    modes.length === 1 ? (MODE_TITLES[modes[0]] || "Runtime today") : "Runtime today";
  $("todayRuntime").textContent = fmtMins(Math.round(t.runtimeSeconds / 60));

  const parts = [];
  if (modes.length > 1) {
    parts.push(modes.map((m) => `${m} ${fmtMins(Math.round(t.byMode[m] / 60))}`).join(" · "));
  }
  parts.push(`${t.cycles} ${t.cycles === 1 ? "cycle" : "cycles"}`);
  $("todaySub").textContent = parts.join(" · ");
  renderFilter(t);

  // hourly runtime strip: one bar per hour of today, height = minutes run
  const svg = $("spark");
  const byHour = new Map(t.hourly || []);
  const hours = Math.max(Number(t.hourNow) + 1 || 24, 1);
  const slot = 118 / 24;
  let out = `<line x1="1" x2="117" y1="35.5" y2="35.5" stroke="var(--ln)" stroke-width="1"/>`;
  for (let h = 0; h < 24; h++) {
    const sec = byHour.get(h) || 0;
    const x = (h * slot + 1).toFixed(1);
    if (sec > 0) {
      const barH = Math.max(3, (sec / 3600) * 30);
      out += `<rect x="${x}" y="${(34 - barH).toFixed(1)}" width="${(slot - 1.6).toFixed(1)}" height="${barH.toFixed(1)}" rx="1" fill="var(--acc)"/>`;
    } else if (h < hours) {
      out += `<rect x="${x}" y="33" width="${(slot - 1.6).toFixed(1)}" height="1.5" rx="0.75" fill="var(--dim)" opacity="0.35"/>`;
    }
  }
  svg.innerHTML = out;
}

function renderFoot() {
  const sys = state.system;
  if (!sys) return;
  const age = state.remote ? Math.round(state.remote.ageSeconds + (Date.now() - lastFetch) / 1000) : null;
  $("footInfo").innerHTML =
    `${esc(sys.name)} · ${esc(sys.tspIp || "")} · fw ${esc(String(sys.myAppRev || ""))}` +
    `<br>updated ${age != null ? age + "s ago" : "—"}` +
    (state.remote?.mock ? " · simulated tablet" : "") +
    (state.remote?.pending ? " · change queued, delivering when the tablet wakes" : "");
}

/* syncing cues: driven entirely by the server's unconfirmed-intent list */
function renderSyncCues() {
  document.querySelectorAll(".pending").forEach((el) => el.classList.remove("pending"));
  for (const path of state.remote?.recentPaths || []) {
    const key = path.join(".");
    let el = null;
    if (key === "info.setTemp") el = $("dial");
    else if (key === "info.mode") el = $("modeGrid");
    else if (key === "info.fan") el = $("fanChips");
    else if (key.startsWith("info.countDown")) el = $("timerChips");
    else if (key === "info.state") el = $("powerBtn");
    else if (path[0] === "zones") el = document.getElementById(`zone-${path[1]}`);
    el?.classList.add("pending");
  }
}

/* if an intent vanished without the state matching what we asked for,
   the tablet rejected/ignored it — say so once instead of silently flipping */
function checkReverts() {
  if (!state.remote || !state.local) return;
  const active = new Set((state.remote.recentPaths || []).map((p) => p.join(".")));
  for (const [key, sent] of state.sent) {
    if (Date.now() - sent.ts > 90000) { state.sent.delete(key); continue; }
    if (active.has(key)) continue;
    const current = key.split(".").reduce((n, k) => (n == null ? n : n[k]), state.local);
    const confirmed = key.includes("countDown")
      ? (sent.value === 0 ? !current : current > 0 && current <= sent.value)
      : current === sent.value;
    if (!confirmed && !state.remote.pending) {
      toast("The tablet didn't take that change — showing its actual state.", true);
    }
    state.sent.delete(key);
  }
}

function render() {
  if (!state.local) return;
  renderHero();
  renderZones();
  renderHeader();
  renderToday();
  renderSyncCues();
  renderFoot();
}

/* ================= networking ================= */

let lastFetch = Date.now();

function setDot(cls) { $("statusDot").className = `dot ${cls}`; }

async function fetchState(refresh = false) {
  try {
    const res = await fetch(`/api/state${refresh ? "?refresh=1" : ""}`);
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    const payload = await res.json();
    state.remote = payload;
    lastFetch = Date.now();
    state.local = structuredClone(payload.data.aircons.ac1);
    state.scenes = payload.data.myScenes;
    state.system = payload.data.system;
    setDot(payload.ok ? (payload.ageSeconds > 90 ? "stale" : "") : "down");
    checkReverts();
    render();
    renderScenes();
  } catch (err) {
    setDot("down");
    toast(`Can't reach the system: ${err.message}`, true);
  }
}

const ZONE_COLORS = ["var(--cool)", "var(--acc)", "var(--ok)"];

async function fetchTemps() {
  try {
    const res = await fetch("/api/temps?hours=24");
    if (res.ok) { state.temps = await res.json(); renderTemps(); }
  } catch { /* non-critical */ }
}

function renderTemps() {
  const card = $("tempsCard");
  const zones = Object.entries(state.temps?.zones || {})
    .filter(([, z]) => z.points.length >= 2)
    .sort(([a], [b]) => a.localeCompare(b));
  if (!zones.length) { card.hidden = true; return; }
  card.hidden = false;

  const svg = $("tempChart");
  const W = Math.max(svg.clientWidth || 300, 200), H = 120;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const now = Date.now() / 1000;
  const t0 = now - (state.temps.hours || 24) * 3600;
  const all = zones.flatMap(([, z]) => z.points.map((p) => p[1]));
  let lo = Math.min(...all), hi = Math.max(...all);
  const mid = (lo + hi) / 2;
  const span = Math.max(hi - lo, 2);
  lo = mid - span / 2 - 0.3; hi = mid + span / 2 + 0.3;

  const X = (ts) => 30 + ((ts - t0) / (now - t0)) * (W - 34);
  const Y = (v) => 8 + (1 - (v - lo) / (hi - lo)) * (H - 30);

  let out = "";
  for (const frac of [0.25, 0.5, 0.75]) {
    const v = lo + (hi - lo) * frac;
    out += `<line class="grid" x1="30" x2="${W - 4}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" opacity="0.5"/>`;
    out += `<text x="0" y="${(Y(v) + 3).toFixed(1)}">${v.toFixed(1)}&#176;</text>`;
  }
  zones.forEach(([, z], i) => {
    const pts = z.points.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ");
    const last = z.points[z.points.length - 1];
    out += `<polyline points="${pts}" stroke="${ZONE_COLORS[i % ZONE_COLORS.length]}"/>`;
    out += `<circle cx="${X(last[0]).toFixed(1)}" cy="${Y(last[1]).toFixed(1)}" r="3" fill="${ZONE_COLORS[i % ZONE_COLORS.length]}"/>`;
  });
  out += `<text x="30" y="${H - 2}">24h ago</text>`;
  out += `<text x="${W - 26}" y="${H - 2}">now</text>`;
  svg.innerHTML = out;

  $("tempsLegend").innerHTML = zones.map(([, z], i) => {
    const vals = z.points.map((p) => p[1]);
    return `<span><i style="background:${ZONE_COLORS[i % ZONE_COLORS.length]}"></i>${esc(z.name)} ${Math.min(...vals).toFixed(1)}&ndash;${Math.max(...vals).toFixed(1)}&deg;</span>`;
  }).join("");
}

async function fetchToday() {
  try {
    const res = await fetch("/api/today");
    if (res.ok) { state.today = await res.json(); renderToday(); }
  } catch { /* non-critical */ }
}

let confirmTimer = null;

async function sendChange(change, pendingEl = null) {
  if (change.info) Object.assign(state.local.info, change.info);
  if (change.zones) {
    for (const [zid, patch] of Object.entries(change.zones)) {
      Object.assign(state.local.zones[zid], patch);
    }
  }
  render();
  pendingEl?.classList.add("pending"); // instant cue while the POST is in flight
  try {
    const res = await fetch("/api/aircon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.detail || res.statusText);

    // remember what we asked for, so a rejected change can be surfaced honestly
    const now = Date.now();
    for (const [k, v] of Object.entries(change.info || {})) state.sent.set(`info.${k}`, { value: v, ts: now });
    for (const [zid, patch] of Object.entries(change.zones || {})) {
      for (const [k, v] of Object.entries(patch)) state.sent.set(`zones.${zid}.${k}`, { value: v, ts: now });
    }

    state.remote = payload;
    lastFetch = Date.now();
    if (payload.data) state.local = structuredClone(payload.data.aircons.ac1);
    if (payload.queued) {
      setDot("down");
      toast("Tablet is asleep — change queued, it will apply the moment it wakes.");
    } else {
      setDot("");
      // confirm quickly instead of waiting for the 20s poll
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => fetchState(true), 4000);
    }
    render();
  } catch (err) {
    toast(err.message, true);
    await fetchState(true);
  }
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast show${isError ? " err" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3400);
}

function commitDial() {
  clearTimeout(state.tempTimer);
  state.tempTimer = setTimeout(() => {
    if (autoState().enabled) {
      sendAutoGlobal({ target: state.remote.auto.target });
    } else {
      sendChange({ info: { setTemp: Math.round(state.local.info.setTemp) } }, $("dial"));
    }
  }, 600);
}

/* ================= wiring ================= */

function buildControls() {
  $("modeGrid").innerHTML = MODES.map((m) => `
    <button class="mode-pill" data-mode="${m.id}">
      <svg viewBox="0 0 24 24" ${m.fill
        ? 'fill="currentColor" stroke="none"'
        : 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'}>
        <path d="${m.d}"/>
      </svg>${m.label}
    </button>`).join("");
  $("fanChips").innerHTML = FANS.map(([id, label]) =>
    `<button class="chip-btn" data-fan="${id}">${label}</button>`).join("");
  $("timerChips").innerHTML = TIMERS.map(([mins, label]) =>
    `<button class="chip-btn" data-min="${mins}" data-label="${label}">${label}</button>`).join("");

  document.querySelectorAll(".mode-pill").forEach((b) => {
    b.addEventListener("click", () => sendChange({ info: { mode: b.dataset.mode } }, $("modeGrid")));
  });
  document.querySelectorAll("#fanChips .chip-btn").forEach((b) => {
    b.addEventListener("click", () => sendChange({ info: { fan: b.dataset.fan } }, b.parentElement));
  });
  document.querySelectorAll("#timerChips .chip-btn").forEach((b) => {
    b.addEventListener("click", () => {
      const active = b.classList.contains("active");
      if (active) {
        sendChange({ info: { countDownToOff: 0 } }, b.parentElement);
      } else {
        const info = { countDownToOff: Number(b.dataset.min) };
        if (state.local.info.state !== "on") info.state = "on";
        sendChange({ info }, b.parentElement);
      }
    });
  });

  $("tempDown").addEventListener("click", () => nudge(-1));
  $("tempUp").addEventListener("click", () => nudge(1));
  $("powerBtn").addEventListener("click", () => {
    sendChange({ info: { state: state.local.info.state === "on" ? "off" : "on" } }, $("powerBtn"));
  });
  $("autoBtn").addEventListener("click", () => {
    sendAutoGlobal({ enabled: !autoState().enabled });
  });
}

function nudge(direction) {
  if (!state.local) return;
  if (lock.locked) { lockedNudge(); return; }
  armRelock();
  const auto = autoState();
  const step = auto.enabled ? 0.5 : 1;
  const next = Math.max(TEMP_MIN, Math.min(TEMP_MAX, dialValue() + direction * step));
  if (auto.enabled) state.remote.auto.target = next;
  else state.local.info.setTemp = next;
  renderHero();
  commitDial();
}

function init() {
  initTheme();
  buildDial();
  buildControls();
  initDialLock();
  initDialDrag();
  $("filterBtn").addEventListener("click", async () => {
    if (filterUi.confirm) {
      clearTimeout(filterUi.timer);
      filterUi.confirm = false;
      await markFilterCleaned();
    } else {
      filterUi.confirm = true;
      filterUi.timer = setTimeout(() => { filterUi.confirm = false; renderFilter(state.today || {}); }, 4000);
    }
    renderFilter(state.today || {});
  });
  fetchState();
  fetchToday();
  fetchTemps();
  setInterval(() => {
    if (!document.hidden && !state.interacting) fetchState();
  }, POLL_MS);
  setInterval(fetchToday, 5 * 60 * 1000);
  setInterval(fetchTemps, 5 * 60 * 1000);
  setInterval(renderFoot, 5000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) fetchState(true);
  });
}

init();
