const TIMEFRAME_SECONDS = Object.freeze({ "5m": 300, "15m": 900, "1h": 3600, "4h": 14400 });
const SPIKE_WEIGHTS = Object.freeze({
  priceAcceleration: 25,
  volumeAnomaly: 25,
  atrExpansion: 15,
  cvdImpulse: 15,
  oiImpulse: 10,
  liquidationImpulse: 10
});
const PRESSURE_WEIGHTS = Object.freeze({
  oiCrowding: 25,
  fundingPressure: 20,
  priceExtension: 15,
  flowDivergence: 20,
  volumeAnomaly: 10,
  volatilityStress: 10
});
const finite = value => typeof value === "number" && Number.isFinite(value);
const positive = value => finite(value) && value > 0;

function change(current, previous) {
  return positive(previous) && finite(current) ? (current / previous - 1) * 100 : null;
}

function frame(input, timeframe, minimumBars = 1) {
  const item = input.frames?.[timeframe];
  const seconds = TIMEFRAME_SECONDS[timeframe];
  if (!item || item.timeframe !== timeframe || item.quality !== "OK" ||
      !Array.isArray(item.candles) || item.candles.length < minimumBars) return null;
  const candles = item.candles;
  if (candles.some((candle, index) =>
    !candle || !finite(candle.time) || !positive(candle.close) ||
    (index > 0 && candle.time - candles[index - 1].time !== seconds))) return null;
  return candles;
}

function statsRows(input) {
  const stats = input.derivatives;
  if (!stats || stats.quality !== "OK" || !Array.isArray(stats.rows)) return null;
  const rows = stats.rows;
  if (rows.some((row, index) =>
    !row || !finite(row.time) || (index > 0 && row.time <= rows[index - 1].time))) return null;
  return rows;
}

function rvol(candles, count = 20) {
  if (!candles || candles.length < count + 1) return null;
  const previous = candles.slice(-count - 1, -1).map(candle => candle.volume);
  const current = candles.at(-1).volume;
  if (!previous.every(value => finite(value) && value >= 0) || !finite(current) || current < 0) return null;
  const baseline = previous.reduce((sum, value) => sum + value, 0) / previous.length;
  return positive(baseline) ? current / baseline : null;
}

function atr(candles, end, period = 14) {
  if (!candles || end < period || end >= candles.length) return null;
  const ranges = [];
  for (let index = end - period + 1; index <= end; index += 1) {
    const candle = candles[index];
    const prior = candles[index - 1];
    if (![candle?.high, candle?.low, prior?.close].every(finite)) return null;
    ranges.push(Math.max(candle.high - candle.low,
      Math.abs(candle.high - prior.close), Math.abs(candle.low - prior.close)));
  }
  return ranges.reduce((sum, value) => sum + value, 0) / period;
}

function atrExpansion(candles) {
  if (!candles || candles.length < 29) return null;
  const current = atr(candles, candles.length - 1);
  const previous = [];
  for (let index = candles.length - 15; index < candles.length - 1; index += 1) {
    const value = atr(candles, index);
    if (!finite(value)) return null;
    previous.push(value);
  }
  const baseline = previous.reduce((sum, value) => sum + value, 0) / previous.length;
  return positive(baseline) && finite(current) ? current / baseline : null;
}

function exactOiChange(rows, seconds) {
  if (!rows || rows.length < 2) return null;
  const current = rows.at(-1);
  const previous = rows.find(row => row.time === current.time - seconds);
  return previous && positive(previous.openInterest) && finite(current.openInterest) ?
    change(current.openInterest, previous.openInterest) : null;
}

function validFlow(input) {
  const flow = input.flow;
  if (flow?.verified !== true || flow.quality !== "OK" || typeof flow.source !== "string" ||
      !Array.isArray(flow.rows) || flow.rows.length < 6) return null;
  const rows = flow.rows.slice(-6);
  if (rows.some((row, index) => !finite(row?.time) || !finite(row?.delta) ||
      (index > 0 && row.time - rows[index - 1].time !== TIMEFRAME_SECONDS["5m"]))) return null;
  return rows;
}

function cvdImpulse(rows) {
  if (!rows) return null;
  const recent = rows.slice(-3).reduce((sum, row) => sum + row.delta, 0);
  const prior = rows.slice(0, 3).reduce((sum, row) => sum + row.delta, 0);
  return { recent, prior, direction: Math.sign(recent), weakening: recent < prior };
}

