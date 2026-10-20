import { detectShortSetup, evaluateShortStrategy } from "./short-strategy.mjs";

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
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && !value.trim())) return null;
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
  const hasGaps = candles.some(function (candle, index) {
    return index > 0 && candle.time - candles[index - 1].time !== seconds;
  });
  const quality = suspect || duplicates > 0 ? QUALITY.SUSPECT :
    candles.length === 0 ? QUALITY.NO_DATA :
    nowSeconds - (candles[candles.length - 1].time + seconds) >= seconds ? QUALITY.STALE :
      hasGaps ? QUALITY.INCOMPLETE : QUALITY.OK;
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

export function calculateContractMetrics(stats, timeAnchors) {
  const rows = stats && Array.isArray(stats.rows) ? stats.rows : [];
  const quality = stats && stats.quality ? stats.quality : QUALITY.NO_DATA;
  const latest = rows.length ? rows[rows.length - 1] : null;
  function valueAtOrBefore(target, field) {
    if (!latest) return null;
    let match = null;
    rows.forEach(function (row) {
      if (row.time <= target && target - row.time < 300 &&
          (!match || row.time > match.time)) match = row;
    });
    return match;
  }
  function change(field, ageSeconds, anchor) {
    const endTime = finite(anchor) ? anchor : latest && latest.time;
    if (!finite(endTime)) return null;
    const current = valueAtOrBefore(endTime, field);
    const previous = valueAtOrBefore(endTime - ageSeconds, field);
    return current && previous && current.time - previous.time === ageSeconds ?
      relativeChange(current[field], previous[field]) : null;
  }
  function ratioChange(field, ageSeconds, anchor) {
    const endTime = finite(anchor) ? anchor : latest && latest.time;
    if (!finite(endTime)) return null;
    const current = valueAtOrBefore(endTime, field);
    const previous = valueAtOrBefore(endTime - ageSeconds, field);
    return current && previous && previous[field] !== 0 ? relativeChange(current[field], previous[field]) : null;
  }
  return {
    quality: quality,
    source: "/futures/usdt/contract_stats",
    intervalSeconds: 300,
    oiUnit: "contracts",
    liquidationUnit: "USDT",
    time: latest ? latest.time : null,
    openInterest: latest && finite(latest.openInterest) ? latest.openInterest : null,
    openInterestUsd: latest && finite(latest.openInterestUsd) ? latest.openInterestUsd : null,
    oiChanges: {
      "15m": change("openInterest", 900, timeAnchors && timeAnchors["15m"]),
      "1h": change("openInterest", 3600, timeAnchors && timeAnchors["1h"]),
      "4h": change("openInterest", 14400, timeAnchors && timeAnchors["4h"])
    },
    lsrAccount: latest && finite(latest.lsrAccount) ? latest.lsrAccount : null,
    lsrTaker: latest && finite(latest.lsrTaker) ? latest.lsrTaker : null,
    lsrAccountChange15m: ratioChange("lsrAccount", 900, timeAnchors && timeAnchors["15m"]),
    longLiquidationUsd: latest && finite(latest.longLiquidationUsd) ? latest.longLiquidationUsd : null,
    shortLiquidationUsd: latest && finite(latest.shortLiquidationUsd) ? latest.shortLiquidationUsd : null,
    markPrice: latest && finite(latest.markPrice) ? latest.markPrice : null,
    history: rows.filter(function (row) {
      return finite(row.time) && finite(row.openInterest);
    }).map(function (row) {
      return { time: row.time, openInterest: row.openInterest };
    })
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

export function calculateLevels(candles, setup = detectShortSetup(candles)) {
  if (!candles || candles.length < 15) return null;
  if (!setup || !Number.isInteger(setup.startIndex) ||
      setup.startIndex < Math.max(0, candles.length - 9) ||
      setup.startIndex >= candles.length) return null;
  const indicators = calculateIndicators(candles);
  if (!finite(indicators.atr) || indicators.atr <= 0) return null;
  const recent = candles.slice(setup.startIndex);
  const entry = candles[candles.length - 1].close;
  const invalidationCandle = recent.reduce(function (highest, candle) {
    return candle.high > highest.high ? candle : highest;
  });
  const localHigh = invalidationCandle.high;
  const stop = localHigh + indicators.atr * 0.2;
  const risk = stop - entry;
  const supports = Array.from(new Set(localSupport(candles, entry)));
  const tp1 = supports.length ? supports[0] : null;
  const reason = !finite(risk) || localHigh <= entry ? "немає локального рівня інвалідації вище Entry" :
    risk > indicators.atr * 3 ? "Stop надто далекий: " + (risk / indicators.atr).toFixed(2) + " ATR > 3 ATR" :
      !supports.length ? "немає локальної підтримки нижче Entry для TP1" :
        supports.length < 3 ? "немає трьох різних локальних підтримок для TP1/TP2/TP3" : null;
  if (reason) return {
    entry: entry, stop: stop, tp1: tp1, tp2: null, tp3: null,
    riskReward: null, atr: indicators.atr, support: tp1,
    invalidation: localHigh, sourceTime: invalidationCandle.time, valid: false, reason: reason
  };
  const tp2 = supports[1];
  const tp3 = supports[2];
  const valid = [entry, stop, tp1, tp2, tp3].every(function (value) {
    return finite(value) && value > 0;
  }) && stop > entry && entry > tp1 && tp1 > tp2 && tp2 > tp3;
  return {
    entry: entry, stop: stop, tp1: tp1, tp2: tp2, tp3: tp3,
    riskReward: valid ? (entry - tp1) / risk : null,
    atr: indicators.atr,
    support: supports[0],
    invalidation: localHigh, sourceTime: invalidationCandle.time,
    valid: valid, reason: valid ? null : "некоректний порядок або значення Entry/Stop/TP"
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

function hasHistoricalPump(candles) {
  const baselineLength = 20;
  const pumpWindowLength = 3;
  const recentWindowLength = 3;
  if (candles.length < baselineLength + pumpWindowLength + recentWindowLength) return null;
  for (let end = candles.length - recentWindowLength - 1;
    end >= baselineLength + pumpWindowLength - 1; end -= 1) {
    const start = end - pumpWindowLength + 1;
    const baseline = candles.slice(start - baselineLength, start).map(function (candle) {
      return candle.volume;
    });
    const pumpWindow = candles.slice(start, end + 1);
    if (!baseline.every(finite) || !pumpWindow.every(function (candle) { return finite(candle.volume); })) continue;
    const baselineVolume = average(baseline);
    const pumpVolume = average(pumpWindow.map(function (candle) { return candle.volume; }));
    const priceChange = relativeChange(pumpWindow[pumpWindow.length - 1].close, pumpWindow[0].open);
    if (baselineVolume > 0 && finite(priceChange) && priceChange >= 2 && pumpVolume / baselineVolume >= 1.5) {
      return true;
    }
  }
  return false;
}

function classifyPumpStage(data, strategy, usableCandles) {
  const candles = data.candles15;
  const indicators = data.indicators;
  const missing = [];
  const hasUsableRvol = finite(data.volumeRatio) && data.volumeRatio >= 0;
  const volumeEvidence = hasUsableRvol ?
    "RVOL " + data.volumeRatio.toFixed(2) + "× від середнього 20 попередніх закритих 15m свічок" :
    "RVOL недоступний";
  if (!hasUsableRvol) missing.push("відносний обсяг (RVOL) недоступний");
  if (data.ticker.quality !== QUALITY.OK) missing.push("ticker недоступний або має неякісні дані");
  if (data.stats.quality !== QUALITY.OK || !finite(data.oiChange15m)) {
    missing.push("OI/деривативи недоступні або неякісні");
  }
  if (!finite(data.fundingNormalized)) missing.push("funding або його інтервал недоступний");
  if (!usableCandles || data.qualities["15m"] !== QUALITY.OK || candles.length < 7) {
    if (data.qualities["15m"] !== QUALITY.OK) {
      missing.push("якість свічок 15m: " + data.qualities["15m"]);
    } else if (candles.length < 7) {
      missing.push("потрібні щонайменше 7 закритих 15m свічок");
    }
    return {
      key: "insufficient",
      label: "Даних недостатньо",
      supportingShort: [],
      againstShort: [],
      missing: missing,
      priceMomentum: "не оцінено через недостатню або неякісну історію",
      volumeEvidence: volumeEvidence,
      continuationRisk: "неможливо оцінити: історія 15m недостатня або неякісна"
    };
  }

  const confirmedPriorPump = hasHistoricalPump(candles) === true;
  if (candles.length < 26) {
    missing.push("потрібні щонайменше 26 закритих 15m свічок для перевірки історичного пампу");
  }

  const latest = candles[candles.length - 1];
  const previousBlock = candles.slice(-6, -3);
  const recentBlock = candles.slice(-3);
  const previousHigh = Math.max.apply(null, previousBlock.map(function (candle) { return candle.high; }));
  const recentHigh = Math.max.apply(null, recentBlock.map(function (candle) { return candle.high; }));
  const atr = indicators.atr;
  const lowerHigh = previousHigh > recentHigh &&
    previousHigh - recentHigh >= Math.max(previousHigh * 0.002, finite(atr) ? atr * 0.15 : 0);
  const supportBreak = findBreakdown(candles);
  const failedHighBreak = strategy.setup && strategy.setup.type === "failed_high_break";
  const structureWeak = lowerHigh || supportBreak || failedHighBreak;
  const meanVolume = function (series) {
    const values = series.map(function (candle) { return candle.volume; });
    return values.every(finite) ? average(values) : null;
  };
  const priorVolume = meanVolume(previousBlock);
  const recentVolume = meanVolume(recentBlock);
  const volumeFading = finite(priorVolume) && priorVolume > 0 &&
    finite(recentVolume) && recentVolume < priorVolume * 0.7 && recentHigh <= previousHigh;
  const upperWick = recentBlock.some(function (candle) { return upperWickRatio(candle) >= 0.55; });
  const bearishMomentum = Boolean(indicators.macd && indicators.macd.bearishCross && upperWick);
  const momentumWeak = Boolean(indicators.obvDivergence || volumeFading || bearishMomentum);
  const reversalConfirmed = confirmedPriorPump && supportBreak && latest.close < latest.open;
  const distributionPossible = confirmedPriorPump && structureWeak && momentumWeak;
  const previous45mReturn = relativeChange(candles[candles.length - 4].close, candles[candles.length - 7].close);
  const recent45mReturn = relativeChange(candles[candles.length - 1].close, candles[candles.length - 4].close);
  const positivePrice = finite(recent45mReturn) && recent45mReturn > 0;
  const decelerating = finite(previous45mReturn) && previous45mReturn > 0 &&
    finite(recent45mReturn) && recent45mReturn >= 0 && recent45mReturn < previous45mReturn * 0.75;
  const activeUptrend = latest.close > latest.open && positivePrice &&
    !structureWeak && !momentumWeak && !decelerating;
  const exhaustionWatch = (confirmedPriorPump || positivePrice) &&
    (structureWeak || momentumWeak || decelerating || upperWick ||
      (finite(indicators.rsi) && indicators.rsi >= 75 && !activeUptrend));

  const supportingShort = [];
  const againstShort = [];
  if (supportBreak) supportingShort.push("закриття 15m нижче мінімумів попередніх трьох свічок");
  if (lowerHigh) supportingShort.push("максимуми останніх трьох свічок нижчі за попередній локальний блок");
  if (failedHighBreak) supportingShort.push("невдалий пробій локального максимуму");
  if (indicators.obvDivergence) supportingShort.push("OBV не підтверджує локальний максимум ціни");
  if (volumeFading) supportingShort.push("середній обсяг останніх трьох свічок слабший за попередній блок");
  if (bearishMomentum) supportingShort.push("ведмежий перетин MACD разом із верхньою тінню");
  if (decelerating) {
    supportingShort.push("темп зростання ціни за останні 45 хв сповільнився порівняно з попередніми 45 хв");
  }
  if (latest.close > latest.open && positivePrice) {
    againstShort.push("остання 15m свічка зростає та короткострокова зміна ціни позитивна");
  }
  if (hasUsableRvol && data.volumeRatio >= 1.5 && !structureWeak) {
    againstShort.push("загальний обсяг підвищений, а структура підтримки не зламана");
  }
  if (finite(indicators.rsi) && indicators.rsi >= 75 && activeUptrend) {
    againstShort.push("високий RSI не переважає чинний висхідний імпульс і сам не є сигналом SHORT");
  }
  if (!indicators.macd || !finite(indicators.rsi)) missing.push("RSI/MACD: недостатньо свічкової історії");
  const priceMomentum = decelerating ?
    "за останні 45 хв +" + recent45mReturn.toFixed(2) + "% проти +" + previous45mReturn.toFixed(2) +
      "% за попередні 45 хв" :
    finite(recent45mReturn) && recent45mReturn > 0 ?
      "позитивні " + recent45mReturn.toFixed(2) + "% за останні 45 хв; уповільнення не підтверджено" :
      "позитивне зростання за останні 45 хв не підтверджено";
  const volumeContinuation = hasUsableRvol ?
    (data.volumeRatio >= 1.5 ? "RVOL підвищений: " : "RVOL не підвищений: ") + volumeEvidence :
    "обсяг не підтверджений: " + volumeEvidence;

  let key = "none";
  let label = "Немає сетапу";
  if (reversalConfirmed) {
    key = "reversal";
    label = "Розворот підтверджено";
  } else if (distributionPossible) {
    key = "distribution";
    label = "Можливий розподіл";
  } else if (activeUptrend) {
    key = "active";
    label = "Памп триває";
  } else if (exhaustionWatch) {
    key = "exhaustion";
    label = "Увага: можливе виснаження";
  }

  return {
    key: key,
    label: label,
    supportingShort: supportingShort,
    againstShort: againstShort,
    missing: missing,
    priceMomentum: priceMomentum,
    volumeEvidence: volumeEvidence,
    continuationRisk: !hasUsableRvol ? "неможливо оцінити: RVOL недоступний" :
      reversalConfirmed ? "структура ціни зламана; squeeze-ризик залишається" :
        activeUptrend ? "підвищений через позитивний імпульс ціни; " + volumeContinuation :
          confirmedPriorPump ? "залишається: розворот ще не підтверджено" : "не підвищений за наявними даними"
  };
}

export function signalState(pump, exhaustion, breakdown, confirmed, hasData, shortReady) {
  if (!hasData) return { key: "incomplete", label: "Дані недоступні", score: 0 };
  if (shortReady && pump >= 45 && exhaustion >= 60 && breakdown && confirmed) return { key: "entry", label: "SHORT підтверджено", score: 80 };
  if (shortReady && pump >= 45 && exhaustion >= 55 && breakdown) return { key: "setup", label: "Пробій · очікування підтвердження", score: 65 };
  if (pump >= 55 && exhaustion >= 45) return { key: "exhaustion", label: "Виснаження · очікування пробою", score: 45 };
  if (pump >= 65) return { key: "hot", label: "Перегрів", score: 25 };
  if (pump >= 45) return { key: "pump", label: "Памп формується", score: 10 };
  if (pump >= 25) return { key: "watch", label: "Памп формується · ранній рух", score: 0 };
  return { key: "none", label: "Спокійний ринок", score: 0 };
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
  const timeAnchors = {};
  ["15m", "1h", "4h"].forEach(function (interval) {
    const series = normalized[interval];
    if (series.length) timeAnchors[interval] = series[series.length - 1].time + INTERVAL_SECONDS[interval];
  });
  const stats = calculateContractMetrics(input.stats, timeAnchors);
  const currentOi = stats.openInterest;
  const oiChanges = stats.oiChanges;
  const oiChange15m = finite(oiChanges["15m"]) ? oiChanges["15m"] : null;
  const fundingInterval = finite(input.fundingIntervalSeconds) && input.fundingIntervalSeconds > 0 ?
    input.fundingIntervalSeconds : null;
  const fundingNormalized = finite(ticker.funding) && fundingInterval ?
    ticker.funding * (28800 / fundingInterval) : null;
  const funding = {
    source: "/futures/usdt/tickers.funding_rate",
    unit: "decimal",
    raw: finite(ticker.funding) ? ticker.funding : null,
    intervalSeconds: fundingInterval,
    normalized: finite(fundingNormalized) ? fundingNormalized : null,
    normalizedIntervalSeconds: 28800,
    fetchedAt: ticker.fetchedAt
  };
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
    orderBook: input.orderBook || { quality: QUALITY.NO_DATA },
    oiChanges: oiChanges,
    oiChange15m: oiChange15m,
    fundingIntervalSeconds: fundingInterval,
    fundingNormalized: funding.normalized,
    funding: funding,
    nowSeconds: input.nowSeconds,
    minimumRiskReward: finite(input.minimumRiskReward) && input.minimumRiskReward >= 1 &&
      input.minimumRiskReward <= 5 ? input.minimumRiskReward : 1.5,
    takerFeeRate: input.takerFeeRate
  };
  const pump = scorePump(changes, ratio);
  const exhaustion = normalized["15m"].length ?
    (pump >= 30 ? scoreExhaustion(data) : 0) : 0;
  const breakdown = normalized["15m"].length ? findBreakdown(normalized["15m"]) : false;
  const provisionalLevels = normalized["15m"].length >= 15 ? calculateLevels(normalized["15m"]) : null;
  const strategy = evaluateShortStrategy({
    candles: normalized,
    changes: changes,
    oiChanges: oiChanges,
    stats: stats,
    ticker: ticker,
    orderBook: data.orderBook,
    qualities: qualities,
    volumeRatio: ratio,
    indicators: indicators,
    fundingNormalized: funding.normalized,
    nowSeconds: input.nowSeconds,
    levels: provisionalLevels,
    takerFeeRate: input.takerFeeRate,
    minimumRiskReward: data.minimumRiskReward
  });
  const confirmed = strategy.allowed;
  const primaryQuality = qualities["15m"];
  const usableCandles = normalized["15m"].length > 0 && primaryQuality !== QUALITY.STALE &&
    primaryQuality !== QUALITY.SUSPECT && ticker.quality !== QUALITY.CONFLICT;
  const shortReady = usableCandles && primaryQuality === QUALITY.OK && finite(ratio) &&
    normalized["15m"].length >= 35 && indicators.macd !== null && ticker.quality === QUALITY.OK &&
    finite(ticker.last) && finite(currentOi) && finite(oiChange15m) &&
    qualities["1h"] === QUALITY.OK && qualities["4h"] === QUALITY.OK &&
    finite(changes["1h"]) && finite(changes["4h"]) &&
    finite(oiChanges["1h"]) && finite(oiChanges["4h"]) &&
    stats.quality === QUALITY.OK && data.orderBook.quality === QUALITY.OK;
  let state = signalState(pump, exhaustion, breakdown, confirmed, usableCandles, shortReady);
  if (strategy.allowed) {
    state = { key: "entry", label: "SHORT ENTRY · " + strategy.setup.type, score: 80 };
  } else if (!strategy.dataReady && strategy.setup) {
    state = { key: "incomplete", label: "NO TRADE — DATA UNAVAILABLE", score: 0 };
  } else if (strategy.setup) {
    state = { key: "setup", label: strategy.setupStatus + " · NO TRADE", score: 45 };
  }
  const stage = classifyPumpStage(data, strategy, usableCandles);
  const levels = strategy.setup && provisionalLevels && provisionalLevels.valid ?
    Object.assign({}, provisionalLevels, {
      riskReward: strategy.riskReward,
      netRiskReward: strategy.netRiskReward
    }) : null;
  const shortScore = strategy.score;
  const why = explain(data, pump, exhaustion, state, strategy);
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
    stage: stage,
    breakdown: breakdown,
    confirmed: confirmed,
    levels: levels,
    strategy: strategy,
    why: why,
    confidence: confidence,
    quality: overallQuality(data) === QUALITY.OK && !strategy.dataReady ?
      QUALITY.INCOMPLETE : overallQuality(data)
  };
}

function overallQuality(data) {
  if (data.ticker.quality === QUALITY.CONFLICT) return QUALITY.CONFLICT;
  if (data.qualities["15m"] === QUALITY.STALE) return QUALITY.STALE;
  if (data.qualities["15m"] === QUALITY.SUSPECT) return QUALITY.SUSPECT;
  if (data.stats.quality === QUALITY.STALE) return QUALITY.STALE;
  if (data.stats.quality === QUALITY.SUSPECT) return QUALITY.SUSPECT;
  if (!data.orderBook || data.orderBook.quality !== QUALITY.OK) return QUALITY.INCOMPLETE;
  if (!finite(data.ticker.last) || !finite(data.stats.openInterest) ||
      !finite(data.oiChanges["15m"])) return QUALITY.INCOMPLETE;
  if (!finite(data.volumeRatio) || Object.keys(data.changes).some(function (interval) {
    return !finite(data.changes[interval]);
  }) || data.stats.quality !== QUALITY.OK) return QUALITY.INCOMPLETE;
  return QUALITY.OK;
}

function explain(data, pump, exhaustion, state, strategy) {
  const parts = [];
  if (state.key === "incomplete") {
    return "Дані недоступні або недостатньої якості для надійної оцінки (15m свічки: " +
      data.qualities["15m"] + ", ticker: " + (data.ticker.quality || QUALITY.NO_DATA) +
      ", contract stats: " + data.stats.quality + ", order book: " +
      (data.orderBook.quality || QUALITY.NO_DATA) + "). NO TRADE — DATA UNAVAILABLE. " +
      "Конкретні причини наведені в блоці стратегії.";
  }
  const main = data.changes["1h"];
  if (finite(main) && main > 0) parts.push("Ціна " + (main >= 0 ? "+" : "") + main.toFixed(2) + "% за 1h");
  if (finite(data.volumeRatio)) parts.push("обсяг " + data.volumeRatio.toFixed(1) + "x від бази");
  if (data.stats.quality === QUALITY.OK && finite(data.oiChange15m)) {
    parts.push("OI " + (data.oiChange15m >= 0 ? "+" : "") + data.oiChange15m.toFixed(2) + "% за 15m");
  }
  else parts.push("зміна OI накопичується");
  const price15 = data.changes["15m"];
  if (data.stats.quality === QUALITY.OK && finite(price15) && price15 > 0 && finite(data.oiChange15m)) {
    if (data.oiChange15m > 0) parts.push("ціна ↑ + OI ↑ — нарощування позицій");
    else if (data.oiChange15m < 0) parts.push("ціна ↑ + OI ↓ — можливий SHORT squeeze");
  }
  if ((finite(main) && main < 0 && finite(data.changes["1h"]) && data.changes["1h"] >= 3) ||
      (finite(data.changes["15m"]) && finite(data.changes["5m"]) &&
       data.changes["15m"] > 0 && data.changes["5m"] < data.changes["15m"] * 0.35)) {
    parts.push("momentum сповільнюється або розвернувся");
  }
  if (strategy && strategy.matrix) {
    parts.push("Price × OI 15m/1h/4h: " + strategy.matrix["15m"].label + " / " +
      strategy.matrix["1h"].label + " / " + strategy.matrix["4h"].label);
  }
  if (strategy && strategy.setup) parts.push("сетап: " + strategy.setup.type + " біля " +
    strategy.setup.level.toFixed(6));
  if (state.key === "entry") parts.push("усі обов’язкові блокувальні перевірки пройдено");
  if (state.key === "setup") parts.push("є сетап; SHORT ENTRY ще не дозволено");
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
  if (state.key === "watch" || state.key === "pump") {
    parts.push("SHORT не підтверджено: потрібні ознаки виснаження та закритий пробій підтримки");
  } else if (state.key === "hot") {
    parts.push("Перегрів сам по собі не є SHORT-сигналом; чекаємо виснаження та пробою підтримки");
  } else if (state.key === "exhaustion") {
    parts.push("Імпульс виснажується, але потрібен закритий пробій підтримки для SHORT");
  }
  if (pump < 25) return "Немає підтвердженого пампу. " + (finite(data.volumeRatio) ? "Ціна й обсяг не показують достатньої аномалії." : "Для оцінки обсягу недостатньо закритих свічок.");
  return parts.length ? parts.join(" · ") : "Є аномальний рух ціни, але підтвердження обсягом/виснаженням обмежене.";
}

export function transitionSignal(current, previous, lastCandleTime) {
  if (!current || !current.data || !current.data.candles15.length) return current;
  const candleTime = current.data.candles15[current.data.candles15.length - 1].time;
  if (current.strategy && previous && previous.strategy) {
    const matrixTransitions = {};
    ["15m", "1h", "4h"].forEach(function (interval) {
      const oldMatrix = previous.strategy.matrix && previous.strategy.matrix[interval];
      const newMatrix = current.strategy.matrix && current.strategy.matrix[interval];
      matrixTransitions[interval] = oldMatrix && newMatrix && oldMatrix.label !== newMatrix.label ?
        oldMatrix.label + " → " + newMatrix.label : null;
    });
    current.strategy = Object.assign({}, current.strategy, { matrixTransitions: matrixTransitions });
  }
  if (previous && (previous.state.key === "setup" || previous.state.key === "entry") &&
      previous.levels && current.data.candles15[current.data.candles15.length - 1].close >= previous.levels.stop) {
    return Object.assign({}, current, {
      state: { key: "cancelled", label: "SHORT скасовано", score: 0 },
      confirmed: false,
      shortScore: 0,
      levels: null,
      strategy: Object.assign({}, current.strategy, {
        allowed: false,
        status: "NO TRADE",
        blockers: (current.strategy && current.strategy.blockers || []).concat(
          "ціна закрилася вище Stop / рівня інвалідації"
        )
      }),
      why: "Закриття 15m вище STOP / рівня інвалідації. Попередній SHORT-сценарій скасовано."
    });
  }
  if (previous && lastCandleTime === candleTime) {
    current.candleTime = candleTime;
    current.unchangedCandle = true;
    current.stateChanged = previous.state.key !== current.state.key;
    return current;
  }
  if (previous && previous.state.key === "cancelled" && current.state.key === "none") {
    current.state = { key: "cancelled", label: "CANCEL", score: 0 };
    current.shortScore = 0;
  }
  current.candleTime = candleTime;
  current.unchangedCandle = false;
  current.stateChanged = Boolean(previous && previous.state.key !== current.state.key);
  return current;
}

const SIGNAL_PRIORITY = Object.freeze({
  entry: 7,
  setup: 6,
  exhaustion: 5,
  hot: 4,
  pump: 3,
  watch: 2,
  none: 1,
  cancelled: 0,
  incomplete: -1
});

export function sortPairsBySignal(pairs, models) {
  return pairs.map(function (pair, index) {
    return { pair: pair, index: index, model: models[pair] };
  }).sort(function (a, b) {
    const aPriority = a.model ? SIGNAL_PRIORITY[a.model.state.key] ?? -1 : -1;
    const bPriority = b.model ? SIGNAL_PRIORITY[b.model.state.key] ?? -1 : -1;
    if (aPriority !== bPriority) return bPriority - aPriority;
    for (const scoreName of ["shortScore", "exhaustionScore", "pumpScore"]) {
      const aScore = finite(a.model && a.model[scoreName]) ? a.model[scoreName] : -1;
      const bScore = finite(b.model && b.model[scoreName]) ? b.model[scoreName] : -1;
      if (aScore !== bScore) return bScore - aScore;
    }
    return a.index - b.index;
  }).map(function (item) { return item.pair; });
}

export function rankPumpCandidates(tickers, activeContracts, limit, minimumChange, minimumVolume) {
  if (!Array.isArray(tickers) || !Array.isArray(activeContracts)) return [];
  const allowed = new Set(activeContracts);
  const candidates = [];
  tickers.forEach(function (ticker) {
    if (!ticker || typeof ticker.contract !== "string" || !allowed.has(ticker.contract) ||
        !/^[A-Z0-9]+_USDT$/.test(ticker.contract)) return;
    const change = number(ticker.change_percentage);
    const volume = number(ticker.volume_24h_quote);
    if (!finite(change) || !finite(volume) || change < minimumChange || volume < minimumVolume) return;
    candidates.push({
      contract: ticker.contract,
      changePercentage: change,
      volume24hQuote: volume
    });
  });
  candidates.sort(function (a, b) {
    return b.changePercentage - a.changePercentage ||
      b.volume24hQuote - a.volume24hQuote ||
      a.contract.localeCompare(b.contract);
  });
  return candidates.slice(0, Math.max(0, Math.floor(limit)));
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
