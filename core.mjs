export const QUALITY = Object.freeze({
  OK: "OK",
  NO_DATA: "NO DATA",
  STALE: "STALE",
  CONFLICT: "CONFLICT",
  INCOMPLETE: "INCOMPLETE",
  SUSPECT: "SUSPECT"
});

export const INTERVAL_SECONDS = Object.freeze({ "5m": 300, "15m": 900, "1h": 3600, "4h": 14400 });

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeCandles(input, interval, nowSeconds) {
  const seconds = INTERVAL_SECONDS[interval];
  if (!seconds || !Array.isArray(input)) return { candles: [], quality: QUALITY.NO_DATA, duplicates: 0 };
  const byTime = new Map();
  let suspect = false;
  let duplicates = 0;
  input.forEach(function (raw) {
    if (!raw || typeof raw !== "object") {
      suspect = true;
      return;
    }
    const time = number(raw.t);
    const open = number(raw.o);
    const high = number(raw.h);
    const low = number(raw.l);
    const close = number(raw.c);
    const volume = number(raw.v);
    if (!finite(time) || time < 0 || time > 10000000000 || !finite(open) || !finite(high) ||
        !finite(low) || !finite(close) || open <= 0 || close <= 0 || low <= 0 ||
        high < Math.max(open, close, low) || low > Math.min(open, close)) {
      suspect = true;
      return;
    }
    if (raw.v !== null && raw.v !== undefined && raw.v !== "" &&
        (volume === null || volume < 0)) suspect = true;
    const candle = {
      time: Math.floor(time),
      open: open,
      high: high,
      low: low,
      close: close,
      volume: finite(volume) && volume >= 0 ? volume : null
    };
    if (byTime.has(candle.time)) duplicates += 1;
    byTime.set(candle.time, candle);
  });
  const candles = Array.from(byTime.values())
    .filter(function (candle) { return candle.time + seconds <= nowSeconds; })
    .sort(function (a, b) { return a.time - b.time; });
  const quality = suspect || duplicates > 0 ? QUALITY.SUSPECT :
    candles.length === 0 ? QUALITY.NO_DATA :
    nowSeconds - (candles[candles.length - 1].time + seconds) > seconds * 3 ? QUALITY.STALE : QUALITY.OK;
  return { candles: candles, quality: quality, duplicates: duplicates };
}

function percentChange(candles, count) {
  if (!candles || candles.length <= count) return null;
  const latest = candles[candles.length - 1].close;
  const prior = candles[candles.length - 1 - count].close;
  return prior > 0 ? (latest / prior - 1) * 100 : null;
}

function average(values) {
  if (!values.length) return null;
  return values.reduce(function (total, item) { return total + item; }, 0) / values.length;
}

export function relativeChange(current, previous) {
  if (!finite(current) || !finite(previous) || previous === 0) return null;
  return (current / previous - 1) * 100;
}

export function calculateContractMetrics(stats) {
  const rows = stats && Array.isArray(stats.rows) ? stats.rows : [];
  const quality = stats && stats.quality ? stats.quality : QUALITY.NO_DATA;
  const latest = rows.length ? rows[rows.length - 1] : null;
  function valueAtOrBefore(ageSeconds, field) {
    if (!latest) return null;
    const target = latest.time - ageSeconds;
    let match = null;
    rows.forEach(function (row) {
      if (row.time <= target && finite(row[field]) && (!match || row.time > match.time)) match = row;
    });
    return match;
  }
  function change(field, ageSeconds) {
    if (!latest || !finite(latest[field])) return null;
    const previous = valueAtOrBefore(ageSeconds, field);
    return previous ? relativeChange(latest[field], previous[field]) : null;
  }
  function ratioChange(field, ageSeconds) {
    if (!latest || !finite(latest[field])) return null;
    const previous = valueAtOrBefore(ageSeconds, field);
    return previous && previous[field] !== 0 ? relativeChange(latest[field], previous[field]) : null;
  }
  return {
    quality: quality,
    time: latest ? latest.time : null,
    openInterest: latest && finite(latest.openInterest) ? latest.openInterest : null,
    openInterestUsd: latest && finite(latest.openInterestUsd) ? latest.openInterestUsd : null,
    oiChanges: {
      "15m": change("openInterest", 900),
      "1h": change("openInterest", 3600),
      "4h": change("openInterest", 14400)
    },
    lsrAccount: latest && finite(latest.lsrAccount) ? latest.lsrAccount : null,
    lsrTaker: latest && finite(latest.lsrTaker) ? latest.lsrTaker : null,
    lsrAccountChange15m: ratioChange("lsrAccount", 900),
    longLiquidationUsd: latest && finite(latest.longLiquidationUsd) ? latest.longLiquidationUsd : null,
    shortLiquidationUsd: latest && finite(latest.shortLiquidationUsd) ? latest.shortLiquidationUsd : null,
    markPrice: latest && finite(latest.markPrice) ? latest.markPrice : null
  };
}

