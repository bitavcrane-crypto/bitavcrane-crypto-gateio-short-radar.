const API_ROOT = "https://api.gateio.ws/api/v4";
const CACHE_MS = 15000;
const VISUALIZATION_CANDLE_LIMIT = 600;
const cache = new Map();
const receivedAt = new WeakMap();

function numeric(value) {
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && !value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

async function request(path, cacheMs) {
  const now = Date.now();
  const cached = cache.get(path);
  if (cached && now - cached.time < cacheMs) return cached.value;
  const response = await fetch(API_ROOT + path, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error("Gate.io відповів HTTP " + response.status);
  const data = await response.json();
  const time = Date.now();
  if (data && typeof data === "object") {
    receivedAt.set(data, time);
    if (Array.isArray(data)) data.forEach(function (row) {
      if (row && typeof row === "object") receivedAt.set(row, time);
    });
  }
  cache.set(path, { time: time, value: data });
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
  return fetchCandlesWithLimit(contract, interval, 80);
}

export async function fetchVisualizationCandles(contract, interval) {
  return fetchCandlesWithLimit(contract, interval, VISUALIZATION_CANDLE_LIMIT);
}

async function fetchCandlesWithLimit(contract, interval, limit) {
  const query = "?contract=" + encodeURIComponent(contract) + "&interval=" + encodeURIComponent(interval) + "&limit=" + limit;
  const rows = await request("/futures/usdt/candlesticks" + query, CACHE_MS);
  if (!Array.isArray(rows)) throw new Error("Некоректні свічки " + contract + " " + interval);
  return rows;
}

export async function fetchContractStats(contract) {
  const query = "?contract=" + encodeURIComponent(contract) + "&interval=5m&limit=100";
  const rows = await request("/futures/usdt/contract_stats" + query, CACHE_MS);
  if (!Array.isArray(rows)) throw new Error("Некоректна статистика " + contract);
  return rows;
}

export async function fetchOrderBook(contract) {
  const query = "?contract=" + encodeURIComponent(contract) + "&limit=20&with_id=true";
  const book = await request("/futures/usdt/order_book" + query, CACHE_MS);
  if (!book || typeof book !== "object" || Array.isArray(book)) {
    throw new Error("Некоректна книга заявок " + contract);
  }
  return book;
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
    volume24h: numberField("volume_24h_quote", true),
    fetchedAt: receivedAt.get(row) || Date.now()
  };
}

export function normalizeContract(row) {
  if (!row || typeof row.name !== "string") return null;
  const interval = numeric(row.funding_interval);
  const takerFeeRate = numeric(row.taker_fee_rate);
  return {
    name: row.name,
    active: typeof row.status === "string" && row.status.toLowerCase() === "trading",
    fundingIntervalSeconds: interval !== null && interval > 0 ? interval : null,
    takerFeeRate: takerFeeRate !== null && takerFeeRate >= 0 && takerFeeRate < 1 ? takerFeeRate : null,
    quantoMultiplier: numeric(row.quanto_multiplier) > 0 ? numeric(row.quanto_multiplier) : null
  };
}

export function normalizeOrderBook(book, contractMultiplier, fetchedAtMs) {
  const fetchedAt = receivedAt.get(book) || fetchedAtMs || Date.now();
  const generatedAt = numeric(book && book.current);
  const timestampQuality = generatedAt === null && book && book.current === undefined ? "INCOMPLETE" :
    generatedAt === null || generatedAt <= 0 || generatedAt > fetchedAt / 1000 + 5 ? "SUSPECT" :
      fetchedAt / 1000 - generatedAt > 30 ? "STALE" : null;
  let invalidLevels = false;
  const levels = function (items, isBid) {
    if (!Array.isArray(items)) return [];
    return items.map(function (level) {
      const price = numeric(Array.isArray(level) ? level[0] : level && level.p);
      const size = numeric(Array.isArray(level) ? level[1] : level && level.s);
      if (price === null || price <= 0 || size === null || size <= 0) {
        invalidLevels = true;
        return null;
      }
      return { price: price, size: size, bid: isBid };
    }).filter(Boolean);
  };
  const bids = levels(book && book.bids, true).sort(function (a, b) { return b.price - a.price; });
  const asks = levels(book && book.asks, false).sort(function (a, b) { return a.price - b.price; });
  const multiplier = numeric(contractMultiplier);
  if (!bids.length || !asks.length || multiplier === null || multiplier <= 0) {
    return { quality: "INCOMPLETE", bestBid: null, bestAsk: null, spreadPercent: null, depthUsd: null, fetchedAt: fetchedAt };
  }
  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  if (bestAsk <= bestBid) {
    return { quality: "SUSPECT", bestBid: bestBid, bestAsk: bestAsk, spreadPercent: null, depthUsd: null, fetchedAt: fetchedAt };
  }
  const midpoint = (bestBid + bestAsk) / 2;
  const depthWithinHalfPercent = function (items) {
    return items.reduce(function (sum, level) {
      if (Math.abs(level.price / midpoint - 1) > 0.005) return sum;
      return sum + level.price * level.size * multiplier;
    }, 0);
  };
  const estimateSlippage = function (items) {
    const targetUsd = 1000;
    let remainingBase = targetUsd / items[0].price;
    let filledBase = 0;
    let value = 0;
    items.forEach(function (level) {
      const availableBase = level.size * multiplier;
      const fillBase = Math.min(remainingBase, availableBase);
      filledBase += fillBase;
      value += fillBase * level.price;
      remainingBase -= fillBase;
    });
    if (remainingBase > 0 || filledBase === 0) return null;
    const vwap = value / filledBase;
    return Math.abs(vwap / items[0].price - 1) * 100;
  };
  const bidDepth = depthWithinHalfPercent(bids);
  const askDepth = depthWithinHalfPercent(asks);
  const bidSlippage = estimateSlippage(bids);
  const askSlippage = estimateSlippage(asks);
  const spreadPercent = (bestAsk / bestBid - 1) * 100;
  const depthUsd = Math.min(bidDepth, askDepth);
  return {
    quality: invalidLevels || !Number.isFinite(spreadPercent) || !Number.isFinite(depthUsd) ?
      "SUSPECT" : timestampQuality || "OK",
    bestBid: bestBid,
    bestAsk: bestAsk,
    spreadPercent: Number.isFinite(spreadPercent) ? spreadPercent : null,
    depthUsd: Number.isFinite(depthUsd) ? depthUsd : null,
    slippagePercent: bidSlippage === null || askSlippage === null ? null :
      Math.max(bidSlippage, askSlippage),
    fetchedAt: fetchedAt,
    generatedAt: generatedAt,
    depthWindowPercent: 0.5,
    bidDepthUsd: bidDepth,
    askDepthUsd: askDepth,
    executionNotionalUsd: 1000,
    timestampQuality: timestampQuality
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
    if (time === null || time <= 0 || time > 10000000000 || time > nowSeconds) {
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
    function optionalVisualField(name) {
      const value = numeric(row[name]);
      return value !== null && value >= 0 ? value : null;
    }
    const stat = {
      time: Math.floor(time),
      openInterest: field("open_interest", true),
      openInterestUsd: field("open_interest_usd", true),
      lsrTaker: field("lsr_taker", true),
      lsrAccount: field("lsr_account", true),
      topLsrAccount: field("top_lsr_account", true),
      topLsrSize: field("top_lsr_size", true),
      topLongOpenInterest: optionalVisualField("top_long_size"),
      topShortOpenInterest: optionalVisualField("top_short_size"),
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
