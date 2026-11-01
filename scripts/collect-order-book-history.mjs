import { readFile, writeFile, mkdir } from "node:fs/promises";

const API = "https://api.gateio.ws/api/v4";
const OUTPUT = "data/order-book-history.json";
const LIMIT = 30;
const RETENTION_MS = 3 * 60 * 60 * 1000;
const SNAPSHOT_MAX_AGE_MS = 30000;

async function getJson(path) {
  const response = await fetch(API + path, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error("Gate.io HTTP " + response.status + " for " + path);
  return response.json();
}

function num(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function parseLevels(rows, multiplier) {
  if (!Array.isArray(rows)) return [];
  return rows.map(row => {
    const price = num(Array.isArray(row) ? row[0] : row?.p);
    const size = num(Array.isArray(row) ? row[1] : row?.s);
    if (price === null || size === null || price <= 0 || size <= 0) return null;
    return { price, notionalUsd: price * size * multiplier };
  }).filter(Boolean);
}

function analyze(book, multiplier, fetchedAt) {
  const generated = num(book?.current);
  if (generated === null || generated <= 0 || generated > fetchedAt / 1000 + 5 ||
      fetchedAt / 1000 - generated > 30) return null;
  const bids = parseLevels(book.bids, multiplier).sort((a, b) => b.price - a.price);
  const asks = parseLevels(book.asks, multiplier).sort((a, b) => a.price - b.price);
  if (!bids.length || !asks.length) return null;
  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  if (bestAsk <= bestBid) return null;
  const mid = (bestBid + bestAsk) / 2;
  const coverage = levels => Math.max(0, ...levels.map(level =>
    Math.abs(level.price / mid - 1) * 100
  ));
  if (coverage(bids) < 50 || coverage(asks) < 50) return null;
  const sum = levels => levels.reduce((total, level) =>
    Math.abs(level.price / mid - 1) <= 0.5 + 1e-12 ? total + level.notionalUsd : total, 0
  );
  const bidUsd = sum(bids);
  const askUsd = sum(asks);
  if (!(bidUsd > 0 && askUsd > 0)) return null;
  return { time: fetchedAt, bidUsd, askUsd, bidAskRatio: bidUsd / askUsd };
}

async function mapLimit(items, limit, task) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = await task(items[index]); }
      catch (error) { results[index] = { error: String(error?.message || error) }; }
    }
  });
  await Promise.all(workers);
  return results;
}

let previous = { schemaVersion: 1, updatedAt: null, samplingIntervalMs: 300000,
  maxGapMs: 480000, contracts: {} };
try {
  const parsed = JSON.parse(await readFile(OUTPUT, "utf8"));
  if (parsed?.schemaVersion === 1 && parsed.contracts && typeof parsed.contracts === "object") {
    previous = parsed;
  }
} catch { /* First collection starts with an empty history. */ }

const [contracts, tickers] = await Promise.all([
  getJson("/futures/usdt/contracts"),
  getJson("/futures/usdt/tickers")
]);
if (!Array.isArray(contracts) || !Array.isArray(tickers)) {
  throw new Error("Gate.io returned invalid contracts or ticker data.");
}
const contractMap = new Map(contracts.filter(row =>
  row && row.status === "trading" && typeof row.name === "string"
).map(row => [row.name, row]));
const selected = tickers.filter(row => contractMap.has(row?.contract))
  .map(row => ({ contract: row.contract, volume: num(row.volume_24h_quote) }))
  .filter(row => row.volume !== null && row.volume > 0)
  .sort((a, b) => b.volume - a.volume)
  .slice(0, LIMIT);

const now = Date.now();
const collected = await mapLimit(selected, 4, async item => {
  const meta = contractMap.get(item.contract);
  const multiplier = num(meta?.quanto_multiplier);
  if (multiplier === null || multiplier <= 0) return { contract: item.contract, snapshot: null };
  const book = await getJson("/futures/usdt/order_book?contract=" +
    encodeURIComponent(item.contract) + "&limit=300&with_id=true");
  const fetchedAt = Date.now();
  if (fetchedAt - now > 8 *  60 * 1000) return { contract: item.contract, snapshot: null };
  return { contract: item.contract, snapshot: analyze(book, multiplier, fetchedAt) };
});

const history = { ...previous.contracts };
for (const [contract, rows] of Object.entries(history)) {
  history[contract] = Array.isArray(rows) ? rows.filter(row =>
    row && Number.isFinite(row.time) && now - row.time <= RETENTION_MS
  ) : [];
}
let accepted = 0;
for (const item of collected) {
  if (!item?.snapshot) continue;
  const rows = history[item.contract] || [];
  if (rows.some(row => row.time === item.snapshot.time)) continue;
  rows.push(item.snapshot);
  history[item.contract] = rows.sort((a, b) => a.time - b.time).slice(-40);
  accepted += 1;
}
await mkdir("data", { recursive: true });
await writeFile(OUTPUT, JSON.stringify({
  schemaVersion: 1,
  updatedAt: now,
  samplingIntervalMs: 300000,
  maxGapMs: 480000,
  selection: "Top 30 active Gate.io USDT perpetual contracts by 24h quote volume",
  acceptedSnapshots: accepted,
  contracts: history
}) + "\n");
console.log("Saved " + accepted + " valid snapshots for up to " + LIMIT + " high-volume contracts.");