export function calculateRsi(candles, period) {
  if (!candles || candles.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  const start = candles.length - period;
  for (let i = start; i < candles.length; i += 1) {
    const delta = candles[i].close - candles[i - 1].close;
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  if (losses === 0) return gains > 0 ? 100 : 50;
  const ratio = (gains / period) / (losses / period);
  return 100 - 100 / (1 + ratio);
}

function ema(values, period) {
  if (values.length < period) return [];
  const output = [];
  const multiplier = 2 / (period + 1);
  let current = average(values.slice(0, period));
  output.push(current);
  for (let i = period; i < values.length; i += 1) {
    current = (values[i] - current) * multiplier + current;
    output.push(current);
  }
  return output;
}

export function calculateMacd(candles) {
  if (!candles || candles.length < 35) return null;
  const closes = candles.map(function (candle) { return candle.close; });
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const offset = 26 - 12;
  const line = [];
  for (let i = 0; i < slow.length; i += 1) line.push(fast[i + offset] - slow[i]);
  const signal = ema(line, 9);
  if (signal.length < 2 || line.length < 2) return null;
  const priorLine = line[line.length - 2];
  const latestLine = line[line.length - 1];
  const priorSignal = signal[signal.length - 2];
  const latestSignal = signal[signal.length - 1];
  return {
    line: latestLine,
    signal: latestSignal,
    histogram: latestLine - latestSignal,
    bearishCross: priorLine >= priorSignal && latestLine < latestSignal
  };
}

function calculateAtr(candles, period) {
  if (!candles || candles.length < period + 1) return null;
  const ranges = [];
  for (let i = candles.length - period; i < candles.length; i += 1) {
    ranges.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    ));
  }
  return average(ranges);
}

function obvValues(candles) {
  const values = [0];
  for (let i = 1; i < candles.length; i += 1) {
    const volume = finite(candles[i].volume) ? candles[i].volume : 0;
    const direction = candles[i].close > candles[i - 1].close ? 1 :
      candles[i].close < candles[i - 1].close ? -1 : 0;
    values.push(values[i - 1] + direction * volume);
  }
  return values;
}

export function calculateIndicators(candles) {
  if (!candles || candles.length < 2) return { rsi: null, macd: null, atr: null, obvDivergence: false };
  const rsi = calculateRsi(candles, 14);
  const macd = calculateMacd(candles);
  const atr = calculateAtr(candles, 14);
  let obvDivergence = false;
  if (candles.length >= 25 && candles.slice(-25).every(function (candle) { return finite(candle.volume); })) {
    const obv = obvValues(candles);
    const first = candles.length - 1;
    const recentStart = Math.max(first - 4, 20);
    const priorStart = Math.max(0, recentStart - 20);
    let recentHighIndex = recentStart;
    let priorHighIndex = priorStart;
    for (let i = priorStart; i < recentStart; i += 1) {
      if (candles[i].high > candles[priorHighIndex].high) priorHighIndex = i;
    }
    for (let i = recentStart; i <= first; i += 1) {
      if (candles[i].high > candles[recentHighIndex].high) recentHighIndex = i;
    }
    obvDivergence = candles[recentHighIndex].high > candles[priorHighIndex].high &&
      obv[recentHighIndex] <= obv[priorHighIndex];
  }
  return { rsi: rsi, macd: macd, atr: atr, obvDivergence: obvDivergence };
}

