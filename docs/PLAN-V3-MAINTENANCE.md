# V3 — Maintenance & component health dashboard

**Goal:** answer two questions the wall tablet never could — *"is the system
still performing the way it used to?"* and *"which component is drifting,
before it fails?"* — from data the app already collects, plus one optional
hardware add-on for ground truth on power.

## What we can and cannot see

The tablet API exposes no compressor current, refrigerant pressure, or coil
temperatures. Everything in M0–M2 is therefore **inference from behaviour**:
temperature trajectories, cycle timing, damper positions, and reachability.
That is genuinely enough to catch the common failure modes early:

| Failure mode | Behavioural signature |
|---|---|
| Clogged return filter | heating rate at 100% damper declines week-over-week; longer runs for the same lift |
| Refrigerant loss / compressor wear | declining °C-per-hour at constant conditions, across all dampers |
| Short-cycling (control or hardware fault) | cycle-length distribution grows a spike at the short end |
| Duct leak / damper failure | one zone's rate collapses while the other's holds |
| Tablet decline | reachability %, empty-body rate, write-confirm latency all trend worse |
| Sensor decline | battery %, link quality, gaps between reports |

## M0 — data groundwork

The current `snapshots` table is enough for today's cards but not for trend
analysis. Add:

- **Outdoor temperature into every snapshot** (already fetched from
  Open-Meteo; currently displayed but not persisted). Rates are meaningless
  without the outdoor delta they were achieved against.
- **Write-confirm latency**: the intent overlay already knows when a write was
  sent and when the tablet's state confirmed it — persist that duration.
- **A nightly rollup job** into a `daily` table: runtime and cycles per mode,
  heating/cooling rate samples bucketed by (mode, damper band, outdoor band),
  tablet uptime %, sensor report counts and battery. Charts read rollups, not
  a million raw rows.
- Migration note: `snapshots` gains columns via `ALTER TABLE ... ADD COLUMN`
  (nullable, no rewrite).

## M1 — the Health view (read-only)

A second screen in the PWA (small nav affordance in the header; same design
tokens, cards in the established language):

- **Performance** — heating rate (°C/hour) at full damper vs outdoor delta,
  plotted against the rolling 30-day baseline band. The one-glance "is it
  getting weaker" chart.
- **Cycles** — daily cycle count and length distribution; short-cycle events
  flagged.
- **Recovery** — morning warm-up duration trend (scene start → target reached).
- **Runtime vs outdoor** — daily runtime plotted against mean outdoor temp;
  the scatter's slope is the house's real thermal cost curve.
- **Equipment** — tablet uptime %, empty-body rate, median write-confirm
  latency; per-sensor battery, link quality, report regularity.
- **Filter** — runtime-hours counter (exists) plus the performance-informed
  view: rate-at-100%-damper trend since last clean.
- **Errors** — any `airconErrorCode` / TSP error occurrences, with timestamps,
  ever recorded.

Backend: `GET /api/health/summary` (current vitals) and
`GET /api/health/trends?days=90` (rollup series). No new writes to the AC.

## M2 — baselines and drift alerts

- Rolling baselines per metric (median + IQR over trailing 30 days, same
  outdoor band).
- Drift detection: sustained excursion beyond the band for N days raises a
  condition — surfaced as a warn badge in the app header and a line on the
  Health view ("heating rate 18% below baseline for 5 days — check filter").
- Alert delivery beyond the app (ntfy/HomeKit notification) is a later choice;
  in-app first.

## M3 — optional hardware ground truth

A CT-clamp energy monitor on the AC circuit (Shelly EM or similar, local API)
adds real power draw:

- kWh per day/run; °C-gained-per-kWh efficiency trend — the definitive
  degradation metric, immune to weather normalisation errors.
- Compressor start-current signature trends (inrush creeping up = capacitor
  or bearing wear) if the monitor exposes fast sampling.
- Also finally makes the "Energy today" card literal, as the original design
  intended.

## Sequencing

M0 is a prerequisite and cheap (columns + one nightly task). M1 delivers the
dashboard Stefan asked for and is the bulk of the visible work. M2 turns it
from a chart into a watchdog. M3 is a purchase decision, independent of code
readiness.

Prerequisite for meaningful baselines: **weeks of M0 data**. Ship M0 early,
even if M1 waits — every week of persisted outdoor-correlated history makes
the eventual baselines better.
