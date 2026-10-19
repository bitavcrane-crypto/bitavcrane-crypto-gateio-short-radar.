function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function direction(current, previous) {
  return !finite(current) || !finite(previous) ? "neutral" :
    current > previous ? "bullish" : current < previous ? "bearish" : "neutral";
}

function rankCorrelation(window) {
  const sorted = window.slice().sort(function (a, b) { return a - b; });
  let squaredDifference = 0;
  for (let i = 0; i < window.length; i += 1) {
    const first = sorted.indexOf(window[i]);
    const last = sorted.lastIndexOf(window[i]);
    const priceRank = (first + last) / 2 + 1;
    const difference = i + 1 - priceRank;
    squaredDifference += difference * difference;
  }
  return (1 - 6 * squaredDifference / (window.length * (window.length * window.length - 1))) * 100;
}

function rollingAverage(values, period) {
  return values.map(function (_, index) {
    if (index + 1 < period) return null;
    const window = values.slice(index + 1 - period, index + 1);
    if (window.some(function (value) { return !finite(value); })) return null;
    return window.reduce(function (sum, value) { return sum + value; }, 0) / period;
  });
}

function calculateEmaSeries(closes, period) {
  const values = Array(closes.length).fill(null);
  if (closes.length < period) return values;
  let current = closes.slice(0, period).reduce(function (sum, value) { return sum + value; }, 0) / period;
  values[period - 1] = current;
  const multiplier = 2 / (period + 1);
  for (let i = period; i < closes.length; i += 1) {
    current += (closes[i] - current) * multiplier;
    values[i] = current;
  }
  return values;
}

function periodsFor(settings) {
  const rci = settings.rci && Array.isArray(settings.rci.periods) ? settings.rci.periods :
    [settings.rci && settings.rci.period || 9];
  const ema = settings.ema && Array.isArray(settings.ema.periods) ? settings.ema.periods :
    [settings.ema && settings.ema.fast || 9, settings.ema && settings.ema.slow || 21];
  return { rci: rci, ema: ema };
}

function indicatorSeries(candles, settings) {
  const periods = periodsFor(settings);
  const closes = candles.map(function (candle) { return candle.close; });
  const rci = periods.rci.map(function (period) {
    return {
      period: period,
      values: candles.map(function (_, index) {
        return index + 1 < period ? null : rankCorrelation(closes.slice(index + 1 - period, index + 1));
      })
    };
  });

  const hasVolume = candles.every(function (candle) { return finite(candle.volume) && candle.volume >= 0; });
  let obv = 0;
  const obvValues = hasVolume ? candles.map(function (candle, index) {
    if (index > 0) {
      const previous = candles[index - 1];
      obv += (candle.close > previous.close ? 1 : candle.close < previous.close ? -1 : 0) * candle.volume;
    }
    return obv;
  }) : [];
  const obvLookback = settings.obv.lookback;
  const obvAverage = hasVolume ? rollingAverage(obvValues, obvLookback) : Array(candles.length).fill(null);
  const obvChange = hasVolume ? obvValues.map(function (value, index) {
    return index + 1 < obvLookback + 1 ? null : value - obvValues[index + 1 - obvLookback];
  }) : Array(candles.length).fill(null);
  const ema = periods.ema.map(function (period) {
    return { period: period, values: calculateEmaSeries(closes, period) };
  });
  const rawK = candles.map(function (candle, index) {
    if (index + 1 < settings.kdj.period) return null;
    const window = candles.slice(index + 1 - settings.kdj.period, index + 1);
    const highest = Math.max.apply(null, window.map(function (item) { return item.high; }));
    const lowest = Math.min.apply(null, window.map(function (item) { return item.low; }));
    return highest === lowest ? 50 : ((candle.close - lowest) / (highest - lowest)) * 100;
  });
  const k = rollingAverage(rawK, settings.kdj.ma1);
  const d = rollingAverage(k, settings.kdj.ma2);
  const j = k.map(function (value, index) {
    return finite(value) && finite(d[index]) ? 3 * value - 2 * d[index] : null;
  });
  return {
    rci: rci, hasVolume: hasVolume, obv: obvValues, obvAverage: obvAverage, obvChange: obvChange,
    ema: ema, closes: closes, k: k, d: d, j: j
  };
}

function lastFinite(values, offset) {
  let found = 0;
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (finite(values[i])) {
      if (found === (offset || 0)) return values[i];
      found += 1;
    }
  }
  return null;
}

function tail(values) {
  return values.slice(-48);
}

