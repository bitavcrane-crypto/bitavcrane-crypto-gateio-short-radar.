const FLAT_THRESHOLD = 0.1;
const MIN_BOOK_DEPTH_USD = 10000;
const MIN_DAILY_VOLUME_USD = 1000000;
const MAX_SPREAD_PERCENT = 0.2;
const MAX_SLIPPAGE_PERCENT = 0.15;
const INTERVAL_SECONDS = { "15m": 900, "1h": 3600, "4h": 14400 };

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function scenarioLabel(priceChange, oiChange) {
  if (!finite(priceChange) || !finite(oiChange)) return "DATA UNAVAILABLE";
  const priceDirection = priceChange > FLAT_THRESHOLD ? 1 :
    priceChange < -FLAT_THRESHOLD ? -1 : 0;
  const oiDirection = oiChange > FLAT_THRESHOLD ? 1 :
    oiChange < -FLAT_THRESHOLD ? -1 : 0;
  if (!priceDirection && !oiDirection) return "PRICE FLAT · OI FLAT";
  if (!priceDirection) return oiDirection > 0 ? "PRICE FLAT · OI ↑" :
    oiDirection < 0 ? "PRICE FLAT · OI ↓" : "PRICE FLAT · OI FLAT";
  if (!oiDirection) return priceDirection > 0 ? "PRICE ↑ · OI FLAT" : "PRICE ↓ · OI FLAT";
  if (priceDirection > 0 && oiDirection > 0) return "PRICE ↑ · OI ↑";
  if (priceDirection > 0 && oiDirection < 0) return "PRICE ↑ · OI ↓";
  if (priceDirection < 0 && oiDirection > 0) return "PRICE ↓ · OI ↑";
  return "PRICE ↓ · OI ↓";
}

export function classifyPriceOi(priceChange, oiChange) {
  if (!finite(priceChange) || !finite(oiChange)) {
    return { key: "unavailable", label: "DATA UNAVAILABLE" };
  }
  const priceDirection = priceChange > FLAT_THRESHOLD ? 1 :
    priceChange < -FLAT_THRESHOLD ? -1 : 0;
  const oiDirection = oiChange > FLAT_THRESHOLD ? 1 :
    oiChange < -FLAT_THRESHOLD ? -1 : 0;
  const key = !priceDirection ? (!oiDirection ? "flat_flat" : oiDirection > 0 ? "flat_up" : "flat_down") :
    !oiDirection ? (priceDirection > 0 ? "up_flat" : "down_flat") :
      priceDirection > 0 ? (oiDirection > 0 ? "up_up" : "up_down") :
        (oiDirection > 0 ? "down_up" : "down_down");
  const magnitude = Math.max(Math.abs(priceChange), Math.abs(oiChange));
  const strength = key === "flat_flat" ? "НЕЗМІННІ" :
    magnitude >= 3 ? "РІЗКІ ЗМІНИ" : magnitude < 0.5 ? "СЛАБКІ ЗМІНИ" : "ПОМІРНІ ЗМІНИ";
  return { key: key, strength: strength, label: scenarioLabel(priceChange, oiChange) + " · " + strength };
}

function candlesBearish(candles) {
  if (!Array.isArray(candles) || candles.length < 4) return false;
  const latest = candles[candles.length - 1];
  const previous = candles.slice(-4, -1);
  const priorLow = Math.min.apply(null, previous.map(function (candle) { return candle.low; }));
  return latest.close < latest.open && latest.close < priorLow;
}

function bearishOneHour(candles) {
  if (!Array.isArray(candles) || candles.length < 4) return false;
  const latest = candles[candles.length - 1];
  const previous = candles.slice(-4, -1);
  const lowerCloses = latest.close < previous[previous.length - 1].close &&
    previous[previous.length - 1].close <= previous[0].close;
  const brokeSupport = latest.close < Math.min.apply(null, previous.map(function (candle) {
    return candle.low;
  }));
  return lowerCloses || brokeSupport;
}

function bullishFourHour(candles, change) {
  if (!Array.isArray(candles) || candles.length < 4) return false;
  const latest = candles[candles.length - 1];
  const previous = candles.slice(-4, -1);
  const risingStructure = latest.high > previous[2].high && previous[2].high > previous[1].high &&
    latest.low > previous[2].low && previous[2].low > previous[1].low;
  return (finite(change) && change >= 2.5) || risingStructure;
}