function liquidationState(rows) {
  if (!rows?.length) return { long: null, short: null, impulse: null };
  const current = rows.at(-1);
  const long = finite(current.longLiquidationSize) && current.longLiquidationSize >= 0 ?
    current.longLiquidationSize : null;
  const short = finite(current.shortLiquidationSize) && current.shortLiquidationSize >= 0 ?
    current.shortLiquidationSize : null;
  const previous = rows.slice(-7, -1);
  const averageOf = field => {
    if (!previous.length || previous.some(row => !finite(row[field]) || row[field] < 0)) return null;
    return previous.reduce((sum, row) => sum + row[field], 0) / previous.length;
  };
  const longAverage = averageOf("longLiquidationSize");
  const shortAverage = averageOf("shortLiquidationSize");
  const impulse = long !== null && short !== null && finite(longAverage) && finite(shortAverage) ?
    Math.max(longAverage > 0 ? long / longAverage : long > 0 ? Infinity : 0,
      shortAverage > 0 ? short / shortAverage : short > 0 ? Infinity : 0) : null;
  return { long, short, impulse };
}

function obvDivergence(candles) {
  if (!candles || candles.length < 12 || candles.slice(-12).some(candle =>
    !finite(candle.volume) || candle.volume < 0)) return null;
  const recent = candles.slice(-6);
  const prior = candles.slice(-12, -6);
  const obvFor = series => {
    let total = 0;
    for (let index = 1; index < series.length; index += 1) {
      const direction = Math.sign(series[index].close - series[index - 1].close);
      total += direction * series[index].volume;
    }
    return total;
  };
  const priorHigh = Math.max(...prior.map(candle => candle.high));
  const recentHigh = Math.max(...recent.map(candle => candle.high));
  return recentHigh > priorHigh && obvFor(recent) < obvFor(prior);
}

function upperWickRatio(candle) {
  if (![candle?.open, candle?.high, candle?.low, candle?.close].every(finite)) return null;
  const range = candle.high - candle.low;
  return range > 0 ? (candle.high - Math.max(candle.open, candle.close)) / range : null;
}

function structureBreakAndFailedRetest(candles) {
  if (!candles || candles.length < 8 ||
      candles.slice(-8).some(candle => !finite(candle.high) || !finite(candle.low) ||
        !finite(candle.close))) return false;
  const rows = candles.slice(-8);
  for (let breakIndex = 2; breakIndex < rows.length - 2; breakIndex += 1) {
    const support = Math.min(rows[breakIndex - 2].low, rows[breakIndex - 1].low);
    if (!(rows[breakIndex].close < support)) continue;
    const retest = rows.slice(breakIndex + 1).some(candle =>
      candle.high >= support && candle.close < support);
    const followThrough = rows.at(-1).close < support;
    if (retest && followThrough) return true;
  }
  return false;
}

function sourceMetric(input, name, value, source, timeframe) {
  return { name, available: value !== null && value !== undefined, value: value ?? null, source, timeframe };
}

function levelForPressure(score, earlyCandidate) {
  if (score < 30) return "NORMAL";
  if (score < 50) return "WATCH";
  if (!earlyCandidate) return "WATCH";
  if (score < 70) return "EARLY_SQUEEZE";
  if (score < 85) return "HIGH_SQUEEZE_RISK";
  return "EXTREME";
}