function volumeRatio(candles, lookback) {
  if (!candles || candles.length < lookback + 1) return null;
  const latest = candles[candles.length - 1].volume;
  const baseline = candles.slice(candles.length - lookback - 1, candles.length - 1)
    .map(function (candle) { return candle.volume; });
  if (!finite(latest) || baseline.some(function (item) { return !finite(item); })) return null;
  const mean = average(baseline);
  return mean > 0 ? latest / mean : null;
}

function priceMomentum(candles) {
  if (!candles || candles.length < 2) return null;
  return (candles[candles.length - 1].close / candles[candles.length - 2].close - 1) * 100;
}

function upperWickRatio(candle) {
  const range = candle.high - candle.low;
  return range > 0 ? (candle.high - Math.max(candle.open, candle.close)) / range : 0;
}

function localSupport(candles, entry) {
  const supports = [];
  const start = Math.max(1, candles.length - 24);
  for (let i = start; i < candles.length - 1; i += 1) {
    if (candles[i].low <= candles[i - 1].low && candles[i].low <= candles[i + 1].low && candles[i].low < entry) {
      supports.push(candles[i].low);
    }
  }
  return supports.sort(function (a, b) { return b - a; });
}

export function calculateLevels(candles) {
  if (!candles || candles.length < 15) return null;
  const indicators = calculateIndicators(candles);
  if (!finite(indicators.atr) || indicators.atr <= 0) return null;
  const recent = candles.slice(-20);
  const entry = candles[candles.length - 1].close;
  const localHigh = Math.max.apply(null, recent.map(function (candle) { return candle.high; }));
  const stop = Math.max(localHigh, entry + indicators.atr) + indicators.atr * 0.2;
  const risk = stop - entry;
  if (risk <= 0) return null;
  const supports = localSupport(candles, entry);
  const tp1 = supports.length ? supports[0] : entry - indicators.atr;
  const tp2 = Math.min(entry - indicators.atr * 2, tp1 - indicators.atr);
  const tp3 = Math.min(entry - indicators.atr * 3, tp2 - indicators.atr);
  return {
    entry: entry, stop: stop, tp1: tp1, tp2: tp2, tp3: tp3,
    riskReward: (entry - tp1) / risk,
    atr: indicators.atr,
    support: supports.length ? supports[0] : null
  };
}

function scorePump(changes, ratio) {
  let score = 0;
  const short = changes["5m"];
  const main = changes["15m"];
  const hourly = changes["1h"];
  const fourHour = changes["4h"];
  if (finite(short) && short >= 1) score += 10;
  if (finite(main) && main >= 2) score += 20;
  if (finite(hourly) && hourly >= 5) score += 15;
  if (finite(fourHour) && fourHour >= 10) score += 10;
  if (finite(ratio) && ratio >= 1.5) score += Math.min(35, 15 + Math.max(0, ratio - 1.5) * 5);
  if (finite(main) && main >= 2 && (!finite(ratio) || ratio < 1.5)) score = Math.min(score, 35);
  return Math.round(Math.min(100, score));
}

function scoreExhaustion(data) {
  const indicators = data.indicators;
  let score = 0;
  const mainMomentum = data.changes["15m"];
  const shortMomentum = data.changes["5m"];
  if (finite(indicators.rsi) && indicators.rsi >= 75) score += 15;
  const hourlyMomentum = data.changes["1h"];
  if ((finite(mainMomentum) && finite(shortMomentum) && mainMomentum > 0 && shortMomentum < mainMomentum * 0.35) ||
      (finite(mainMomentum) && mainMomentum < 0 && finite(hourlyMomentum) && hourlyMomentum >= 3)) score += 20;
  if (indicators.macd && (indicators.macd.bearishCross || indicators.macd.histogram < 0)) score += 15;
  if (data.candles15.slice(-3).some(function (candle) { return upperWickRatio(candle) >= 0.55; })) score += 12;
  if (indicators.obvDivergence) score += 15;
  if (data.stats.quality === QUALITY.OK && finite(data.oiChange15m) && data.oiChange15m < -1) score += 10;
  if (finite(data.fundingNormalized) && data.fundingNormalized >= 0.0005) score += 5;
  if (data.stats.quality === QUALITY.OK && finite(data.stats.lsrAccount) && data.stats.lsrAccount >= 2) score += 5;
  if (data.stats.quality === QUALITY.OK && finite(data.stats.longLiquidationUsd) && finite(data.stats.shortLiquidationUsd) &&
      data.stats.shortLiquidationUsd > data.stats.longLiquidationUsd * 3 &&
      data.stats.shortLiquidationUsd > 0) score += 5;
  return Math.min(100, score);
}