export function buildIndicatorVisualization(candles, settings, nowSeconds, intervalSeconds) {
  const seconds = Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : 900;
  const byTime = new Map();
  if (Array.isArray(candles)) {
    candles.forEach(function (candle) {
      if (!candle || !finite(nowSeconds) || !finite(candle.time) || candle.time < 0 || candle.time % seconds !== 0 ||
          candle.time + seconds > nowSeconds || !finite(candle.open) || !finite(candle.high) ||
          !finite(candle.low) || !finite(candle.close) || candle.open <= 0 || candle.close <= 0 ||
          candle.low <= 0 || candle.high < Math.max(candle.open, candle.close, candle.low) ||
          candle.low > Math.min(candle.open, candle.close)) return;
      byTime.set(candle.time, candle);
    });
  }
  const closedCandles = Array.from(byTime.values()).sort(function (a, b) { return a.time - b.time; });
  if (!closedCandles.length) return { status: "unavailable", candles: [], indicators: null };
  for (let i = 1; i < closedCandles.length; i += 1) {
    if (closedCandles[i].time - closedCandles[i - 1].time !== seconds) {
      return { status: "incomplete", candles: closedCandles, indicators: null };
    }
  }

  const computed = indicatorSeries(closedCandles, settings);
  const rciLines = computed.rci.map(function (line) {
    const value = lastFinite(line.values);
    const previous = lastFinite(line.values, 1);
    return {
      period: line.period, values: tail(line.values), value: value,
      direction: direction(value, previous),
      possibleReversalDown: finite(previous) && previous >= 80 && finite(value) && value < previous
    };
  });
  const emaLines = computed.ema.map(function (line) {
    return {
      period: line.period, value: lastFinite(line.values),
      direction: direction(lastFinite(line.values), lastFinite(line.values, 1)),
      values: tail(line.values)
    };
  });
  const obvValue = lastFinite(computed.obv);
  const obvPrior = lastFinite(computed.obv, settings.obv.lookback);
  const obvChange = lastFinite(computed.obvChange);
  const kValue = lastFinite(computed.k);
  const jValue = lastFinite(computed.j);
  const dValue = lastFinite(computed.d);
  const priorK = lastFinite(computed.k, 1);
  const priorD = lastFinite(computed.d, 1);
  const priorJ = lastFinite(computed.j, 1);
  const kdjCross = finite(kValue) && finite(dValue) && finite(priorK) && finite(priorD) ?
    priorK <= priorD && kValue > dValue ? "bullish" :
      priorK >= priorD && kValue < dValue ? "bearish" : "none" : "unavailable";
  const kdjDirection = direction(kValue, priorK);
  const possibleKdjExhaustion = finite(kValue) &&
    ((kValue >= 80 && (kdjDirection === "bearish" || kdjCross === "bearish")) ||
     (kValue <= 20 && (kdjDirection === "bullish" || kdjCross === "bullish")));
  const close = closedCandles[closedCandles.length - 1].close;
  const selectedEma = emaLines.filter(function (line) { return finite(line.value); });
  const belowAllEma = selectedEma.length === emaLines.length && selectedEma.length > 0 &&
    selectedEma.every(function (line) { return close < line.value; });
  const aboveAllEma = selectedEma.length === emaLines.length && selectedEma.length > 0 &&
    selectedEma.every(function (line) { return close > line.value; });
  const emaCrosses = [];
  const lastIndex = closedCandles.length - 1;
  for (let i = 0; i < computed.ema.length; i += 1) {
    for (let j = i + 1; j < computed.ema.length; j += 1) {
      const fastValues = computed.ema[i].values;
      const slowValues = computed.ema[j].values;
      const priorFast = fastValues[lastIndex - 1];
      const priorSlow = slowValues[lastIndex - 1];
      const currentFast = fastValues[lastIndex];
      const currentSlow = slowValues[lastIndex];
      if (finite(priorFast) && finite(priorSlow) && finite(currentFast) && finite(currentSlow)) {
        const cross = priorFast <= priorSlow && currentFast > currentSlow ? "bullish" :
          priorFast >= priorSlow && currentFast < currentSlow ? "bearish" : "none";
        if (cross !== "none") emaCrosses.push({
          periods: [computed.ema[i].period, computed.ema[j].period], direction: cross
        });
      }
    }
  }
  const emaCross = emaCrosses.length ? emaCrosses[0].direction : "none";
  const rciPrimary = rciLines[0] || {};
  return {
    status: "ok",
    candles: closedCandles,
    latestCandleTime: closedCandles[closedCandles.length - 1].time,
    indicators: {
      rci: {
        periods: rciLines.map(function (line) { return line.period; }), lines: rciLines,
        period: rciPrimary.period, values: rciPrimary.values, value: rciPrimary.value,
        direction: rciPrimary.direction, upper: 80, lower: -80,
        possibleReversalDown: rciLines.some(function (line) { return line.possibleReversalDown; })
      },
      obv: {
        lookback: settings.obv.lookback, values: tail(computed.obv), averageValues: tail(computed.obvAverage),
        changeValues: tail(computed.obvChange), value: obvValue, change: obvChange,
        direction: direction(obvValue, obvPrior), volumeAvailable: computed.hasVolume,
        average: lastFinite(computed.obvAverage)
      },
      ema: {
        periods: emaLines.map(function (line) { return line.period; }), lines: emaLines,
        close: close, closeValues: tail(computed.closes),
        fastPeriod: emaLines[0] && emaLines[0].period, slowPeriod: emaLines[1] && emaLines[1].period,
        fast: emaLines[0] && emaLines[0].value, slow: emaLines[1] && emaLines[1].value,
        fastValues: emaLines[0] && emaLines[0].values, slowValues: emaLines[1] && emaLines[1].values,
        direction: belowAllEma ? "bearish" : aboveAllEma ? "bullish" : "neutral",
        crossed: emaCrosses.length > 0, cross: emaCross, crosses: emaCrosses,
        position: belowAllEma ? "Ціна нижче всіх EMA" :
          aboveAllEma ? "Ціна вище всіх EMA" : "Ціна між EMA або недостатньо історії",
        fastDirection: emaLines[0] && emaLines[0].direction, slowDirection: emaLines[1] && emaLines[1].direction
      },
      kdj: {
        period: settings.kdj.period, ma1: settings.kdj.ma1, ma2: settings.kdj.ma2,
        k: kValue, d: dValue, j: jValue,
        kValues: tail(computed.k), dValues: tail(computed.d), jValues: tail(computed.j),
        direction: kdjDirection, directions: { k: kdjDirection, d: direction(dValue, priorD), j: direction(jValue, priorJ) },
        cross: kdjCross, possibleExhaustion: possibleKdjExhaustion
      }
    }
  };
}
