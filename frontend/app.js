/* e-zone control app */
"use strict";

const MODES = {
  heat: { rgb: "240, 135, 72",  hex: "#F08748", label: "heating" },
  cool: { rgb: "88, 168, 206",  hex: "#58A8CE", label: "cooling" },
  vent: { rgb: "99, 191, 163",  hex: "#63BFA3", label: "fan only" },
  dry:  { rgb: "200, 164, 94",  hex: "#C8A45E", label: "drying" },
};
const TEMP_MIN = 16, TEMP_MAX = 32;
const POLL_MS = 15000;

const $ = (id) => document.getElementById(id);

const state = {
  remote: null,        // last server payload ({ok, ageSeconds, mock, data})
  local: null,         // optimistic copy of data.aircons.ac1
  scenes: null,
  system: null,
  tempTimer: null,     // debounce for setTemp stepper
  interacting: false,  // true while a slider is being dragged
};

/* ---------------- dial geometry ---------------- */

const DIAL = { cx: 150, cy: 150, r: 118, start: 150, sweep: 240 };

function polar(angleDeg, radius) {
  const a = (angleDeg * Math.PI) / 180;
  return [DIAL.cx + radius * Math.cos(a), DIAL.cy + radius * Math.sin(a)];
}
function arcPath(fromDeg, toDeg, radius) {
  const [x1, y1] = polar(fromDeg, radius);
  const [x2, y2] = polar(toDeg, radius);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2}`;
}
function tempAngle(t) {
  return DIAL.start + ((t - TEMP_MIN) / (TEMP_MAX - TEMP_MIN)) * DIAL.sweep;
}

function buildDial() {
  const ticks = $("dialTicks");
  let html = "";
  for (let t = TEMP_MIN; t <= TEMP_MAX; t++) {
    const angle = tempAngle(t);
    const major = t % 4 === 0;
    const [x1, y1] = polar(angle, DIAL.r + (major ? -14 : -11));
    const [x2, y2] = polar(angle, DIAL.r - 18);
    html += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${major ? 'opacity="1"' : 'opacity="0.45"'}/>`;
    if (major) {
      const [tx, ty] = polar(angle, DIAL.r - 32);
      html += `<text x="${tx}" y="${ty}" text-anchor="middle" dominant-baseline="middle">${t}</text>`;
    }
  }
  ticks.innerHTML = html;
  $("dialTrack").setAttribute("d", arcPath(DIAL.start, DIAL.start + DIAL.sweep, DIAL.r));
}

function renderDial(setTemp) {
  const end = tempAngle(setTemp);
  $("dialArc").setAttribute("d", arcPath(DIAL.start, Math.max(end, DIAL.start + 0.5), DIAL.r));
  const [tx, ty] = polar(end, DIAL.r);
  const tip = $("dialTip");
  tip.setAttribute("cx", tx);
  tip.setAttribute("cy", ty);
}

/* ---------------- rendering ---------------- */

function render() {
  const ac = state.local;
  if (!ac) return;
  const info = ac.info;
  const on = info.state === "on";
  const mode = MODES[info.mode] ? info.mode : "heat";

  document.body.classList.toggle("is-on", on);
  document.body.classList.toggle("is-off", !on);
  document.documentElement.style.setProperty("--accent", MODES[mode].hex);
  document.documentElement.style.setProperty("--accent-rgb", MODES[mode].rgb);

  $("setTemp").textContent = Math.round(info.setTemp);
  $("dialMode").textContent = on ? MODES[mode].label : "standby";
  $("dialLabel").textContent = info.mode === "vent" || info.mode === "dry" ? "mode" : "set to";
  $("powerLabel").textContent = on ? "on" : "off";
  renderDial(info.setTemp);

  document.querySelectorAll("#modeSeg .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === info.mode);
    b.setAttribute("aria-checked", String(b.dataset.mode === info.mode));
  });
  document.querySelectorAll("#fanSeg .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.fan === info.fan);
  });

  renderZones(ac, on);
  renderTimer(info, on);
  renderBadges(info);
  renderFoot();
}