function findBreakdown(candles) {
  if (candles.length < 4) return false;
  const latest = candles[candles.length - 1];
  const previous = candles.slice(-4, -1);
  const support = Math.min.apply(null, previous.map(function (candle) { return candle.low; }));
  return latest.close < support;
}

function signalState(pump, exhaustion, breakdown, confirmed, hasData, shortReady) {
  if (!hasData) return { key: "incomplete", label: "INCOMPLETE", score: 0 };
  if (shortReady && pump >= 45 && exhaustion >= 60 && breakdown && confirmed) return { key: "entry", label: "SHORT ENTRY", score: 80 };
  if (shortReady && pump >= 45 && exhaustion >= 55 && breakdown) return { key: "setup", label: "SHORT SETUP", score: 65 };
  if (pump >= 55 && exhaustion >= 45) return { key: "exhaustion", label: "EXHAUSTION", score: 45 };
  if (pump >= 65) return { key: "hot", label: "OVERHEATED", score: 25 };
  if (pump >= 45) return { key: "pump", label: "PUMP ACTIVE", score: 10 };
  if (pump >= 25) return { key: "watch", label: "PUMP WATCH", score: 0 };
  return { key: "none", label: "Немає сигналу", score: 0 };
}

export function buildMarketData(input) {
  const candles = input.candles || {};
  const qualities = {};
  const normalized = {};
  Object.keys(INTERVAL_SECONDS).forEach(function (interval) {
    const result = normalizeCandles(candles[interval], interval, input.nowSeconds);
    normalized[interval] = result.candles;
    qualities[interval] = result.quality;
  });
  const ticker = input.ticker || {};
  const changes = {
    "5m": percentChange(normalized["5m"], 1),
    "15m": percentChange(normalized["15m"], 1),
    "1h": percentChange(normalized["1h"], 1),
    "4h": percentChange(normalized["4h"], 1)
  };
  const ratio = volumeRatio(normalized["15m"], 20);
  const indicators = calculateIndicators(normalized["15m"]);
  const stats = calculateContractMetrics(input.stats);
  const currentOi = stats.openInterest;
  const oiChanges = stats.oiChanges;
  const oiChange15m = finite(oiChanges["15m"]) ? oiChanges["15m"] : null;
  const fundingInterval = finite(input.fundingIntervalSeconds) && input.fundingIntervalSeconds > 0 ?
    input.fundingIntervalSeconds : null;
  const fundingNormalized = finite(ticker.funding) && fundingInterval ?
    ticker.funding * (28800 / fundingInterval) : null;
  const data = {
    candles: normalized,
    candles15: normalized["15m"],
    qualities: qualities,
    changes: changes,
    volumeRatio: ratio,
    indicators: indicators,
    ticker: ticker,
    oi: currentOi,
    stats: stats,
    oiChanges: oiChanges,
    oiChange15m: oiChange15m,
    fundingIntervalSeconds: fundingInterval,
    fundingNormalized: fundingNormalized
  };
  const pump = scorePump(changes, ratio);
  const exhaustion = normalized["15m"].length ?
    (pump >= 30 ? scoreExhaustion(data) : 0) : 0;
  const breakdown = normalized["15m"].length ? findBreakdown(normalized["15m"]) : false;
  const confirmed = breakdown && (
    (indicators.macd && indicators.macd.histogram < 0) ||
    (finite(changes["15m"]) && changes["15m"] < 0)
  );
  const primaryQuality = qualities["15m"];
  const usableCandles = normalized["15m"].length > 0 && primaryQuality !== QUALITY.STALE &&
    primaryQuality !== QUALITY.SUSPECT && ticker.quality !== QUALITY.CONFLICT;
  const shortReady = usableCandles && primaryQuality === QUALITY.OK && finite(ratio) &&
    normalized["15m"].length >= 35 && indicators.macd !== null && ticker.quality === QUALITY.OK &&
    finite(ticker.last) && finite(currentOi) && finite(oiChange15m) &&
    qualities["1h"] === QUALITY.OK && finite(changes["1h"]) &&
    stats.quality === QUALITY.OK;
  const state = signalState(pump, exhaustion, breakdown, confirmed, usableCandles, shortReady);
  const levels = state.key === "setup" || state.key === "entry" ?
    calculateLevels(normalized["15m"]) : null;
  const shortScore = state.key === "entry" ? Math.min(100, exhaustion + 25) :
    state.key === "setup" ? Math.min(79, exhaustion + 15) : Math.min(40, exhaustion);
  const why = explain(data, pump, exhaustion, state);
  const confidence = !usableCandles || !finite(ratio) || !finite(ticker.last) ||
    !finite(currentOi) || !finite(oiChange15m) || stats.quality !== QUALITY.OK ? "LOW" :
    shortReady && indicators.rsi !== null && indicators.macd && finite(stats.lsrAccount) &&
      finite(stats.longLiquidationUsd) && finite(stats.shortLiquidationUsd) ? "HIGH" : "MEDIUM";
  return {
    data: data,
    pumpScore: pump,
    exhaustionScore: exhaustion,
    shortScore: shortScore,
    state: state,
    breakdown: breakdown,
    confirmed: confirmed,
    levels: levels,
    why: why,
    confidence: confidence,
    quality: overallQuality(data)
  };
}

