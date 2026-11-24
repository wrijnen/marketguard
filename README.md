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
  `stop = max(close, lookback) × (1 − stop%)`, applied to **split-adjusted** prices.
  An ATR-based stop (`high − mult × ATR(14)`) is shown alongside. The stop rule is
  printed on screen in plain words, with a tooltip explaining the ratchet/reset behaviour
  (see below). Per-symbol stop % can be edited with the ✎ button next to each stop-loss.
- **Scanner sorted by distance** — "stocks within X% of their stoploss level, sorted
  by distance (closest first)", exactly like the original. The wide market scan covers
  **49 names** — US, EU (ADRs), Asia (ADRs + Tokyo), India, ETFs, crypto and indices —
  with **category** (stock/ETF/crypto/index) and **region** (US/EU/Asia/India) filters,
  and a **Track** button to add any result to the Dashboard. Rows are grouped into
  clearly labelled sections: **Check data / Breached / Near stop (≤ threshold) /
  Watch (≤10%) / Safe (>10%)**, using the exact same status function as the Dashboard
  cards, so counts always agree. Status chips: `SAFE / WATCH / NEAR STOP / BREACHED /
  CHECK DATA` (a stop more than 40% from price is flagged "Check data" — usually an
  unadjusted split; history is auto split-adjusted, so this should be rare).
- **Breach history tab** — breaches, recoveries and stop resets over the past year,
  computed from daily history: date, symbol, event, price, stop at the time, and the
  history source per row.
- **Technical badges & filters** — 3M uptrend >10% / >20%, within 10% of top,
  above MA50 / MA200, Golden Cross (MA50 > MA200), low volatility <30%,
  safe buffer >10% above stop, and "recovered" (breached recently, back above stop).
  Badges remain filterable via chips.
- **Real market data, no API key** — quotes: **CNBC real-time → Yahoo v7 → Stooq →
  latest session close**; history: **Yahoo adjusted close → Nasdaq API → Stooq**, crypto
  via **CoinGecko**, indices quoted real-time from CNBC with history from a proxy ETF
  (SPY/DIA/QQQ/VIXY) rescaled to the index level. Every quote shows its own
  **freshness (Live / Delayed 15m), source and timestamp**, and every price shows its
  **currency** (ASML, ING, Shell etc. are US ADR listings in USD — the UI says so).
  CNN **Fear & Greed Index** and VIX sit in the header.
- **Alerts** — create/edit/delete alerts per symbol: price drops below / rises above a
  level, "within X% of stop-loss", "stop-loss breached", or "recovery above stop", with
  delivery real-time, daily digest 17:45 or weekly digest Friday 16:30. Rules and the
  triggered log persist across reloads (server: `data/alerts.json`; Pages: browser
  `localStorage`). Alerts **only run while the page is open** — there is no email/SMS
  delivery; digests and browser notifications are delivered in-app.
- **Modern dashboard UI** — dark/light toggle, sparkline cards, interactive chart with
  MA50/MA200 + dashed stop-loss line, grouped scanner table that becomes a card list on
  phones, sort/filter bar (All/Breached/Near/Watch/Safe/Check, closest-to-stop first),
  keyboard navigation (arrow keys across tabs, Enter on a row opens its chart, Esc closes
  dialogs), status always labelled with text (never colour alone). Zero frontend
  dependencies (hand-rolled canvas charts).

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

## How the stop-loss works (and the ratchet-vs-reset choice)

