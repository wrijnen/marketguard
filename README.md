# 🛑 StopLoss Alert — Live Stoploss Tracker Dashboard

A modern, self-hosted dashboard that recreates the core feature set of
[stoplossalert.nl](https://www.stoplossalert.nl/) (a Dutch "Live Stoploss Tracker"):
**track real stocks against a trailing stop-loss level, see which names are closest
to their stop first, and get alerts when levels are approached or breached.**

- **Repo:** https://github.com/wrijnen/marketguard
- **Live site (GitHub Pages):** https://wrijnen.github.io/marketguard/

> Not affiliated with or endorsed by stoplossalert.nl. Alerts are for **educational
> purposes only and do not constitute financial advice.**

![stack](https://img.shields.io/badge/stack-Node.js%20(zero%20deps)%20%2B%20vanilla%20JS-22c55e)

## Features (core of stoplossalert.nl, recreated)

- **Live stoploss tracker** — every watched stock gets a trailing stop-loss computed
  from its high-watermark close over a configurable lookback (3M / 6M / 1Y):
  `stop = max(close, lookback) × (1 − stop%)`. An ATR-based stop
  (`high − mult × ATR(14)`) is shown alongside.
- **Scanner sorted by distance** — "stocks within X% of their stoploss level, sorted
  by distance (closest first)", exactly like the original. Status chips:
  `SAFE / WATCH / NEAR STOP / BREACHED`.
- **Technical badges & filters** — 3M uptrend >10% / >20%, within 10% of top,
  above MA50 / MA200, Golden Cross (MA50 > MA200), low volatility <30%,
  safe buffer >10% above stop, and "recovered" (breached recently, back above stop).
- **Real stock data, no API key** — Yahoo Finance chart API → Nasdaq API →
  [Stooq](https://stooq.com) fallback chain (the chain matters: GitHub Actions runners are
  often rate-limited by Yahoo/Stooq, where the Nasdaq API still works), plus the keyless
  CNN **Fear & Greed Index** and VIX in the header. Default watchlist uses Nasdaq-listed
  tickers (incl. US ADRs for ASML, Shell, ING, Heineken).
- **Alerts** — create alerts per symbol: price drops below / rises above a level,
  "within X% of stop-loss", or "stop-loss breached". Evaluated server-side every
  60s and on demand; fires an in-app toast, a browser notification, and a persistent
  triggered-log. Alerts re-arm automatically after the condition clears.
- **Modern dashboard UI** — dark glassmorphism theme, sparkline cards, interactive
  chart with MA50/MA200 + dashed stop-loss line, scanner table with badge filter
  chips, responsive layout. Zero frontend dependencies (hand-rolled canvas charts).

Not included (require paid APIs on the original site): options-chain premium scanning
(cash-secured puts / covered calls) and AI sentiment analysis.

## Quick start

Requires Node.js ≥ 18. No `npm install` needed — zero dependencies.

```bash
npm start          # http://127.0.0.1:3000  (real market data)
npm run demo       # DEMO=1: synthetic data, works fully offline
npm test           # unit + API smoke tests (node --test)
```

Configuration via environment variables:

| Var    | Default     | Meaning                                   |
| ------ | ----------- | ----------------------------------------- |
| `PORT` | `3000`      | listen port                               |
| `HOST` | `127.0.0.1` | bind address (loopback by default)        |
| `DEMO` | off         | `1` = generate synthetic market data      |
| `DATA_DIR` | `./data`  | where settings/alerts/cache are persisted |

## How the stop-loss works

For each symbol, daily history is fetched and the snapshot computes:

- `stop = max(close over lookback) × (1 − stopPct/100)` — trailing, ratchets up only
- `stopATR = max(high over lookback) − atrMult × ATR(14)` — volatility-based alt
- `distance% = (close − stop) / close × 100` — negative means **breached**
- indicators: MA50, MA200, Golden Cross, 3M trend, % from lookback high,
  30-day annualized volatility, ATR(14)

The scanner sorts ascending by `distance%`, so names closest to their stop are on top.

## API

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET  | `/api/health` | status + demo flag |
| GET/PUT | `/api/settings` | stop %, lookback, ATR mult, alert threshold, universe |
| GET  | `/api/scan` | all symbols with quote + snapshot, sorted by distance to stop |
| GET  | `/api/quote?symbols=A,B` | latest quotes |
| GET  | `/api/history/:symbol?range=1y` | daily OHLCV for charts |
| GET  | `/api/sentiment` | CNN Fear & Greed + VIX |
| GET/POST | `/api/alerts` | list / create alert |
| DELETE | `/api/alerts/:id` | delete alert |
| POST | `/api/alerts/:id/ack` | acknowledge a triggered alert |
| POST | `/api/evaluate` | force alert evaluation, returns newly fired alerts |

Alert body: `{ "symbol": "AAPL", "type": "below|above|near_stop|stop_breach", "value": 150, "note": "…" }`
(`value` omitted for `stop_breach`.)

## 🌐 GitHub Pages (hosted, no server needed)

The same dashboard runs as a **static site on GitHub Pages** at
https://wrijnen.github.io/marketguard/ :

- **Active refresh mechanism: a scheduled GitHub Action.** `.github/workflows/update-data.yml`
  runs **every 5 minutes on weekdays 13–22 UTC** (≈ 09:00–17:00 ET / 15:00–23:00 CET), every 30 min
  otherwise, on every push to the default branch, and on manual dispatch. It runs
  `server/export.js` on GitHub's runners and commits JSON snapshots to the `gh-pages` branch
  (`data/scan.json`, `data/history/*.json`, `data/sentiment.json`, …).
  (Direct client-side fetching from the browser — Yahoo → Stooq — is **not** used: those APIs
  send no CORS headers, so a browser cannot call them. The Action is the live path.)
- The page revalidates `data/index.json` every 60 s and hot-reloads when a data commit lands,
  so the screen is at most ~6 minutes behind the workflow during market hours. The header
  shows a visible **"updated hh:mm, N min ago · source"** stamp and a **stale-data warning**
  when the snapshot is older than 15 minutes.
- Quotes carry their own timestamp and source (`cnbc` real-time where available, else the
  latest session close via `nasdaq`), so any number on screen can be compared against a live
  quote within the stated delay. Per-row "as of" times are shown in the tables/cards.
- The static frontend recomputes stop-loss levels, badges and the scanner client-side from the
  history files.
- Alerts on the Pages build are stored in your browser (`localStorage`) and evaluated
  client-side every 30 s **while the page is open**; browser notifications and digests
  (daily 17:45, weekly Friday 16:30) are delivered in-app. Email delivery is not configured.
- Enable Pages once: **Settings → Pages → Build and deployment → Source: "Deploy from a branch" → branch `gh-pages`, folder `/ (root)` → Save.**
- The workflow needs **Settings → Actions → General → Workflow permissions → "Read and write permissions"** so it can push data commits to `gh-pages`.
- Scheduled runs execute on the repo's default branch. Trigger a manual refresh anytime from the **Actions** tab ("Update Pages market data" → "Run workflow").
- To regenerate the data locally: `node server/export.js --out public/data` (add `DEMO=1` for synthetic data without network).

## Project layout

```
server/
  index.js       zero-dependency HTTP server + routes (binds 127.0.0.1 by default)
  data.js        market data layer: quotes stooq -> cnbc -> latest close; history yahoo -> nasdaq -> stooq
  export.js      exports static JSON data (data/*.json) for the GitHub Pages build
  indicators.js  re-exports the shared math module
  alerts.js      persistent alert store + evaluation state machine (server mode)
  demo.js        seeded synthetic data for offline demo mode
  universe.js    default watchlist (tickers verified on the Nasdaq API + CNBC quotes)
public/          dashboard SPA (vanilla JS + canvas charts, no build step);
                 runs against the local API (npm start) or as a static Pages site
                 (public/indicators.js is the shared math module used by both)
.github/workflows/update-data.yml  scheduled market-data refresh for gh-pages
test/            node:test suites (indicators, alerts incl. recovery type, export, API smoke via DEMO mode)
data/            runtime persistence (gitignored)
```

## Design

Custom modern dashboard theme (`public/styles.css`): dark neutral surfaces, Inter for UI
text and Space Grotesk for display/figures, and a semantic status colour system —
green `safe`, amber `near`, red `breach` (breached rows are highlighted, never dimmed).
Positions render as cards with a sparkline that draws the stop-loss level as a dashed line;
the scanner is a roomy table with a rescaled 0–30% distance bar and a tick at the alert
threshold; note tags are capped at three per row with a "+N" overflow. Layout is responsive
down to phones. Earlier iterations used Hallmark (Nutlope) themes; the current look is
custom per request.

## Data sources & disclaimer

Quotes: Stooq live → CNBC real-time → latest session close (Nasdaq/Yahoo history), each quote
tagged with its source and timestamp. History: Yahoo Finance → Nasdaq API → Stooq, first
success wins (per-file `meta.source`). Sentiment: CNN Fear & Greed Index public endpoint.
All unofficial, free, no API key; figures may be delayed — the header stamp states exactly
when the snapshot was taken and from which source. This tool provides alerts for
**educational purposes only and does not constitute financial advice**.