function overallQuality(data) {
  if (data.ticker.quality === QUALITY.CONFLICT) return QUALITY.CONFLICT;
  if (data.qualities["15m"] === QUALITY.STALE) return QUALITY.STALE;
  if (data.qualities["15m"] === QUALITY.SUSPECT) return QUALITY.SUSPECT;
  if (data.stats.quality === QUALITY.STALE) return QUALITY.STALE;
  if (data.stats.quality === QUALITY.SUSPECT) return QUALITY.SUSPECT;
  if (!finite(data.ticker.last) || !finite(data.stats.openInterest) ||
      !finite(data.oiChanges["15m"])) return QUALITY.INCOMPLETE;
  if (!finite(data.volumeRatio) || Object.keys(data.changes).some(function (interval) {
    return !finite(data.changes[interval]);
  }) || data.stats.quality !== QUALITY.OK) return QUALITY.INCOMPLETE;
  return QUALITY.OK;
}

function explain(data, pump, exhaustion, state) {
  const parts = [];
  const main = data.changes["1h"];
  if (finite(main) && main > 0) parts.push("Ціна " + (main >= 0 ? "+" : "") + main.toFixed(2) + "% за 1h");
  if (finite(data.volumeRatio)) parts.push("обсяг " + data.volumeRatio.toFixed(1) + "x від бази");
  if (data.stats.quality === QUALITY.OK && finite(data.oiChange15m)) {
    parts.push("OI " + (data.oiChange15m >= 0 ? "+" : "") + data.oiChange15m.toFixed(2) + "% за 15m");
  }
  else parts.push("зміна OI накопичується");
  if (data.stats.quality === QUALITY.OK && finite(main) && main > 0 && finite(data.oiChange15m)) {
    if (data.oiChange15m > 0) parts.push("ціна ↑ + OI ↑ — нарощування позицій");
    else if (data.oiChange15m < 0) parts.push("ціна ↑ + OI ↓ — можливий SHORT squeeze");
  }
  if ((finite(main) && main < 0 && finite(data.changes["1h"]) && data.changes["1h"] >= 3) ||
      (finite(data.changes["15m"]) && finite(data.changes["5m"]) &&
       data.changes["15m"] > 0 && data.changes["5m"] < data.changes["15m"] * 0.35)) {
    parts.push("momentum сповільнюється або розвернувся");
  }
  if (data.stats.quality === QUALITY.OK && finite(data.stats.shortLiquidationUsd) && data.stats.shortLiquidationUsd > 0 &&
      finite(data.stats.longLiquidationUsd) &&
      data.stats.shortLiquidationUsd > data.stats.longLiquidationUsd * 3) {
    parts.push("переважають ліквідації SHORT за останні 5m — можливий squeeze");
  }
  if (state.key === "entry") parts.push("закриття пробило локальну підтримку");
  else if (state.key === "setup") parts.push("є пробій локальної підтримки, очікується підтвердження");
  if (finite(data.indicators.rsi) && data.indicators.rsi >= 75) parts.push("RSI перегрітий, але сам по собі не є SHORT-сигналом");
  if (data.stats.quality === QUALITY.OK && finite(data.stats.lsrAccount) && data.stats.lsrAccount >= 2) {
    parts.push("перевага LONG у співвідношенні рахунків (допоміжний фактор)");
  }
  if (data.candles15.slice(-3).some(function (candle) { return upperWickRatio(candle) >= 0.55; })) {
    parts.push("довга верхня тінь показує відмову від вищих цін");
  }
  if (data.indicators.obvDivergence) parts.push("OBV не підтверджує новий максимум");
  if (data.indicators.macd && data.indicators.macd.histogram < 0) parts.push("MACD histogram bearish");
  if (finite(data.fundingNormalized) && data.fundingNormalized >= 0.0005) {
    parts.push("funding підвищений після нормалізації до 8h");
  }
  if (pump < 25) return "Немає підтвердженого пампу. " + (finite(data.volumeRatio) ? "Ціна й обсяг не показують достатньої аномалії." : "Для оцінки обсягу недостатньо закритих свічок.");
  return parts.length ? parts.join(" · ") : "Є аномальний рух ціни, але підтвердження обсягом/виснаженням обмежене.";
}