function findBreakdown(candles) {
  if (!candlesBearish(candles)) return null;
  const latest = candles[candles.length - 1];
  const previous = candles.slice(-4, -1);
  const level = Math.min.apply(null, previous.map(function (candle) { return candle.low; }));
  return latest.close < level ? { type: "support_break", level: level, startIndex: candles.length - 4 } : null;
}

function findFailedRetest(candles) {
  if (!Array.isArray(candles) || candles.length < 8) return null;
  const latestIndex = candles.length - 1;
  const latest = candles[latestIndex];
  if (latest.close >= latest.open) return null;
  for (let index = Math.max(3, latestIndex - 8); index < latestIndex - 1; index += 1) {
    const base = candles.slice(Math.max(0, index - 3), index);
    if (base.length < 3) continue;
    const level = Math.min.apply(null, base.map(function (candle) { return candle.low; }));
    const next = candles[index];
    if (next.close >= level) continue;
    const nearLevel = Math.abs(latest.high / level - 1) <= 0.01;
    if (nearLevel && latest.high >= level && latest.close < level) {
      return { type: "failed_retest", level: level, startIndex: latestIndex };
    }
  }
  return null;
}

function findFailedHighBreak(candles) {
  if (!Array.isArray(candles) || candles.length < 8) return null;
  const latest = candles[candles.length - 1];
  if (latest.close >= latest.open) return null;
  for (let index = candles.length - 1; index >= Math.max(3, candles.length - 8); index -= 1) {
    const earlier = candles.slice(Math.max(0, index - 5), index);
    const level = Math.max.apply(null, earlier.map(function (item) { return item.high; }));
    const swept = candles[index];
    if (swept.high > level && swept.close < level && latest.close < level) {
      return { type: "failed_high_break", level: level, startIndex: index };
    }
  }
  return null;
}

export function detectShortSetup(candles) {
  if (!Array.isArray(candles) || !candles.every(function (candle) {
    return candle && ["open", "high", "low", "close"].every(function (field) {
      return finite(candle[field]) && candle[field] > 0;
    }) && candle.low <= Math.min(candle.open, candle.close) &&
      candle.high >= Math.max(candle.open, candle.close);
  })) return null;
  const setup = findFailedRetest(candles) || findFailedHighBreak(candles) || findBreakdown(candles);
  if (!setup) return null;
  const invalidationCandle = candles.slice(setup.startIndex).reduce(function (highest, candle) {
    return candle.high > highest.high ? candle : highest;
  });
  const latest = candles[candles.length - 1];
  const range = latest.high - latest.low;
  return Object.assign(setup, {
    invalidation: invalidationCandle.high,
    sourceTime: finite(invalidationCandle.time) ? invalidationCandle.time : null,
    confirmed: latest.close < latest.open && range > 0 && (latest.close - latest.low) / range <= 0.5
  });
}

function scoreShort(input, flags) {
  let score = 0;
  const reasons = [];
  const missing = [];
  const add = function (points, reason) {
    score += points;
    reasons.push("+" + points + " " + reason);
  };
  if (flags.bearish1h) add(15, "ведмежа структура 1h");
  if (flags.bearish15m) add(10, "підтвердження 15m");
  if (finite(input.volumeRatio) && input.volumeRatio >= 1.5 && flags.sellingCandle) {
    add(15, "продажі на підвищеному обсязі");
  }
  if (flags.matrix["1h"].key === "down_up" || flags.matrix["4h"].key === "down_up") {
    add(15, "падіння ціни зі зростанням OI");
  } else if (flags.matrix["1h"].key === "down_down" || flags.matrix["4h"].key === "down_down") {
    add(8, "падіння ціни зі скороченням OI");
  }
  if (input.indicators && finite(input.indicators.rsi)) add(input.indicators.rsi < 50 ? 6 : 0,
    input.indicators.rsi < 50 ? "RSI нижче 50" : "RSI не підтверджує ведмежий імпульс");
  else missing.push("indicators.rsi");
  if (input.indicators && input.indicators.macd && finite(input.indicators.macd.histogram)) add(input.indicators.macd.histogram < 0 ? 5 : 0,
    input.indicators.macd.histogram < 0 ? "MACD bearish" : "MACD не bearish");
  else missing.push("indicators.macd.histogram");
  if (input.indicators && typeof input.indicators.obvDivergence === "boolean") {
    add(input.indicators.obvDivergence ? 4 : 0, input.indicators.obvDivergence ?
      "OBV не підтверджує максимум" : "OBV-дивергенція відсутня");
  } else missing.push("indicators.obvDivergence");
  if (finite(input.fundingNormalized) && input.stats && input.stats.quality === "OK" &&
      finite(input.stats.lsrAccount) && input.stats.lsrAccount >= 0) {
    add(input.fundingNormalized >= 0 && input.stats.lsrAccount >= 1 ? 10 : 0,
      input.fundingNormalized >= 0 && input.stats.lsrAccount >= 1 ?
        "funding/позиціонування не суперечать SHORT" : "funding/позиціонування не дають переваги SHORT");
  }
  if (flags.setupConfirmed) add(10, "підтверджено " + flags.setup.type);
  if (flags.liquidity.passed) add(10, "ліквідність і спред придатні");
  return {
    value: Math.min(100, score),
    reasons: reasons,
    missing: missing
  };
}