For each symbol, daily history is fetched, **split-adjusted** (a day-over-day jump that
matches a round split factor — 2:1, 3:1, 10:1, … — rescales all earlier prices into the
new unit, the same idea as Yahoo's adjusted close), and the snapshot computes:

- `stop = max(close over lookback) × (1 − stopPct/100)` — trailing stop
- `stopATR = max(high over lookback) − atrMult × ATR(14)` — volatility-based alt
- `distance% = (close − stop) / close × 100` — negative means **breached**
- status: `|dist| > 40%` → **Check data** (data-sanity guard), `dist ≤ 0` → **Breached**,
  `≤ threshold%` → **Near stop**, `≤ 10%` → **Watch**, else **Safe**
- indicators: MA50, MA200, Golden Cross, 3M trend, % from lookback high,
  30-day annualized volatility, ATR(14)

**Ratchet vs reset after a breach (MarketGuard-style):** the stop **ratchets up** with new
highs and never moves down while that high is inside the lookback window; it only **steps
down ("resets") when the old high ages out of the window** — those resets are listed in the
History tab. A breach does **not** lower the stop: a breached position stays "Breached"
until the price recovers above the stop (logged as a *recovery*). The scanner sorts
ascending by `distance%`, so names closest to their stop are on top.

## API

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET  | `/api/health` | status + demo flag |
| GET/PUT | `/api/settings` | stop %, lookback, ATR mult, alert threshold, universe, per-symbol `stops` map |
| GET  | `/api/scan?scope=all\|tracked` | scanned rows (default `all` = 49-name market scan; `tracked` = dashboard watchlist) with quote + snapshot, sorted by distance to stop |
| GET  | `/api/quote?symbols=A,B` | latest quotes (each with `source`, `asOf`, `realTime`, `currency`) |
| GET  | `/api/history/:symbol?range=1y` | daily OHLCV for charts (+ breach/recovery/reset events are derived client-side) |
| GET  | `/api/sentiment` | CNN Fear & Greed + VIX |
| GET/POST | `/api/alerts` | list / create alert |
| PATCH | `/api/alerts/:id` | edit an existing alert (same validation as create) |
| DELETE | `/api/alerts/:id` | delete alert |
| POST | `/api/alerts/:id/ack` | acknowledge a triggered alert |
| POST | `/api/evaluate` | force alert evaluation, returns newly fired alerts |

Alert body: `{ "symbol": "AAPL", "type": "below|above|near_stop|stop_breach|recovery", "value": 150, "note": "…", "schedule": "realtime|daily|weekly" }`
(`value` omitted for `stop_breach`/`recovery`.)

## 🌐 GitHub Pages (hosted, no server needed)

The same dashboard runs as a **static site on GitHub Pages** at
https://wrijnen.github.io/marketguard/ :

- **Active refresh mechanism: a scheduled GitHub Action.** `.github/workflows/update-data.yml`
  runs **every 5 minutes on weekdays 13–22 UTC** (≈ 09:00–17:00 ET / 15:00–23:00 CET), every 30 min
  otherwise, on every push to the default branch, and on manual dispatch. It runs
  `server/export.js` on GitHub's runners and commits JSON snapshots to the `gh-pages` branch
  (`data/scan.json` + `data/scan-all.json`, `data/history/*.json`, `data/sentiment.json`,
  `data/health.json`, `data/index.json`).
  (Direct client-side fetching from the browser — Yahoo → Stooq — is **not** used: those APIs
  send no CORS headers, so a browser cannot call them. The Action is the live path.)
- **Fails loudly:** the export writes `data/health.json` with per-source success/error counts
  (`historyBySource`, `quotesBySource`) and exits **1 when zero symbols could be fetched**, so a
  broken source turns the Action run red instead of silently shipping empty data. If a single
  symbol's history fetch fails but a previous `gh-pages` file exists, the cached file is reused
  and marked `cached: true` (recorded in `health.json` errors) — one flaky upstream never blanks
  the site. The winning source per quote is stored on the quote (`quote.source`: `cnbc` / `yahoo`
  / `stooq` / `coingecko` / `*-close`) and shown per row in the UI.
- The page revalidates `data/index.json` every 60 s and hot-reloads when a data commit lands,
  so the screen is at most ~6 minutes behind the workflow during market hours. The header
  shows a visible **"updated hh:mm, N min ago · source"** stamp and a **stale-data warning**
  when the snapshot is older than 15 minutes.
- Quotes carry their own timestamp, source and freshness (`Live` when real-time, otherwise
  `Delayed 15m`), shown per row in the tables/cards, so any number on screen can be compared
  against a live quote within the stated delay. The header keeps a visible
  **"updated hh:mm, N min ago · source"** stamp plus a **stale-data warning** past 15 minutes.
- The static frontend recomputes stop-loss levels (including your local per-symbol stop
  overrides), statuses, badges and sparklines client-side from the history files.
- Alerts on the Pages build are stored in your browser (`localStorage`) and evaluated
  client-side every 30 s **while the page is open**; browser notifications and digests
  (daily 17:45, weekly Friday 16:30) are delivered in-app. **Limits: alerts only fire while
  the page is open, and there is no email/SMS/push delivery** — the banner on the Alerts tab
  says so explicitly.
- Enable Pages once: **Settings → Pages → Build and deployment → Source: "Deploy from a branch" → branch `gh-pages`, folder `/ (root)` → Save.**
- The workflow needs **Settings → Actions → General → Workflow permissions → "Read and write permissions"** so it can push data commits to `gh-pages`.
- Scheduled runs execute on the repo's default branch. Trigger a manual refresh anytime from the **Actions** tab ("Update Pages market data" → "Run workflow").
- To regenerate the data locally: `node server/export.js --out public/data` (add `DEMO=1` for synthetic data without network).

## Project layout

```
server/
  index.js       zero-dependency HTTP server + routes (binds 127.0.0.1 by default)
  data.js        market data layer: quotes CNBC -> Yahoo v7 -> Stooq -> latest close
                 (crypto: CoinGecko; indices: CNBC quote + proxy-ETF history scaled to index level);
                 history Yahoo adjusted close -> Nasdaq API -> Stooq (crypto: CoinGecko)
  export.js      exports static JSON data (data/*.json) for the GitHub Pages build,
                 writes health.json and exits 1 if no symbol could be fetched (fail loud)
  indicators.js  re-exports the shared math module
  alerts.js      persistent alert store + evaluation state machine + edit (PATCH) (server mode)
  demo.js        seeded synthetic data for offline demo mode
  universe.js    default watchlist + 49-entry market scan with category/region metadata
public/          dashboard SPA (vanilla JS + canvas charts, no build step);
                 runs against the local API (npm start) or as a static Pages site
                 (public/indicators.js is the shared math module used by both:
                  stop math, split adjustment, breach/recovery/reset events, statuses)
.github/workflows/update-data.yml  scheduled market-data refresh for gh-pages (5-min weekdays)
test/            node:test suites (indicators incl. split-adjusted + breach/reset/check cases,
                 alerts incl. recovery + PATCH, export, API smoke via DEMO mode)
data/            runtime persistence (gitignored)
```

## Design

Custom modern dashboard theme (`public/styles.css`) with a **light/dark toggle**: neutral
surfaces, Inter for UI text and Space Grotesk for display/figures, and a semantic status
colour system — green `safe`, amber `near`/`watch`, red `breach`, purple `check data`
(breached rows are highlighted, never dimmed; every status also has a text label).
Positions render as cards with a sparkline that draws the stop-loss level as a dashed line;
the scanner is a roomy, grouped table with a rescaled 0–30% distance bar and a tick at the
alert threshold — and becomes a card list on phone widths. Note tags are capped at three
per row with a "+N" overflow. Earlier iterations used Hallmark (Nutlope) themes; the
current look is custom per request.

## Data sources & disclaimer

Quotes (first success wins, winner stored per quote as `source`): **CNBC** real-time →
**Yahoo Finance v7** → **Stooq** → latest session close from history. Crypto (BTC/ETH/SOL/XRP/ADA-USD)
via **CoinGecko**. Indices (`.SPX/.DJI/.IXIC/.VIX`) quote real-time from CNBC; their daily
history comes from a proxy ETF (SPY/DIA/QQQ/VIXY) rescaled to the index level, marked
`nasdaq-proxy` in the file meta. History: **Yahoo Finance adjusted close → Nasdaq API →
Stooq**, first success wins (per-file `meta.source`), with split adjustment applied on top
(`adjustSplits` in `public/indicators.js`). Sentiment: CNN Fear & Greed Index public endpoint.
All unofficial, free, no API key; figures may be delayed — every quote and the header stamp
state exactly when data was taken and from which source. This tool provides alerts for
**educational purposes only and does not constitute financial advice**.