function fmtDur(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function renderTimer(info, on) {
  const status = $("timerStatus");
  const off = Number(info.countDownToOff) || 0;
  const toOn = Number(info.countDownToOn) || 0;
  if (off > 0) {
    status.hidden = false;
    status.innerHTML =
      `auto-off in ${fmtDur(off)} <button class="link-btn" id="timerCancel">cancel</button>`;
  } else if (toOn > 0) {
    status.hidden = false;
    status.innerHTML =
      `auto-on in ${fmtDur(toOn)} <button class="link-btn" id="timerCancel">cancel</button>`;
  } else {
    status.hidden = true;
    status.innerHTML = "";
  }
  const cancel = document.getElementById("timerCancel");
  if (cancel) {
    cancel.addEventListener("click", () =>
      sendChange({ info: { countDownToOff: 0, countDownToOn: 0 } }, status));
  }
  document.querySelectorAll("#timerChips .seg-btn").forEach((b) => {
    b.classList.toggle("active", off > 0 && Number(b.dataset.min) === off);
  });
}

function zoneIds(ac) {
  return Object.keys(ac.zones).sort();
}

function renderZones(ac, on) {
  const list = $("zoneList");
  const ids = zoneIds(ac);
  const openCount = ids.filter((z) => ac.zones[z].state === "open").length;

  for (const zid of ids) {
    const z = ac.zones[zid];
    let card = document.getElementById(`zone-${zid}`);
    if (!card) {
      card = document.createElement("div");
      card.id = `zone-${zid}`;
      card.className = "zone";
      card.innerHTML = `
        <div>
          <div class="zone-name"></div>
          <div class="zone-sub"></div>
        </div>
        <div class="zone-temp"></div>
        <button class="switch" role="switch" aria-label="zone open"></button>
        <div class="zone-slider-row">
          <input type="range" min="5" max="100" step="5" aria-label="damper percentage">
          <span class="zone-sub pct-out"></span>
        </div>`;
      list.appendChild(card);

      card.querySelector(".switch").addEventListener("click", () => {
        const zone = state.local.zones[zid];
        const target = zone.state === "open" ? "close" : "open";
        sendChange({ zones: { [zid]: { state: target } } }, card);
      });
      const slider = card.querySelector("input");
      slider.addEventListener("input", () => {
        state.interacting = true;
        card.querySelector(".pct-out").innerHTML = `<span class="pct">${slider.value}%</span>`;
        slider.style.setProperty("--fill", `${slider.value}%`);
      });
      slider.addEventListener("change", () => {
        state.interacting = false;
        sendChange({ zones: { [zid]: { value: Number(slider.value) } } }, card);
      });
    }

    const isOpen = z.state === "open";
    card.classList.toggle("open", isOpen && on);
    card.querySelector(".zone-name").textContent = z.name;

    const tempEl = card.querySelector(".zone-temp");
    const s = z.sensor;
    if (s && s.temperature != null) {
      tempEl.classList.toggle("stale", !!s.stale);
      tempEl.innerHTML =
        `<span class="t">${Number(s.temperature).toFixed(1)}&deg;</span>` +
        `<span class="rh">${s.stale
          ? `stale ${fmtDur(Math.max(1, Math.round(s.ageSeconds / 60)))}`
          : `${Math.round(Number(s.humidity))}% rh${Number(s.battery) <= 20 ? " · batt!" : ""}`}</span>`;
    } else {
      tempEl.innerHTML = `<span class="rh">no sensor</span>`;
    }
    card.querySelector(".zone-sub").innerHTML = isOpen
      ? `damper <span class="pct">${Number(z.value)}%</span>`
      : "closed";
    const sw = card.querySelector(".switch");
    sw.classList.toggle("on", isOpen);
    sw.setAttribute("aria-checked", String(isOpen));
    // guard: while the system is on, the last open zone cannot close
    sw.disabled = on && isOpen && openCount === 1;
    sw.title = sw.disabled ? "At least one zone must stay open while the system is on" : "";

    const sliderRow = card.querySelector(".zone-slider-row");
    sliderRow.classList.toggle("hidden", !isOpen);
    if (!state.interacting) {
      const slider = card.querySelector("input");
      slider.value = Number(z.value);
      slider.style.setProperty("--fill", `${Number(z.value)}%`);
      card.querySelector(".pct-out").innerHTML = `<span class="pct">${Number(z.value)}%</span>`;
    }
  }
}

function renderScenes() {
  const list = $("sceneList");
  if (!state.scenes) { list.innerHTML = ""; return; }
  const order = state.scenes.scenesOrder || Object.keys(state.scenes.scenes || {});
  list.innerHTML = order.map((sid) => {
    const s = state.scenes.scenes[sid];
    if (!s) return "";
    const time = `${fmtTime(s.startTime)}–${s.airconStopTimeEnabled ? fmtTime(s.airconStopTime) : "…"}`;
    const days = fmtDays(s.activeDays);
    return `<div class="scene">
      <div>
        <div class="scene-name">${esc(s.name)}</div>
        <div class="scene-sub">${days} · ${time}</div>
      </div>
      <span class="chip ${s.timerEnabled ? "en" : "dis"}">${s.timerEnabled ? "enabled" : "off"}</span>
    </div>`;
  }).join("");
}

function fmtTime(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  const ampm = h >= 12 ? "pm" : "am";
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${String(m).padStart(2, "0")}${ampm}`;
}
function fmtDays(mask) {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const on = names.filter((_, i) => mask & (1 << i));
  if (on.length === 7) return "every day";
  if (on.join() === "Mon,Tue,Wed,Thu,Fri") return "weekdays";
  if (on.join() === "Sun,Sat") return "weekends";
  return on.join(" ");
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function renderBadges(info) {
  const badges = [];
  if (state.remote?.mock) badges.push('<span class="badge warn">mock</span>');
  if (state.remote?.pending) badges.push('<span class="badge warn">queued</span>');
  if (state.remote?.mqtt === false) badges.push('<span class="badge warn">sensors offline</span>');
  if (info.filterCleanStatus) badges.push('<span class="badge warn">filter due</span>');
  if (info.airconErrorCode) badges.push(`<span class="badge bad">err ${esc(info.airconErrorCode)}</span>`);
  $("topBadges").innerHTML = badges.join("");
}

function renderFoot() {
  const sys = state.system;
  if (!sys) return;
  const age = state.remote?.ageSeconds;
  $("footInfo").innerHTML =
    `${esc(sys.name)} · ${esc(sys.tspIp || "")} · fw ${esc(String(sys.myAppRev || ""))}` +
    `<br>updated ${age != null ? Math.round(age) + "s ago" : "—"}` +
    (state.remote?.mock ? " · simulated tablet (mock mode)" : "") +
    (state.remote?.pending
      ? `<br>change queued ${Math.round(state.remote.pendingAgeSeconds)}s ago — delivering when the tablet wakes`
      : "");
}

function setStatusDot(cls) {
  $("statusDot").className = `brand-mark ${cls}`;
}

/* ---------------- networking ---------------- */

async function fetchState(refresh = false) {
  try {
    const res = await fetch(`/api/state${refresh ? "?refresh=1" : ""}`);
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    const payload = await res.json();
    state.remote = payload;
    state.local = structuredClone(payload.data.aircons.ac1);
    state.scenes = payload.data.myScenes;
    state.system = payload.data.system;
    setStatusDot(payload.ok ? (payload.ageSeconds > 90 ? "stale" : "live") : "down");
    render();
    renderScenes();
  } catch (err) {
    setStatusDot("down");
    toast(`Can't reach the system: ${err.message}`, true);
  }
}

