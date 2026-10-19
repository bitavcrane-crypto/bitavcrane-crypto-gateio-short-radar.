const API_ROOT = "https://api.gateio.ws/api/v4";
const CACHE_MS = 15000;
const cache = new Map();

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

async function request(path, cacheMs) {
  const now = Date.now();
  const cached = cache.get(path);
  if (cached && now - cached.time < cacheMs) return cached.value;
  const response = await fetch(API_ROOT + path, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("Gate.io відповів HTTP " + response.status);
  const data = await response.json();
  cache.set(path, { time: now, value: data });
  return data;
}

export async function fetchContracts() {
  const rows = await request("/futures/usdt/contracts", 60000);
  if (!Array.isArray(rows)) throw new Error("Некоректний список контрактів Gate.io");
  return rows;
}

export async function fetchTickers() {
  const rows = await request("/futures/usdt/tickers", CACHE_MS);
  if (!Array.isArray(rows)) throw new Error("Некоректні ticker-дані Gate.io");
  return rows;
}

export async function fetchCandles(contract, interval) {
  const query = "?contract=" + encodeURIComponent(contract) + "&interval=" + encodeURIComponent(interval) + "&limit=80";
  const rows = await request("/futures/usdt/candlesticks" + query, CACHE_MS);
  if (!Array.isArray(rows)) throw new Error("Некоректні свічки " + contract + " " + interval);
  return rows;
}

export async function fetchContractStats(contract) {
  const query = "?contract=" + encodeURIComponent(contract) + "&interval=5m&limit=60";
  const rows = await request("/futures/usdt/contract_stats" + query, CACHE_MS);
  if (!Array.isArray(rows)) throw new Error("Некоректна статистика " + contract);
  return rows;
}

export function normalizeTicker(row, contract) {
  if (!row || row.contract !== contract) {
    return { quality: "CONFLICT", last: null, mark: null, index: null, funding: null, volume24h: null };
  }
  const numberField = function (name, allowZero) {
    const result = numeric(row[name]);
    return result !== null && (allowZero ? result >= 0 : result > 0) ? result : null;
  };
  const funding = numeric(row.funding_rate);
  return {
    quality: "OK",
    last: numberField("last"),
    mark: numberField("mark_price"),
    index: numberField("index_price"),
    funding: funding,
    volume24h: numberField("volume_24h_quote", true)
  };
}

export function normalizeContract(row) {
  if (!row || typeof row.name !== "string") return null;
  const interval = numeric(row.funding_interval);
  return {
    name: row.name,
    active: typeof row.status === "string" && row.status.toLowerCase() === "trading",
    fundingIntervalSeconds: interval !== null && interval > 0 ? interval : null
  };
}

export function normalizeContractStats(rows, nowSeconds) {
  if (!Array.isArray(rows)) return { rows: [], quality: "NO DATA", duplicates: 0 };
  const byTime = new Map();
  let suspect = false;
  let duplicates = 0;
  rows.forEach(function (row) {
    if (!row || typeof row !== "object") {
      suspect = true;
      return;
    }
    const time = numeric(row.time);
    if (time === null || time <= 0 || time > 10000000000 || time > nowSeconds + 60) {
      suspect = true;
      return;
    }
    function field(name, allowZero) {
      const value = numeric(row[name]);
      if (value === null) return null;
      if (allowZero ? value < 0 : value <= 0) {
        suspect = true;
        return null;
      }
      return value;
    }
    const stat = {
      time: Math.floor(time),
      openInterest: field("open_interest", true),
      openInterestUsd: field("open_interest_usd", true),
      lsrTaker: field("lsr_taker", true),
      lsrAccount: field("lsr_account", true),
      topLsrAccount: field("top_lsr_account", true),
      topLsrSize: field("top_lsr_size", true),
      longLiquidationSize: field("long_liq_size", true),
      longLiquidationAmount: field("long_liq_amount", true),
      longLiquidationUsd: field("long_liq_usd", true),
      shortLiquidationSize: field("short_liq_size", true),
      shortLiquidationAmount: field("short_liq_amount", true),
      shortLiquidationUsd: field("short_liq_usd", true),
      markPrice: field("mark_price", false)
    };
    if (byTime.has(stat.time)) duplicates += 1;
    byTime.set(stat.time, stat);
  });
  const normalized = Array.from(byTime.values()).sort(function (a, b) { return a.time - b.time; });
  const latest = normalized.length ? normalized[normalized.length - 1] : null;
  const quality = suspect || duplicates ? "SUSPECT" : !latest ? "NO DATA" :
    nowSeconds - latest.time > 600 ? "STALE" : "OK";
  return { rows: normalized, quality: quality, duplicates: duplicates };
}

export function clearCache() {
  cache.clear();
}
