const FLAT_THRESHOLD = 0.1;
const MIN_BOOK_DEPTH_USD = 10000;
const MIN_DAILY_VOLUME_USD = 1000000;
const MAX_SPREAD_PERCENT = 0.2;
const MAX_SLIPPAGE_PERCENT = 0.15;

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
  return latest.close < level ? { type: "support_break", level: level } : null;
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
    if (nearLevel && latest.close < level) return { type: "failed_retest", level: level };
  }
  return null;
}

function findFailedHighBreak(candles) {
  if (!Array.isArray(candles) || candles.length < 8) return null;
  const latest = candles[candles.length - 1];
  if (latest.close >= latest.open) return null;
  const start = Math.max(0, candles.length - 8);
  const prior = candles.slice(start, -1);
  const level = Math.max.apply(null, prior.map(function (candle) { return candle.high; }));
  const swept = prior.some(function (candle, index) {
    const earlier = candles.slice(Math.max(0, start + index - 5), start + index);
    return earlier.length >= 3 && candle.high > Math.max.apply(null, earlier.map(function (item) {
      return item.high;
    })) && candle.close < candle.high;
  });
  return swept && latest.close < level ? { type: "failed_high_break", level: level } : null;
}

function bearishIndicators(indicators) {
  return Boolean(indicators && (
    (indicators.macd && (indicators.macd.histogram < 0 || indicators.macd.bearishCross)) ||
    indicators.obvDivergence ||
    (finite(indicators.rsi) && indicators.rsi < 50)
  ));
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
  if (input.volumeRatio !== null && input.volumeRatio >= 1.5 && flags.sellingCandle) {
    add(15, "продажі на підвищеному обсязі");
  } else if (input.volumeRatio === null) missing.push("немає повного обсягу");
  if (flags.matrix["1h"].key === "down_up" || flags.matrix["4h"].key === "down_up") {
    add(15, "падіння ціни зі зростанням OI");
  } else if (flags.matrix["1h"].key === "down_down" || flags.matrix["4h"].key === "down_down") {
    add(8, "падіння ціни зі скороченням OI");
  } else if (flags.matrix["1h"].key === "unavailable" || flags.matrix["4h"].key === "unavailable") {
    missing.push("недостатньо історії Price × OI");
  }
  if (input.indicators && finite(input.indicators.rsi)) add(input.indicators.rsi < 50 ? 6 : 0,
    input.indicators.rsi < 50 ? "RSI нижче 50" : "RSI не підтверджує ведмежий імпульс");
  else missing.push("RSI недоступний");
  if (input.indicators && input.indicators.macd) add(input.indicators.macd.histogram < 0 ? 5 : 0,
    input.indicators.macd.histogram < 0 ? "MACD bearish" : "MACD не bearish");
  else missing.push("MACD недоступний");
  if (input.indicators && typeof input.indicators.obvDivergence === "boolean") {
    add(input.indicators.obvDivergence ? 4 : 0, input.indicators.obvDivergence ?
      "OBV не підтверджує максимум" : "OBV-дивергенція відсутня");
  } else missing.push("OBV недоступний");
  if (finite(input.fundingNormalized) && input.stats && finite(input.stats.lsrAccount)) {
    add(input.fundingNormalized >= 0 && input.stats.lsrAccount >= 1 ? 10 : 0,
      input.fundingNormalized >= 0 && input.stats.lsrAccount >= 1 ?
        "funding/позиціонування не суперечать SHORT" : "funding/позиціонування не дають переваги SHORT");
  } else missing.push("funding або позиціонування недоступні");
  if (!input.stats || !finite(input.stats.shortLiquidationUsd) ||
      !finite(input.stats.longLiquidationUsd)) missing.push("ліквідації LONG/SHORT недоступні");
  if (flags.setup) add(10, "підтверджено " + flags.setup.type);
  if (input.orderBook && input.orderBook.quality === "OK") {
    if (input.orderBook.depthUsd >= MIN_BOOK_DEPTH_USD &&
        input.orderBook.spreadPercent <= MAX_SPREAD_PERCENT &&
        finite(input.orderBook.slippagePercent) &&
        input.orderBook.slippagePercent <= MAX_SLIPPAGE_PERCENT &&
        input.ticker && input.ticker.volume24h >= MIN_DAILY_VOLUME_USD) {
      add(10, "ліквідність і спред придатні");
    } else {
      add(4, "ліквідність/спред обмежують виконання");
    }
  } else missing.push("глибина книги недоступна");
  return {
    value: Math.min(100, score),
    reasons: reasons,
    missing: missing
  };
}