async function sendChange(change, pendingEl = null) {
  // optimistic local apply
  if (change.info) Object.assign(state.local.info, change.info);
  if (change.zones) {
    for (const [zid, patch] of Object.entries(change.zones)) {
      Object.assign(state.local.zones[zid], patch);
    }
  }
  render();
  pendingEl?.classList.add("pending");
  try {
    const res = await fetch("/api/aircon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.detail || res.statusText);
    state.remote = payload;
    if (payload.data) state.local = structuredClone(payload.data.aircons.ac1);
    if (payload.queued) {
      setStatusDot("down");
      toast("Tablet is asleep — change queued, it will apply the moment it wakes.");
    } else {
      setStatusDot("live");
    }
    render();
  } catch (err) {
    toast(err.message, true);
    await fetchState(true); // revert to the tablet's truth
  } finally {
    pendingEl?.classList.remove("pending");
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

/* ---------------- wiring ---------------- */

function nudgeTemp(delta) {
  const info = state.local.info;
  info.setTemp = Math.max(TEMP_MIN, Math.min(TEMP_MAX, Math.round(info.setTemp) + delta));
  render();
  clearTimeout(state.tempTimer);
  state.tempTimer = setTimeout(() => {
    sendChange({ info: { setTemp: state.local.info.setTemp } }, $("dial").parentElement);
  }, 650);
}

function init() {
  buildDial();
  $("tempUp").addEventListener("click", () => nudgeTemp(1));
  $("tempDown").addEventListener("click", () => nudgeTemp(-1));
  $("powerBtn").addEventListener("click", () => {
    const target = state.local.info.state === "on" ? "off" : "on";
    sendChange({ info: { state: target } }, $("powerBtn"));
  });
  document.querySelectorAll("#modeSeg .seg-btn").forEach((b) => {
    b.addEventListener("click", () => sendChange({ info: { mode: b.dataset.mode } }, b.parentElement));
  });
  document.querySelectorAll("#fanSeg .seg-btn").forEach((b) => {
    b.addEventListener("click", () => sendChange({ info: { fan: b.dataset.fan } }, b.parentElement));
  });
  document.querySelectorAll("#timerChips .seg-btn").forEach((b) => {
    b.addEventListener("click", () => {
      const mins = Number(b.dataset.min);
      const info = { countDownToOff: mins };
      if (state.local.info.state !== "on") info.state = "on"; // "run for X" from standby
      sendChange({ info }, b.parentElement);
    });
  });

  fetchState();
  setInterval(() => {
    if (!document.hidden && !state.interacting) fetchState();
  }, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) fetchState(true);
  });
}

init();
