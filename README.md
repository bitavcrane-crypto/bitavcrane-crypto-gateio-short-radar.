# Gate.io speculative-pump and short radar

A dependency-free, read-only browser dashboard for monitoring Gate.io USDT perpetual contracts. The radar scans the available ticker list, analyzes closed 15-minute candles, and ranks possible short setups using price structure, volume, momentum, open interest, and funding where the exchange provides those values.

## Run

Serve this directory with any static HTTP server, then open its address in a modern browser. For example:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000`. A local server is needed because browsers generally do not load JavaScript modules from `file://` URLs. The dashboard makes read-only public requests to `https://fx-api.gateio.ws/api/v4`; API availability and browser CORS support depend on Gate.io and your network.

## What the radar does

- Loads Gate.io USDT futures tickers and scans active contracts in rotation for closed 15-minute candles. Candles are requested with bounded concurrency; a refresh can take time for a large market list.
- Uses 15-minute candles as its primary timeframe and completed 5-minute candles as an additional confirmation when available. 1-hour and 4-hour changes are calculated from the 15-minute candle history.
- Shows the pump move, relative volume, MACD momentum, OBV confirmation, upper-wick rejection, local support, funding, and open-interest change when that data is returned.
- Separates overheated/weakening setups from a reversal watch and a short candidate. A candidate requires a closed-candle support break plus a bearish close; heat alone does not qualify.
- Displays the support-break trigger and recent-high invalidation, a transparent 0–100 score, reasons, and outstanding confirmation.
- Supports custom contract watchlist entries, score sorting, periodic refresh, and browser notifications for stage changes.

## Data and limitations

Data comes from Gate.io's public API v4 endpoints:

- `GET /futures/usdt/tickers`
- `GET /futures/usdt/candlesticks`
- `GET /futures/usdt/contract_stats` (open-interest history, when returned)

Funding is read from each ticker response when available. The dashboard labels each source and fetch time; unavailable values are shown as unavailable rather than inferred. Volume anomaly is the last completed 15-minute candle's volume compared with the previous 20 completed candles. Technical signals and scores are screening heuristics, not predictions or trading instructions. API delays, missing history, and exchange-side changes can affect results. No order placement, guaranteed reversal, or guaranteed-safe short is provided.

## Checks

Run the focused core tests with Node.js:

```sh
node --test radar.test.mjs
```