export function evaluateShortStrategy(input) {
  const changes = input.changes || {};
  const oiChanges = input.oiChanges || {};
  const candles = input.candles || {};
  const matrix = {
    "15m": classifyPriceOi(changes["15m"], oiChanges["15m"]),
    "1h": classifyPriceOi(changes["1h"], oiChanges["1h"]),
    "4h": classifyPriceOi(changes["4h"], oiChanges["4h"])
  };
  const candles15 = candles["15m"] || [];
  const candles1h = candles["1h"] || [];
  const candles4h = candles["4h"] || [];
  const latest15 = candles15[candles15.length - 1];
  const latestRange = latest15 ? latest15.high - latest15.low : 0;
  const sellingCandle = Boolean(latest15 && latest15.close < latest15.open && latestRange > 0 &&
    (latest15.close - latest15.low) / latestRange <= 0.5);
  const bearish15m = candlesBearish(candles15);
  const bearish1h = bearishOneHour(candles1h);
  const strongBullish4h = bullishFourHour(candles4h, changes["4h"]);
  const candidates = [
    findFailedRetest(candles15),
    findFailedHighBreak(candles15),
    findBreakdown(candles15)
  ].filter(Boolean);
  const setup = candidates[0] || null;
  const dataReady = Boolean(["15m", "1h", "4h"].every(function (interval) {
    return input.qualities && input.qualities[interval] === "OK";
  }) && ["15m", "1h", "4h"].every(function (interval) {
    return finite(oiChanges[interval]) && finite(changes[interval]);
  }) && input.stats && input.stats.quality === "OK" &&
    input.ticker && input.ticker.quality === "OK" && finite(input.ticker.last) &&
    finite(input.ticker.volume24h) && input.orderBook && input.orderBook.quality === "OK" &&
    input.stats && finite(input.stats.shortLiquidationUsd) && finite(input.stats.longLiquidationUsd));
  const matrixConflict = (matrix["4h"].key.startsWith("up_") && matrix["1h"].key.startsWith("down_")) ||
    (matrix["4h"].key.startsWith("down_") && matrix["1h"].key.startsWith("up_"));
  const oiContradiction = matrix["4h"].key === "up_up" ||
    matrix["4h"].key === "up_down" ||
    (matrix["1h"].key.startsWith("up_") && !setup);
  const shortSqueezeRisk = Boolean(input.stats && finite(input.stats.shortLiquidationUsd) &&
    finite(input.stats.longLiquidationUsd) && input.stats.shortLiquidationUsd > 0 &&
    input.stats.shortLiquidationUsd > input.stats.longLiquidationUsd * 3) ||
    Boolean(finite(input.fundingNormalized) && input.fundingNormalized <= -0.001 &&
      input.stats && finite(input.stats.lsrAccount) && input.stats.lsrAccount < 0.8);
  const liquidationFlush = ["15m", "1h", "4h"].some(function (interval) {
    return matrix[interval].key === "down_down" &&
      finite(changes[interval]) && changes[interval] <= -2 &&
      finite(oiChanges[interval]) && oiChanges[interval] <= -2;
  });
  const stretched = (finite(changes["4h"]) && changes["4h"] <= -8) ||
    Boolean(latest15 && latest15.open > 0 && (latest15.open - latest15.close) / latest15.open >= 0.04);
  const bookBlocked = !input.orderBook || input.orderBook.quality !== "OK" ||
    input.orderBook.spreadPercent > MAX_SPREAD_PERCENT ||
    input.orderBook.depthUsd < MIN_BOOK_DEPTH_USD ||
    !finite(input.orderBook.slippagePercent) ||
    input.orderBook.slippagePercent > MAX_SLIPPAGE_PERCENT ||
    !input.ticker || input.ticker.volume24h < MIN_DAILY_VOLUME_USD;
  const levels = input.levels;
  const riskReward = levels && finite(levels.riskReward) ? levels.riskReward : null;
  const minimumRiskReward = finite(input.minimumRiskReward) && input.minimumRiskReward >= 1 &&
    input.minimumRiskReward <= 5 ? input.minimumRiskReward : 1.5;
  const blockers = [];
  if (!dataReady) blockers.push("NO TRADE — DATA UNAVAILABLE: немає закритих даних 15m/1h/4h, OI або книги заявок");
  if (!input.stats || !finite(input.stats.shortLiquidationUsd) ||
      !finite(input.stats.longLiquidationUsd)) {
    blockers.push("NO TRADE — DATA UNAVAILABLE: немає напрямлених агрегатів ліквідацій для оцінки squeeze-ризику");
  }
  if (setup && !sellingCandle) blockers.push("немає підтвердженого тиску продажів");
  if (setup && input.volumeRatio === null) blockers.push("обсяг продажів недоступний");
  else if (setup && input.volumeRatio < 1.5) blockers.push("обсяг продажів не перевищує базу у 1,5 раза");
  if (setup && !bearish1h) blockers.push("структура 1h не підтверджує SHORT");
  if (strongBullish4h) blockers.push("сильний висхідний тренд 4h не зламано");
  if (matrixConflict) blockers.push("критичний конфлікт Price × OI між 1h та 4h");
  if (oiContradiction) blockers.push("Price × OI 4h суперечить SHORT; потрібне підтверджене завершення росту");
  if (shortSqueezeRisk) blockers.push("критичний ризик short squeeze за даними ліквідацій");
  if (liquidationFlush && (!setup || setup.type !== "failed_retest")) {
    blockers.push("після різкого падіння ціни й OI потрібно дочекатися відскоку та невдалого ретесту");
  }
  if (stretched) blockers.push("рух надмірно розтягнутий; не переслідувати падіння");
  if (bookBlocked && dataReady) blockers.push("ліквідність/спред книги заявок не проходять поріг");
  if (setup && (riskReward === null || riskReward < minimumRiskReward)) {
    blockers.push("Reward/Risk нижче порога " + minimumRiskReward.toFixed(2));
  }
  const score = scoreShort(input, {
    matrix: matrix,
    setup: setup,
    bearish1h: bearish1h,
    bearish15m: bearish15m,
    sellingCandle: sellingCandle
  });
  const allowed = Boolean(dataReady && setup && sellingCandle && input.volumeRatio >= 1.5 &&
    bearish1h && !strongBullish4h && !matrixConflict && !oiContradiction &&
    !shortSqueezeRisk && (!liquidationFlush || setup.type === "failed_retest") &&
    !stretched && !bookBlocked &&
    riskReward !== null && riskReward >= minimumRiskReward);
  const missingData = !dataReady;
  return {
    matrix: matrix,
    setup: setup,
    allowed: allowed,
    dataReady: dataReady,
    missingData: missingData,
    blockers: blockers,
    score: score.value,
    scoreReasons: score.reasons,
    missingScoreData: score.missing,
    riskReward: riskReward,
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