function requiredData(input) {
  const missing = [];
  const require = function (valid, field) { if (!valid) missing.push(field); };
  const nonnegative = function (value) { return finite(value) && value >= 0; };
  const candles = input.candles || {};
  ["15m", "1h", "4h"].forEach(function (interval) {
    require(input.qualities && input.qualities[interval] === "OK", "qualities." + interval);
    require(finite((input.changes || {})[interval]), "changes." + interval);
    require(finite((input.oiChanges || {})[interval]), "oiChanges." + interval);
    const seconds = INTERVAL_SECONDS[interval];
    require(Array.isArray(candles[interval]) && candles[interval].length >= 4 &&
      candles[interval].every(function (candle, index, series) {
        return candle && ["open", "high", "low", "close"].every(function (field) {
          return finite(candle[field]) && candle[field] > 0;
        }) && candle.low <= Math.min(candle.open, candle.close) &&
          candle.high >= Math.max(candle.open, candle.close) && candle.high >= candle.low &&
          finite(candle.time) && candle.time > 0 &&
          candle.time + seconds <= input.nowSeconds &&
          (!index || candle.time - series[index - 1].time === seconds) &&
          (index !== series.length - 1 || input.nowSeconds - (candle.time + seconds) < seconds);
      }), "candles." + interval);
  });
  const stats = input.stats || {};
  const ticker = input.ticker || {};
  const book = input.orderBook || {};
  require(stats.quality === "OK", "stats.quality");
  require(finite(stats.time) && input.nowSeconds - stats.time >= 0 &&
    input.nowSeconds - stats.time <= 600, "stats.time");
  ["shortLiquidationUsd", "longLiquidationUsd", "lsrAccount"].forEach(function (field) {
    require(nonnegative(stats[field]), "stats." + field);
  });
  require(finite(input.fundingNormalized), "fundingNormalized");
  require(nonnegative(input.volumeRatio), "volumeRatio");
  require(ticker.quality === "OK", "ticker.quality");
  require(finite(ticker.last) && ticker.last > 0, "ticker.last");
  require(nonnegative(ticker.volume24h), "ticker.volume24h");
  require(book.quality === "OK", "orderBook.quality");
  ["depthUsd", "spreadPercent", "slippagePercent"].forEach(function (field) {
    require(nonnegative(book[field]), "orderBook." + field);
  });
  require(finite(input.nowSeconds) && input.nowSeconds > 0, "nowSeconds");
  [["orderBook", book, 30], ["ticker", ticker, 120]].forEach(function (item) {
    const timestamp = item[1].fetchedAt;
    const seconds = finite(timestamp) && timestamp > 1e11 ? timestamp / 1000 : timestamp;
    require(finite(seconds) && seconds > 0 && finite(input.nowSeconds) &&
      input.nowSeconds - seconds >= -5 && input.nowSeconds - seconds <= item[2],
    item[0] + ".fetchedAt");
  });
  return missing;
}

