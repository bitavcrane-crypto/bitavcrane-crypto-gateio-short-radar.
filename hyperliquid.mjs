import { WHALE_COHORT } from "./hyperliquid-cohort.mjs";

export const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";
export const WHALE_MIN_NOTIONAL = 1000000; // Main DEX: USDC quote notional.
export const WHALE_MAX_AGE_MS = 120000;
export const WHALE_HISTORY_KEY = "gate-short-radar-hl-history-v1";
// Explicit same-unit mappings, not fuzzy ticker guesses. No k/1000 remapping or HIP-3.
const MAPPED_COINS = new Set([
  "BTC", "ETH", "SOL", "XRP", "DOGE", "LINK", "SUI", "AVAX", "LTC", "ADA", "DOT", "BCH",
  "UNI", "AAVE", "TRX", "NEAR", "TON", "BNB", "HYPE", "WLD", "ENA", "ZEC", "PUMP", "XPL",
  "FARTCOIN", "LIT", "ASTER", "ZRO", "TAO", "VVV"
]);

export function hyperliquidCoin(contract) {
  if (typeof contract !== "string" || !contract.endsWith("_USDT")) return null;
  const coin = contract.slice(0, -5);
  return MAPPED_COINS.has(coin) ? coin : null;
}

function number(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  if (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

export function aggregateWhaleStates(states, addresses, nowMs, cohortId = WHALE_COHORT.id) {
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 128 ||
      new Set(addresses).size !== addresses.length ||
      addresses.some(address => !/^0x[0-9a-f]{40}$/.test(address))) {
    throw new Error("Некоректна вибірка адрес Hyperliquid.");
  }
  if (!Array.isArray(states) || states.length !== addresses.length ||
      new Set(states.map(row => row.address)).size !== addresses.length ||
      states.some(row => !addresses.includes(row.address))) {
    throw new Error("Неповна вибірка Hyperliquid: середні не обчислено.");
  }
  const coins = Object.create(null);
  let oldestTime = Infinity;
  let latestTime = 0;
  for (const row of states) {
    const data = row.data;
    if (!data || !Array.isArray(data.assetPositions) ||
        !Number.isFinite(data.time) || nowMs - data.time > WHALE_MAX_AGE_MS ||
        data.time > nowMs + 30000) {
      throw new Error("Неповний або застарілий знімок Hyperliquid: лінії приховано.");
    }
    oldestTime = Math.min(oldestTime, data.time);
    latestTime = Math.max(latestTime, data.time);
    const seen = new Set();
    for (const item of data.assetPositions) {
      const position = item?.position;
      const coin = position?.coin;
      const size = number(position?.szi);
      if (typeof coin !== "string" || !/^[a-zA-Z0-9_.:-]+$/.test(coin) ||
          size === null || seen.has(coin)) {
        throw new Error("Некоректна позиція Hyperliquid.");
      }
      seen.add(coin);
      if (size === 0) continue;
      const notional = number(position.positionValue);
      if (notional === null || notional < 0) throw new Error("Немає розміру позиції Hyperliquid.");
      if (notional < WHALE_MIN_NOTIONAL) continue;
      const entry = number(position.entryPx);
      if (entry === null || entry <= 0) throw new Error("Немає достовірної ціни входу Hyperliquid.");
      if (!coins[coin]) coins[coin] = {
        long: { quantity: 0, cost: 0, count: 0, notional: 0 },
        short: { quantity: 0, cost: 0, count: 0, notional: 0 }
      };
      const side = coins[coin][size > 0 ? "long" : "short"];
      side.quantity += Math.abs(size);
      side.cost += entry * Math.abs(size);
      side.notional += notional;
      side.count += 1;
    }
  }
  if (latestTime - oldestTime > 60000) throw new Error("Збір вибірки тривав надто довго: лінії приховано.");
  for (const coin of Object.keys(coins)) {
    for (const side of ["long", "short"]) {
      const value = coins[coin][side];
      value.entry = value.quantity > 0 ? value.cost / value.quantity : null;
      if (value.entry !== null && !Number.isFinite(value.entry)) throw new Error("Некоректне середнє Hyperliquid.");
      delete value.cost;
    }
  }
  return { cohortId, time: Math.floor(latestTime / 1000), oldestTime, observedAt: nowMs,
    checked: addresses.length, coins };
}

function aborted() {
  const error = new Error("Запит скасовано.");
  error.name = "AbortError";
  return error;
}

export function createHyperliquidClient({ fetchImpl = fetch, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, cohort = WHALE_COHORT } = {}) {
  let metadata = null;
  async function info(body, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) throw aborted();
    signal?.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timeout = setTimer(() => { timedOut = true; controller.abort(); }, 12000);
    try {
      const response = await fetchImpl(HYPERLIQUID_INFO, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) throw new Error("Hyperliquid HTTP " + response.status + ": дані недоступні.");
      const result = await response.json();
      if (controller.signal.aborted) throw aborted();
      return result;
    } catch (error) {
      if (timedOut) throw new Error("Hyperliquid не відповів за 12 секунд.");
      if (error.name === "TypeError") throw new Error("Мережевий доступ до Hyperliquid недоступний. Основні графіки Gate працюють окремо.");
      if (error.name === "SyntaxError") throw new Error("Hyperliquid повернув некоректну JSON-відповідь: нові лінії приховано.");
      throw error;
    } finally {
      clearTimer(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
  return {
    async snapshot({ signal } = {}) {
      if (!metadata || now() - metadata.at > 86400000) {
        const data = await info({ type: "meta" }, signal);
        if (!Array.isArray(data?.universe) || !data.universe.length ||
            data.universe.some(item => typeof item?.name !== "string")) {
          throw new Error("Не вдалося перевірити ринки Hyperliquid.");
        }
        metadata = { at: now(), active: data.universe.filter(item => !item.isDelisted).map(item => item.name) };
      }
      const states = [];
      let index = 0;
      let failure = null;
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) throw aborted();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        await Promise.all(Array.from({ length: Math.min(4, cohort.addresses.length) }, async () => {
          while (index < cohort.addresses.length && !controller.signal.aborted) {
            const address = cohort.addresses[index++];
            try {
              const data = await info({ type: "clearinghouseState", user: address }, controller.signal);
              states.push({ address, data });
            } catch (error) {
              if (!failure) failure = error;
              controller.abort();
            }
          }
        }));
        if (signal?.aborted) throw aborted();
        if (failure) throw failure;
        const snapshot = aggregateWhaleStates(states, cohort.addresses, now(), cohort.id);
        return { ...snapshot, activeCoins: metadata.active };
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    }
  };
}

export function freshWhaleSnapshot(snapshot, nowMs) {
  return !!snapshot && Number.isFinite(snapshot.oldestTime) &&
    nowMs - snapshot.oldestTime <= WHALE_MAX_AGE_MS && snapshot.oldestTime <= nowMs + 30000;
}

export function normalizeWhaleHistory(value, nowSeconds, cohortId = WHALE_COHORT.id) {
  const result = { cohortId, coins: {} };
  if (!value || value.cohortId !== cohortId || !value.coins || typeof value.coins !== "object") return result;
  for (const [coin, rows] of Object.entries(value.coins).slice(0, 12)) {
    if (!MAPPED_COINS.has(coin) || !Array.isArray(rows)) continue;
    const valid = new Map();
    for (const row of rows) {
      if (!row || !Number.isFinite(row.time) || row.time > nowSeconds ||
          row.time < nowSeconds - 86400 || !["long", "short"].every(side =>
          row[side] === null || (typeof row[side] === "number" && Number.isFinite(row[side]) && row[side] > 0))) continue;
      if (typeof row.rate !== "number" || !Number.isFinite(row.rate) || row.rate <= 0) continue;
      valid.set(row.time, { time: row.time, long: row.long, short: row.short, rate: row.rate });
    }
    const sorted = [...valid.values()].sort((a, b) => a.time - b.time).slice(-1440);
    if (sorted.length) result.coins[coin] = sorted;
  }
  return result;
}

export function recordWhaleHistory(history, snapshot, coins, fx) {
  if (!Number.isFinite(fx?.rate) || fx.rate <= 0) throw new Error("Немає курсу USDC/USDT.");
  if (Object.values(history?.coins || {}).some(rows => rows.at(-1)?.time > snapshot.time)) return history;
  const result = normalizeWhaleHistory(history, snapshot.time, snapshot.cohortId);
  for (const coin of [...new Set(coins)].slice(0, 12)) {
    if (!MAPPED_COINS.has(coin)) continue;
    const rows = result.coins[coin] || [];
    const values = snapshot.coins[coin];
    const point = { time: snapshot.time,
      long: values?.long.entry === null || !values ? null : values.long.entry * fx.rate,
      short: values?.short.entry === null || !values ? null : values.short.entry * fx.rate, rate: fx.rate };
    const byTime = new Map(rows.map(row => [row.time, row]));
    byTime.set(point.time, point);
    result.coins[coin] = [...byTime.values()].sort((a, b) => a.time - b.time).slice(-1440);
  }
  // Keep only the 12 most recently observed coins; no unbounded localStorage growth.
  result.coins = Object.fromEntries(Object.entries(result.coins).sort((a, b) =>
    b[1].at(-1).time - a[1].at(-1).time).slice(0, 12));
  return result;
}

export function whaleHistorySeries(history, coin, side, domainTimes) {
  const start = domainTimes[0];
  const end = domainTimes.at(-1);
  const rows = history?.coins?.[coin] || [];
  const times = [], values = [];
  let previous = null;
  for (const row of rows) {
    if (row.time < start || row.time > end) continue;
    if (previous !== null && row.time - previous > 180) {
      times.push(previous + 1); values.push(null);
    }
    times.push(row.time); values.push(row[side]);
    previous = row.time;
  }
  return { times, values };
}