export function transitionSignal(current, previous, lastCandleTime) {
  if (!current || !current.data || !current.data.candles15.length) return current;
  const candleTime = current.data.candles15[current.data.candles15.length - 1].time;
  if (previous && lastCandleTime === candleTime) {
    return Object.assign({}, previous, { unchangedCandle: true });
  }
  if (previous && (previous.state.key === "setup" || previous.state.key === "entry") &&
      previous.levels && current.data.candles15[current.data.candles15.length - 1].close >= previous.levels.stop) {
    return Object.assign({}, current, {
      state: { key: "cancelled", label: "CANCEL", score: 0 },
      shortScore: 0,
      levels: null,
      why: "Закриття 15m вище STOP / рівня інвалідації. Попередній SHORT-сценарій скасовано."
    });
  }
  if (previous && previous.state.key === "cancelled" && current.state.key === "none") {
    current.state = { key: "cancelled", label: "CANCEL", score: 0 };
    current.shortScore = 0;
  }
  current.candleTime = candleTime;
  current.unchangedCandle = false;
  return current;
}

export function validatePairList(value, allowedContracts) {
  const allowed = new Set(allowedContracts);
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  value.forEach(function (pair) {
    if (typeof pair !== "string") return;
    const normalized = pair.trim().toUpperCase();
    if (!/^[A-Z0-9]+_[A-Z0-9]+$/.test(normalized) || !allowed.has(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  });
  return result;
}

export function addPair(list, pair, allowedContracts) {
  const normalized = typeof pair === "string" ? pair.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]+_[A-Z0-9]+$/.test(normalized)) return { list: list.slice(), error: "Невірний формат. Використайте SYMBOL_USDT." };
  if (allowedContracts.indexOf(normalized) === -1) return { list: list.slice(), error: "Такого активного USDT-контракту Gate.io не знайдено." };
  if (list.indexOf(normalized) !== -1) return { list: list.slice(), error: "Ця пара вже є у списку." };
  return { list: list.concat([normalized]), error: null };
}

export function removePair(list, pair) {
  return list.filter(function (item) { return item !== pair; });
}