export function analyzeSqueezeEngine(input = {}) {
  const candles5 = frame(input, "5m", 22);
  const candles15 = frame(input, "15m", 21);
  const candles1h = frame(input, "1h");
  const candles4h = frame(input, "4h");
  const rows = statsRows(input);
  const flowRows = validFlow(input);
  const flow = cvdImpulse(flowRows);
  const oi5m = exactOiChange(rows, 300);
  const oi15m = exactOiChange(rows, 900);
  const oi1h = exactOiChange(rows, 3600);
  const funding = input.funding?.quality === "OK" && finite(input.funding.normalized8h) ?
    input.funding.normalized8h : null;
  const currentPrice = candles5?.at(-1)?.close;
  const previousPrice = candles5?.at(-3)?.close;
  const priorPrice = candles5?.at(-5)?.close;
  const priceImpulse = change(currentPrice, previousPrice);
  const priorImpulse = change(previousPrice, priorPrice);
  const historicalMoves = candles5?.slice(-22, -2).map((candle, index, series) =>
    index === 0 ? null : Math.abs(change(candle.close, series[index - 1].close)))
    .filter(finite) ?? [];
  const meanMove = historicalMoves.length ?
    historicalMoves.reduce((sum, value) => sum + value, 0) / historicalMoves.length : null;
  const priceAcceleration = finite(priceImpulse) && finite(priorImpulse) && finite(meanMove) ?
    Math.abs(priceImpulse) >= Math.max(0.5, meanMove * 2) &&
      Math.abs(priceImpulse) > Math.abs(priorImpulse) : null;
  const volumeRatio = rvol(candles5);
  const atrRatio = atrExpansion(candles5);
  const liquidation = liquidationState(rows);
  const priceDirection = finite(priceImpulse) ? Math.sign(priceImpulse) : null;
  const oiImpulse = oi5m;
  const spikeAvailable = [
    candles5 !== null,
    volumeRatio !== null,
    atrRatio !== null,
    flow !== null,
    oiImpulse !== null,
    liquidation.impulse !== null
  ];
  const spikeComponents = {
    priceAcceleration: priceAcceleration === true ? SPIKE_WEIGHTS.priceAcceleration : 0,
    volumeAnomaly: volumeRatio !== null && volumeRatio >= 2 ? SPIKE_WEIGHTS.volumeAnomaly : 0,
    atrExpansion: atrRatio !== null && atrRatio >= 1.5 ? SPIKE_WEIGHTS.atrExpansion : 0,
    cvdImpulse: flow && Math.abs(flow.recent) > Math.abs(flow.prior) ?
      SPIKE_WEIGHTS.cvdImpulse : 0,
    oiImpulse: oiImpulse !== null && Math.abs(oiImpulse) >= 1 ? SPIKE_WEIGHTS.oiImpulse : 0,
    liquidationImpulse: liquidation.impulse !== null && liquidation.impulse >= 2 ?
      SPIKE_WEIGHTS.liquidationImpulse : 0
  };
  const spikeScore = Object.values(spikeComponents).reduce((sum, value) => sum + value, 0);
  const spikeConfirmed = priceAcceleration === true && volumeRatio !== null && volumeRatio >= 2;
  const spikePossible = priceAcceleration === true && volumeRatio === null;
  let spikeType = null;
  let spikeConfidence = spikeAvailable.every(Boolean) ? "HIGH" : "LIMITED";
  const fundingElevated = funding !== null && funding >= 0.0005;
  if (priceDirection === 1 && finite(oiImpulse) && oiImpulse <= -1 &&
      liquidation.short !== null && liquidation.short > 0) {
    spikeType = "SHORT_COVERING";
  } else if (priceDirection === 1 && finite(oiImpulse) && oiImpulse >= 1 && fundingElevated) {
    spikeType = "LEVERAGE_DRIVEN";
    spikeConfidence = input.spotConfirmation === true ? "HIGH" : "LIMITED";
  } else if (priceDirection === 1 && volumeRatio !== null && volumeRatio >= 2 &&
      flow && flow.recent > 0 && finite(oiImpulse) && oiImpulse >= -0.25) {
    spikeType = "MOMENTUM";
  }

  const recentHigh = candles15 ? Math.max(...candles15.slice(-20).map(candle => candle.high)) : null;
  const extension = change(candles15?.at(-1)?.close, candles15?.at(-21)?.close);
  const priceExtended = finite(extension) && extension >= 3 &&
    finite(recentHigh) && candles15.at(-1).close >= recentHigh * 0.95;
  const structuralFailure = structureBreakAndFailedRetest(candles15);
  const recent15Move = change(candles15?.at(-1)?.close, candles15?.at(-4)?.close);
  const prior15Move = change(candles15?.at(-4)?.close, candles15?.at(-7)?.close);
  const momentumWeakening = (finite(priceImpulse) && finite(priorImpulse) &&
    priceImpulse < priorImpulse && priceImpulse > -0.25) ||
    (finite(prior15Move) && prior15Move > 0 && finite(recent15Move) &&
      recent15Move < prior15Move * 0.75) || structuralFailure;
  const obvDiverges = obvDivergence(candles15);
  const noPriceProgress = volumeRatio !== null && volumeRatio >= 1.5 &&
    finite(priceImpulse) && Math.abs(priceImpulse) < 0.5;
  const flowDiverges = obvDiverges === true || (flow !== null && flow.recent < 0) ||
    noPriceProgress;
  const pressureAvailable = [
    oi1h !== null,
    funding !== null,
    finite(extension) && finite(recentHigh),
    obvDiverges !== null || flow !== null || (volumeRatio !== null && finite(priceImpulse)),
    volumeRatio !== null,
    atrRatio !== null
  ];
  const oiCrowded = oi1h !== null && oi1h >= 1;
  const pressureComponents = {
    oiCrowding: oiCrowded ? PRESSURE_WEIGHTS.oiCrowding : 0,
    fundingPressure: fundingElevated ? PRESSURE_WEIGHTS.fundingPressure : 0,
    priceExtension: priceExtended ? PRESSURE_WEIGHTS.priceExtension : 0,
    flowDivergence: flowDiverges ? PRESSURE_WEIGHTS.flowDivergence : 0,
    volumeAnomaly: volumeRatio !== null && volumeRatio >= 1.5 ?
      PRESSURE_WEIGHTS.volumeAnomaly : 0,
    volatilityStress: atrRatio !== null && atrRatio >= 1.5 ?
      PRESSURE_WEIGHTS.volatilityStress : 0
  };
  const pressureScore = Object.values(pressureComponents).reduce((sum, value) => sum + value, 0);
  const earlyCandidate = priceExtended && oiCrowded && fundingElevated &&
    momentumWeakening && flowDiverges;
  const pressureLevel = levelForPressure(pressureScore, earlyCandidate);
  const priceFalling = finite(priceImpulse) && priceImpulse <= -0.5;
  const longOiFalling = oi15m !== null && oi15m <= -1;
  const longSqueezeActive = priceFalling && longOiFalling &&
    liquidation.long !== null && liquidation.long > 0;
  const shortSqueezeActive = priceImpulse !== null && priceImpulse >= 0.5 &&
    oi15m !== null && oi15m <= -1 &&
    liquidation.short !== null && liquidation.short > 0;
  const squeezeActive = longSqueezeActive || shortSqueezeActive;

  const latest15 = candles15?.at(-1);
  const rvolExtreme = volumeRatio !== null && volumeRatio >= 3;
  const latest15Progress = change(latest15?.close, candles15?.at(-2)?.close);
  const progressSmall = finite(latest15Progress) && Math.abs(latest15Progress) < 0.2;
  const extremeExtension = finite(extension) && extension >= 5;
  const exhaustionCandidate = spikeConfirmed && extremeExtension && rvolExtreme &&
    progressSmall && flowDiverges;
  const rejection = upperWickRatio(latest15) >= 0.55;
  const failedContinuation = finite(latest15?.close) && finite(candles15?.at(-2)?.close) &&
    latest15.close < candles15.at(-2).close;
  const flowDeterioration = (flow !== null && flow.weakening && flow.recent < 0) ||
    obvDiverges === true;
  const exhaustionConfirmed = exhaustionCandidate && rejection &&
    failedContinuation && flowDeterioration;

  const bearishFlow = flow !== null && flow.recent < 0;
  const shortEligibleStage = earlyCandidate && pressureScore >= 50;
  const shortConfirmation = shortEligibleStage && exhaustionConfirmed &&
    structuralFailure && bearishFlow;
  const shortConfirmationLimited = shortEligibleStage && exhaustionConfirmed &&
    structuralFailure && flow === null;

  const metrics = [
    sourceMetric(input, "ціна та прискорення", priceAcceleration, "Gate.io Futures candlesticks", "5m"),
    sourceMetric(input, "обсяг / RVOL", volumeRatio, "Gate.io Futures candlesticks", "5m"),
    sourceMetric(input, "розширення ATR", atrRatio, "Gate.io Futures candlesticks", "5m"),
    sourceMetric(input, "CVD з підтвердженою семантикою", flow?.recent ?? null,
      flow ? input.flow.source :
        "Gate.io contract_stats · напрямок агресорної сторони не верифікований", "5m"),
    sourceMetric(input, "зміна відкритого інтересу", oi5m, "Gate.io contract_stats", "5m"),
    sourceMetric(input, "напрямок ліквідацій", liquidation.long !== null && liquidation.short !== null ?
      { long: liquidation.long, short: liquidation.short } : null, "Gate.io contract_stats", "5m"),
    sourceMetric(input, "ставка funding", funding, "Gate.io futures ticker · нормалізовано до 8h", "ticker"),
    sourceMetric(input, "структура / таймфрейми", candles15 && candles1h && candles4h ?
      { "15m": true, "1h": true, "4h": true } : null, "Gate.io Futures candlesticks", "15m/1h/4h")
  ];
  const availableMetrics = metrics.filter(metric => metric.available).map(metric => metric.name);
  const missingMetrics = metrics.filter(metric => !metric.available).map(metric => metric.name);
  const overallCoverage = { available: availableMetrics.length, total: metrics.length };
  const status = candles5 && volumeRatio !== null ? "ANALYZED" : "DATA_INSUFFICIENT";
  const confidence = status !== "ANALYZED" || missingMetrics.length > 2 ? "LIMITED" : "MODERATE";

  return {
    status,
    reason: status === "ANALYZED" ?
      "Оцінюються тільки перевірені Gate-дані; необов’язкові або неперевірені метрики не підміняються." :
      "Недостатньо якісної 5m історії та/або обсягу; підтверджений spike не формується.",
    dataCoverage: overallCoverage,
    availableMetrics,
    missingMetrics,
    metrics,
    confidence,
    timeframes: {
      trigger: "5m",
      setup: candles15 ? "15m" : null,
      structure: candles1h ? "1h" : null,
      regime: candles4h ? "4h" : null
    },
    spike: {
      status: spikeConfirmed ? "CONFIRMED" : spikePossible ? "POSSIBLE" :
        status === "DATA_INSUFFICIENT" ? "DATA_INSUFFICIENT" : "NO_CONFIRMED_SPIKE",
      candidate: spikeConfirmed,
      score: spikeScore,
      maximum: 100,
      dataCoverage: { available: spikeAvailable.filter(Boolean).length, total: spikeAvailable.length },
      components: spikeComponents,
      priceChange: priceImpulse,
      rvol: volumeRatio,
      atrExpansion: atrRatio,
      type: spikeType,
      typeConfidence: spikeType ? spikeConfidence : null
    },
    squeeze: {
      pressure: pressureScore,
      maximum: 100,
      dataCoverage: { available: pressureAvailable.filter(Boolean).length, total: pressureAvailable.length },
      components: pressureComponents,
      level: pressureLevel,
      earlyCandidate,
      oiChange1h: oi1h,
      fundingNormalized8h: funding,
      flowDivergence: flowDiverges,
      active: squeezeActive,
      activeStatus: squeezeActive ? "CONFIRMED" :
        liquidation.long === null || liquidation.short === null ? "UNCONFIRMED" : "NOT_CONFIRMED",
      direction: longSqueezeActive ? "LONG_SQUEEZE" :
        shortSqueezeActive ? "SHORT_SQUEEZE" : null,
      liquidation
    },
    exhaustion: {
      status: exhaustionConfirmed ? "CONFIRMED" :
        exhaustionCandidate ? "CANDIDATE" : "NOT_CONFIRMED",
      candidate: exhaustionCandidate,
      confirmed: exhaustionConfirmed,
      evidence: {
        extremeExtension,
        extremeRvol: rvolExtreme,
        littleProgress: progressSmall,
        flowDivergence: flowDiverges,
        rejection: rejection === true,
        failedContinuation,
        flowDeterioration
      }
    },
    shortConfirmation: {
      status: shortConfirmation ? "CONFIRMED" :
        shortConfirmationLimited ? "LIMITED" : "NO_TRADE",
      confirmed: shortConfirmation,
      reason: shortConfirmation ? "Є окреме підтвердження структури, виснаження та ведмежого перевіреного потоку." :
        shortConfirmationLimited ? "CVD/перевірений напрямок потоку недоступний; підтвердження SHORT обмежене." :
          "Spike або ранній squeeze сам по собі не є SHORT; повний набір структурних і flow-доказів відсутній.",
      evidence: {
        earlyOrHighSqueeze: shortEligibleStage,
        exhaustionConfirmed,
        bearishStructureBreakAndFailedRetest: structuralFailure,
        verifiedBearishFlow: bearishFlow
      }
    },
    oiInterpretation: priceDirection === 1 && oi5m !== null && oi5m > 0 ? "LEVERAGE_BUILD_UP" :
      priceDirection === 1 && oi5m !== null && oi5m < 0 && liquidation.short !== null &&
        liquidation.short > 0 ? "SHORT_COVERING_CONFIRMED" :
        priceDirection === -1 && oi5m !== null && oi5m < 0 && liquidation.long !== null &&
          liquidation.long > 0 ? "LONG_SQUEEZE_CONFIRMED" :
          priceDirection === -1 && oi5m !== null && oi5m > 0 ? "BEARISH_POSITIONING" : "UNCLASSIFIED"
  };
}