function validateLiquidity(input, missing) {
  const reasons = [];
  const book = input.orderBook || {};
  const ticker = input.ticker || {};
  const threshold = function (value, passes, field, rule) {
    if (finite(value) && value >= 0 && !passes) reasons.push(field + " = " + value + "; потрібно " + rule);
  };
  threshold(book.depthUsd, book.depthUsd >= MIN_BOOK_DEPTH_USD, "depthUsd", "≥ " + MIN_BOOK_DEPTH_USD + " USD");
  threshold(book.spreadPercent, book.spreadPercent <= MAX_SPREAD_PERCENT, "spreadPercent",
    "≤ " + MAX_SPREAD_PERCENT + "%");
  threshold(book.slippagePercent, book.slippagePercent <= MAX_SLIPPAGE_PERCENT, "slippagePercent",
    "≤ " + MAX_SLIPPAGE_PERCENT + "%");
  threshold(ticker.volume24h, ticker.volume24h >= MIN_DAILY_VOLUME_USD, "volume24h",
    "≥ " + MIN_DAILY_VOLUME_USD + " USD/24h");
  const unavailable = missing.filter(function (field) {
    return field.startsWith("orderBook.") || field.startsWith("ticker.") || field === "nowSeconds";
  });
  return {
    passed: !reasons.length && !unavailable.length,
    reasons: reasons.concat(unavailable.map(function (field) { return field + ": недоступне/некоректне або застаріле"; }))
  };
}

