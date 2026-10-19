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
    return window.reduce(function (sum, value) {
      return sum + value;
    }, 0) / period;
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

function indicatorSeries(candles, settings) {
  const closes = candles.map(function (candle) { return candle.close; });
  const rci = candles.map(function (_, index) {
    if (index + 1 < settings.rci.period) return null;
    return rankCorrelation(closes.slice(index + 1 - settings.rci.period, index + 1));
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
  const obvSeries = hasVolume ? obvValues.map(function (_, index) {
    return index + 1 < settings.obv.lookback + 1 ? null : obvValues[index] - obvValues[index + 1 - settings.obv.lookback];
  }) : Array(candles.length).fill(null);

  const fastEma = calculateEmaSeries(closes, settings.ema.fast);
  const slowEma = calculateEmaSeries(closes, settings.ema.slow);
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

  return { rci: rci, obv: obvSeries, obvVolumeAvailable: hasVolume, fastEma: fastEma, slowEma: slowEma, k: k, d: d, j: j };
}

function latestDirection(series) {
  const valid = series.filter(finite);
  return valid.length < 2 ? "neutral" : direction(valid[valid.length - 1], valid[valid.length - 2]);
}

export function buildIndicatorVisualization(candles, settings, nowSeconds) {
  const closedCandles = Array.isArray(candles) ? candles.filter(function (candle) {
    return candle && finite(candle.time) && candle.time + 900 <= nowSeconds &&
      finite(candle.open) && finite(candle.high) && finite(candle.low) && finite(candle.close) &&
      candle.open > 0 && candle.low > 0 && candle.high >= Math.max(candle.open, candle.close, candle.low) &&
      candle.low <= Math.min(candle.open, candle.close);
  }).sort(function (a, b) { return a.time - b.time; }) : [];

  if (!closedCandles.length) return { status: "unavailable", candles: [], indicators: null };
  const series = indicatorSeries(closedCandles, settings);
  const tail = function (values) { return values.slice(-48); };
  const latest = function (values) {
    for (let i = values.length - 1; i >= 0; i -= 1) {
      if (finite(values[i])) return values[i];
    }
    return null;
  };
  const previous = function (values) {
    let found = false;
    for (let i = values.length - 1; i >= 0; i -= 1) {
      if (finite(values[i])) {
        if (found) return values[i];
        found = true;
      }
    }
    return null;
  };
  const rciValue = latest(series.rci);
  const rciPrevious = previous(series.rci);
  const obvValue = latest(series.obv);
  const obvPrevious = previous(series.obv);
  const fast = latest(series.fastEma);
  const slow = latest(series.slowEma);
  const close = closedCandles[closedCandles.length - 1].close;
  const kValue = latest(series.k);
  const dValue = latest(series.d);
  const jValue = latest(series.j);
  const priorK = previous(series.k);
  const priorD = previous(series.d);
  const emaDirection = fast !== null && slow !== null && close < fast && fast < slow ? "bearish" :
    fast !== null && slow !== null && close > fast && fast > slow ? "bullish" : "neutral";
  const kdjCross = finite(kValue) && finite(dValue) && finite(priorK) && finite(priorD) ?
    priorK <= priorD && kValue > dValue ? "bullish" :
      priorK >= priorD && kValue < dValue ? "bearish" : "none" : "unavailable";

  return {
    status: "ok",
    candles: closedCandles,
    indicators: {
      rci: {
        period: settings.rci.period, values: tail(series.rci), value: rciValue,
        direction: direction(rciValue, rciPrevious), upper: 80, lower: -80
      },
      obv: {
        lookback: settings.obv.lookback, values: tail(series.obv), value: obvValue,
        change: finite(obvValue) && finite(obvPrevious) ? obvValue - obvPrevious : null,
        direction: latestDirection(series.obv), volumeAvailable: series.obvVolumeAvailable
      },
      ema: {
        fastPeriod: settings.ema.fast, slowPeriod: settings.ema.slow, close: close,
        fast: fast, slow: slow, fastValues: tail(series.fastEma), slowValues: tail(series.slowEma),
        direction: emaDirection,
        fastDirection: latestDirection(series.fastEma),
        slowDirection: latestDirection(series.slowEma),
        position: fast === null || slow === null ? "Недостатньо даних" :
          close > fast && fast > slow ? "Ціна вище обох EMA" :
            close < fast && fast < slow ? "Ціна нижче обох EMA" : "Ціна між EMA або лінії перетнулися"
      },
      kdj: {
        period: settings.kdj.period, ma1: settings.kdj.ma1, ma2: settings.kdj.ma2,
        k: kValue, d: dValue, j: jValue, kValues: tail(series.k), dValues: tail(series.d), jValues: tail(series.j),
        direction: direction(kValue, priorK), cross: kdjCross
      }
    }
  };
}