export function evaluateShortStrategy(input = {}) {
  const changes = input.changes || {};
  const oiChanges = input.oiChanges || {};
  const candles = input.candles || {};
  const matrix = {
    "15m": classifyPriceOi(changes["15m"], oiChanges["15m"]),
    "1h": classifyPriceOi(changes["1h"], oiChanges["1h"]),
    "4h": classifyPriceOi(changes["4h"], oiChanges["4h"])
  };
  const missing = requiredData(input);
  ["15m", "1h", "4h"].forEach(function (interval) {
    if (["qualities.", "candles.", "changes.", "oiChanges."].some(function (prefix) {
      return missing.includes(prefix + interval);
    })) matrix[interval] = classifyPriceOi(null, null);
  });
  const validCandles = function (interval) {
    return missing.includes("candles." + interval) ? [] : candles[interval];
  };
  const candles15 = validCandles("15m");
  const candles1h = validCandles("1h");
  const candles4h = validCandles("4h");
  const latest15 = candles15[candles15.length - 1];
  const latestRange = latest15 ? latest15.high - latest15.low : 0;
  const sellingCandle = Boolean(latest15 && latest15.close < latest15.open && latestRange > 0 &&
    (latest15.close - latest15.low) / latestRange <= 0.5);
  const bearish15m = candlesBearish(candles15);
  const bearish1h = bearishOneHour(candles1h);
  const strongBullish4h = bullishFourHour(candles4h, changes["4h"]);
  const setup = detectShortSetup(candles15);
  const structureReady = ["15m", "1h", "4h"].every(function (interval) {
    return ["qualities.", "changes.", "oiChanges.", "candles."].every(function (prefix) {
      return !missing.includes(prefix + interval);
    });
  });
  const setupConfirmed = Boolean(setup && setup.confirmed && sellingCandle && bearish1h &&
    finite(input.volumeRatio) && input.volumeRatio >= 1.5 && structureReady);
  const dataReady = missing.length === 0;
  const intervals = ["15m", "1h", "4h"];
  const rising = intervals.filter(function (interval) { return matrix[interval].key.startsWith("up_"); });
  const falling = intervals.filter(function (interval) { return matrix[interval].key.startsWith("down_"); });
  const matrixConflict = rising.length > 0 && falling.length > 0;
  const oiContradiction = rising.length > 0;
  const matrixValues = intervals.map(function (interval) {
    return "Price × OI " + interval + ": price=" + changes[interval] + "%, OI=" + oiChanges[interval] + "%";
  }).join("; ");
  const squeezeReasons = [];
  const stats = input.stats || {};
  if (stats.quality === "OK" && finite(stats.shortLiquidationUsd) && stats.shortLiquidationUsd > 0 &&
      finite(stats.longLiquidationUsd) && stats.longLiquidationUsd >= 0 &&
      stats.shortLiquidationUsd > stats.longLiquidationUsd * 3) {
    squeezeReasons.push("Ліквідації latest 5m: SHORT=" + stats.shortLiquidationUsd +
      " USD > 3 × LONG=" + stats.longLiquidationUsd + " USD, SHORT > 0 USD (окреме правило)");
  }
  if (stats.quality === "OK" && finite(input.fundingNormalized) && input.fundingNormalized <= -0.001 &&
      finite(stats.lsrAccount) && stats.lsrAccount >= 0 && stats.lsrAccount < 0.8) {
    squeezeReasons.push("Funding normalized=" + input.fundingNormalized + " decimal (" +
      (input.fundingNormalized * 100).toFixed(4) + "%/8h) ≤ -0.001 decimal (-0.1%/8h) AND L/S account=" +
      stats.lsrAccount + " < 0.8 (окреме правило; не ліквідації)");
  }
  const shortSqueezeRisk = squeezeReasons.length > 0;
  const liquidationFlush = ["15m", "1h", "4h"].some(function (interval) {
    return matrix[interval].key === "down_down" &&
      finite(changes[interval]) && changes[interval] <= -2 &&
      finite(oiChanges[interval]) && oiChanges[interval] <= -2;
  });
  const stretched = (finite(changes["4h"]) && changes["4h"] <= -8) ||
    Boolean(latest15 && latest15.open > 0 && (latest15.open - latest15.close) / latest15.open >= 0.04);
  const liquidity = validateLiquidity(input, missing);
  const levels = input.levels || {};
  const numericLevels = ["entry", "stop", "tp1", "tp2", "tp3"].every(function (field) {
    return finite(levels[field]) && levels[field] > 0;
  }) && (levels.atr === undefined || (finite(levels.atr) && levels.atr > 0));
  const orderedLevels = numericLevels && levels.stop > levels.entry &&
    levels.entry > levels.tp1 && levels.tp1 > levels.tp2 && levels.tp2 > levels.tp3;
  const stopWithinAtr = !finite(levels.atr) || levels.stop - levels.entry <= 3 * levels.atr;
  const recentInvalidation = Boolean(setup && finite(levels.invalidation) &&
    finite(levels.sourceTime) && levels.sourceTime > 0 && levels.invalidation > levels.entry &&
    levels.stop > levels.invalidation &&
    levels.invalidation === setup.invalidation && levels.sourceTime === setup.sourceTime &&
    candles15.slice(-9).some(function (candle) {
      return candle.time === levels.sourceTime && candle.high === levels.invalidation;
    }));
  const sameEntry = Boolean(latest15 && levels.entry === latest15.close);
  const validLevels = orderedLevels && finite(levels.atr) && stopWithinAtr &&
    recentInvalidation && sameEntry && levels.valid !== false;
  const calculatedRiskReward = validLevels ? (levels.entry - levels.tp1) / (levels.stop - levels.entry) : null;
  const riskReward = finite(calculatedRiskReward) ? calculatedRiskReward : null;
  const slippage = (input.orderBook || {}).slippagePercent;
  const costRate = finite(input.takerFeeRate) && input.takerFeeRate >= 0 && input.takerFeeRate < 1 &&
    finite(slippage) && slippage >= 0 ? input.takerFeeRate + slippage / 100 : null;
  const netReward = validLevels && costRate !== null ?
    levels.entry - levels.tp1 - (levels.entry + levels.tp1) * costRate : null;
  const netRisk = validLevels && costRate !== null ?
    levels.stop - levels.entry + (levels.entry + levels.stop) * costRate : null;
  const calculatedNetRiskReward = finite(netReward) && finite(netRisk) && netRisk > 0 ? netReward / netRisk : null;
  const netRiskReward = finite(calculatedNetRiskReward) ? calculatedNetRiskReward : null;
  const minimumRiskReward = finite(input.minimumRiskReward) && input.minimumRiskReward >= 1 &&
    input.minimumRiskReward <= 5 ? input.minimumRiskReward : 1.5;
  const blockers = [];
  if (!dataReady) blockers.push("NO TRADE — DATA UNAVAILABLE");
  if (setup && !sellingCandle) blockers.push("немає підтвердженого тиску продажів");
  if (setup && !setup.confirmed) blockers.push("формація ще не підтверджена закриттям 15m");
  if (setup && finite(input.volumeRatio) && input.volumeRatio >= 0 && input.volumeRatio < 1.5) {
    blockers.push("обсяг продажів volumeRatio=" + input.volumeRatio + " < 1.5× бази");
  }
  if (setup && !bearish1h) blockers.push("структура 1h не підтверджує SHORT");
  if (strongBullish4h) blockers.push("сильний висхідний тренд 4h не зламано");
  if (matrixConflict || oiContradiction) blockers.push(
    (matrixConflict ? "критичний конфлікт Price × OI: " : "Price × OI суперечить SHORT: ") + matrixValues);
  if (shortSqueezeRisk) blockers.push("критичний ризик short squeeze: " + squeezeReasons.join("; "));
  if (liquidationFlush && (!setup || setup.type !== "failed_retest")) {
    blockers.push("після різкого падіння ціни й OI потрібно дочекатися відскоку та невдалого ретесту");
  }
  if (stretched) blockers.push("рух надмірно розтягнутий; не переслідувати падіння");
  liquidity.reasons.forEach(function (reason) {
    if (!reason.includes("недоступне/некоректне")) blockers.push("ліквідність: " + reason);
  });
  if ((setup || input.levels) && !validLevels) {
    blockers.push("некоректний stop/рівні: " + (levels.reason ||
      (!orderedLevels ? "потрібно stop > entry > tp1 > tp2 > tp3 > 0" :
        !recentInvalidation ? "invalidation/sourceTime не відповідають локальній свічці останніх 9 × 15m або stop" :
          !sameEntry ? "Entry не відповідає останньому закриттю 15m" :
            !finite(levels.atr) ? "ATR недоступний для перевірки відстані Stop" :
          !stopWithinAtr ? "stop distance=" + (levels.stop - levels.entry) + " > 3 ATR=" + (3 * levels.atr) :
            "levels.valid=false")));
  } else if ((setup || input.levels) && riskReward === null) {
    blockers.push("Reward/Risk не є скінченним числом");
  } else if (riskReward !== null && riskReward < minimumRiskReward) {
    blockers.push("Reward/Risk=" + riskReward.toFixed(2) + " < порога " + minimumRiskReward.toFixed(2) + " (TP1)");
  }
  if (costRate !== null && validLevels && (netRiskReward === null || netRiskReward < minimumRiskReward)) {
    blockers.push("Net Reward/Risk=" + (netRiskReward === null ? "недоступний" : netRiskReward.toFixed(2)) +
      " < порога " + minimumRiskReward.toFixed(2) + " (комісія taker + slippage на вхід і вихід)");
  }
  const score = scoreShort(input, {
    matrix: matrix,
    setup: setup,
    setupConfirmed: setupConfirmed,
    liquidity: liquidity,
    bearish1h: bearish1h,
    bearish15m: bearish15m,
    sellingCandle: sellingCandle
  });
  const allowed = Boolean(dataReady && setupConfirmed && liquidity.passed && validLevels &&
    riskReward !== null && blockers.length === 0);
  const missingData = !dataReady;
  const readiness = {
    missing: missing,
    timeframes: Object.fromEntries(intervals.map(function (interval) {
      const fields = missing.filter(function (field) { return field.endsWith("." + interval); });
      return [interval, { ready: fields.length === 0, missing: fields }];
    })),
    ready: dataReady
  };
  return {
    matrix: matrix,
    setup: setup,
    setupConfirmed: setupConfirmed,
    setupStatus: setupConfirmed ? "SETUP CONFIRMED" : setup ? "SETUP DETECTED" : null,
    status: allowed ? "SHORT ENTRY" : !dataReady ? "DATA UNAVAILABLE" : "NO TRADE",
    allowed: allowed,
    dataReady: dataReady,
    missingData: missingData,
    missing: missing,
    readiness: readiness,
    liquidity: liquidity,
    squeezeReasons: squeezeReasons,
    blockers: blockers,
    score: score.value,
    scoreReasons: score.reasons,
    missingScoreData: Array.from(new Set(missing.concat(score.missing))),
    riskReward: riskReward,
    netRiskReward: netRiskReward,
    riskRewardBasis: costRate === null ? "gross; комісія/витрати недоступні" : "net estimate",
    minimumRiskReward: minimumRiskReward,
    flags: {
      bearish15m: bearish15m,
      bearish1h: bearish1h,
      strongBullish4h: strongBullish4h,
      matrixConflict: matrixConflict,
      shortSqueezeRisk: shortSqueezeRisk,
      liquidationFlush: liquidationFlush,
      stretched: stretched
    }
  };
}
