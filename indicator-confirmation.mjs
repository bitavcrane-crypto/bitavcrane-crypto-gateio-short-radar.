export const DEFAULT_CONFIRMATION_SETTINGS = Object.freeze({
  rci: Object.freeze({ enabled: true, period: 9 }),
  obv: Object.freeze({ enabled: true, lookback: 10 }),
  ema: Object.freeze({ enabled: true, fast: 9, slow: 21 }),
  kdj: Object.freeze({ enabled: true, period: 9 })
});

const SETTINGS_BOUNDS = Object.freeze({
  rci: Object.freeze({ period: [5, 30] }),
  obv: Object.freeze({ lookback: [3, 30] }),
  ema: Object.freeze({ fast: [3, 30], slow: [5, 60] }),
  kdj: Object.freeze({ period: [5, 30] })
});

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeSettings(settings) {
  const normalized = {};
  const issues = [];
  ["rci", "obv", "ema", "kdj"].forEach(function (name) {
    const defaults = DEFAULT_CONFIRMATION_SETTINGS[name];
    const provided = settings && settings[name] && typeof settings[name] === "object" ? settings[name] : {};
    const result = { enabled: typeof provided.enabled === "boolean" ? provided.enabled : defaults.enabled };
    Object.keys(SETTINGS_BOUNDS[name]).forEach(function (key) {
      const bounds = SETTINGS_BOUNDS[name][key];
      const raw = provided[key];
      const value = Number(raw);
      if (raw === undefined || raw === null || raw === "") {
        result[key] = defaults[key];
      } else if (Number.isInteger(value) && value >= bounds[0] && value <= bounds[1]) {
        result[key] = value;
      } else {
        result[key] = defaults[key];
        issues.push(name.toUpperCase() + ": некоректне значення " + key + ", використано стандартне " + defaults[key]);
      }
    });
    normalized[name] = result;
  });
  if (normalized.ema.fast >= normalized.ema.slow) {
    normalized.ema.fast = DEFAULT_CONFIRMATION_SETTINGS.ema.fast;
    normalized.ema.slow = DEFAULT_CONFIRMATION_SETTINGS.ema.slow;
    issues.push("EMA: швидкий період має бути меншим за повільний, використано стандартні значення");
  }
  return { settings: normalized, issues: issues };
}

function rciValue(candles) {
  const count = candles.length;
  const prices = candles.map(function (candle) { return candle.close; });
  const sorted = prices.slice().sort(function (a, b) { return a - b; });
  const priceRanks = prices.map(function (price) {
    let first = sorted.indexOf(price);
    let last = sorted.lastIndexOf(price);
    return (first + last) / 2 + 1;
  });
  let squaredDifference = 0;
  for (let i = 0; i < count; i += 1) {
    const timeRank = i + 1;
    const difference = timeRank - priceRanks[i];
    squaredDifference += difference * difference;
  }
  return (1 - 6 * squaredDifference / (count * (count * count - 1))) * 100;
}

function calculateRci(candles, period) {
  if (candles.length < period + 1) return null;
  const previous = rciValue(candles.slice(-period - 1, -1));
  const current = rciValue(candles.slice(-period));
  return {
    value: current,
    previous: previous,
    direction: current < 0 && current < previous ? "bearish" :
      current > 0 && current > previous ? "bullish" : "neutral"
  };
}

function calculateObv(candles, lookback) {
  if (candles.length < lookback + 1) return null;
  const sample = candles.slice(-lookback - 1);
  if (sample.some(function (candle) { return !finite(candle.volume); })) return null;
  let current = 0;
  const values = [current];
  for (let i = 1; i < sample.length; i += 1) {
    const direction = sample[i].close > sample[i - 1].close ? 1 :
      sample[i].close < sample[i - 1].close ? -1 : 0;
    current += direction * sample[i].volume;
    values.push(current);
  }
  const change = values[values.length - 1] - values[0];
  return {
    value: values[values.length - 1],
    change: change,
    direction: change < 0 ? "bearish" : change > 0 ? "bullish" : "neutral"
  };
}

function calculateEma(candles, fastPeriod, slowPeriod) {
  if (candles.length < slowPeriod + 1) return null;
  function ema(values, period) {
    let result = values.slice(0, period).reduce(function (sum, value) { return sum + value; }, 0) / period;
    const multiplier = 2 / (period + 1);
    for (let i = period; i < values.length; i += 1) {
      result += (values[i] - result) * multiplier;
    }
    return result;
  }
  const closes = candles.map(function (candle) { return candle.close; });
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  const close = closes[closes.length - 1];
  return {
    fast: fast,
    slow: slow,
    direction: fast < slow && close < fast ? "bearish" :
      fast > slow && close > fast ? "bullish" : "neutral"
  };
}

function calculateKdj(candles, period) {
  if (candles.length < period + 5) return null;
  const rawK = [];
  for (let end = period - 1; end < candles.length; end += 1) {
    const window = candles.slice(end - period + 1, end + 1);
    const highest = Math.max.apply(null, window.map(function (candle) { return candle.high; }));
    const lowest = Math.min.apply(null, window.map(function (candle) { return candle.low; }));
    rawK.push(highest === lowest ? 50 : ((candles[end].close - lowest) / (highest - lowest)) * 100);
  }
  const smoothedK = [];
  const dValues = [];
  for (let i = 2; i < rawK.length; i += 1) {
    smoothedK.push((rawK[i] + rawK[i - 1] + rawK[i - 2]) / 3);
    if (smoothedK.length >= 3) {
      const offset = smoothedK.length - 1;
      dValues.push((smoothedK[offset] + smoothedK[offset - 1] + smoothedK[offset - 2]) / 3);
    }
  }
  if (smoothedK.length < 2 || dValues.length < 2) return null;
  const k = smoothedK[smoothedK.length - 1];
  const previousK = smoothedK[smoothedK.length - 2];
  const d = dValues[dValues.length - 1];
  return {
    k: k,
    d: d,
    direction: k < d && k < previousK ? "bearish" :
      k > d && k > previousK ? "bullish" : "neutral"
  };
}

function indicator(name, enabled, calculate, candles, settings) {
  if (!enabled) return { key: name, status: "disabled", direction: null, value: null, detail: "вимкнено" };
  try {
    const result = calculate(candles, settings);
    if (!result) return { key: name, status: "unavailable", direction: null, value: null, detail: "недостатньо історії або даних" };
    const direction = result.direction;
    const value = Object.assign({}, result);
    delete value.direction;
    return {
      key: name,
      status: direction,
      direction: direction,
      value: value,
      detail: direction === "bearish" ? "підтримує ведмежий сценарій" :
        direction === "bullish" ? "підтримує продовження зростання" : "напрямок не визначений"
    };
  } catch (error) {
    return { key: name, status: "unavailable", direction: null, value: null, detail: "помилка розрахунку" };
  }
}

function qualityLabel(bearish, bullish, unavailable, enabled) {
  if (!enabled) return "Вимкнено · базова поведінка радара";
  if (unavailable) return "Неповна · недоступні " + unavailable + " з " + enabled;
  if (bearish > bullish && bearish >= Math.ceil(enabled / 2)) return "Висока узгодженість · " + bearish + " з " + enabled + " ведмежі";
  if (bearish > bullish) return "Часткова · " + bearish + " з " + enabled + " ведмежі";
  if (bullish > bearish) return "Слабка · переважають бичачі сигнали";
  return "Низька · ведмежого підтвердження немає";
}

export function evaluateShortConfirmation(candles, model, settings, nowSeconds) {
  try {
    const normalized = normalizeSettings(settings);
    const closedCandles = Number.isFinite(nowSeconds) && Array.isArray(candles) ?
      candles.filter(function (candle) {
        return candle && finite(candle.time) && candle.time + 900 <= nowSeconds &&
          finite(candle.open) && finite(candle.high) && finite(candle.low) && finite(candle.close) &&
          candle.open > 0 && candle.low > 0 && candle.high >= Math.max(candle.open, candle.close, candle.low) &&
          candle.low <= Math.min(candle.open, candle.close);
      }).sort(function (a, b) { return a.time - b.time; }) : [];
    const active = normalized.settings;
    const results = [
      indicator("RCI", active.rci.enabled, function (list) { return calculateRci(list, active.rci.period); }, closedCandles),
      indicator("OBV", active.obv.enabled, function (list) { return calculateObv(list, active.obv.lookback); }, closedCandles),
      indicator("EMA", active.ema.enabled, function (list) { return calculateEma(list, active.ema.fast, active.ema.slow); }, closedCandles),
      indicator("KDJ", active.kdj.enabled, function (list) { return calculateKdj(list, active.kdj.period); }, closedCandles)
    ];
    const enabled = results.filter(function (result) { return result.status !== "disabled"; }).length;
    const bearish = results.filter(function (result) { return result.direction === "bearish"; }).length;
    const bullish = results.filter(function (result) { return result.direction === "bullish"; }).length;
    const unavailable = results.filter(function (result) { return result.status === "unavailable"; }).length;
    const conflict = bearish > 0 && bullish > 0;
    const primaryState = model && model.state ? model.state.key : "incomplete";
    const ready = enabled > 0 && unavailable === 0 && !conflict &&
      bearish > bullish && bearish >= Math.ceil(enabled / 2);
    let state;
    if (enabled === 0) state = "disabled";
    else if (conflict) state = "conflict";
    else if (primaryState === "entry" && ready) state = "confirmed";
    else if (primaryState === "incomplete" || !closedCandles.length || unavailable === enabled) state = "unavailable";
    else if (primaryState === "hot" && bearish === 0) state = "overheated";
    else if (primaryState === "exhaustion") state = "exhaustion";
    else if (bearish > 0 || primaryState === "setup" || primaryState === "entry") state = "waiting";
    else if (primaryState === "none" || primaryState === "cancelled") state = "neutral";
    else state = "waiting";

    const reasons = normalized.issues.slice();
    if (unavailable) reasons.push("Недоступна історія для: " + results.filter(function (result) {
      return result.status === "unavailable";
    }).map(function (result) { return result.key; }).join(", "));
    if (conflict) reasons.push("Індикатори суперечать один одному");
    if (primaryState !== "entry" && enabled > 0) reasons.push("Базовий радар ще не підтвердив SHORT");
    if (primaryState === "entry" && !ready) reasons.push("Бракує узгодженої підтримки індикаторів для підтвердження");
    if (bearish === 0 && enabled > 0 && !unavailable) reasons.push("Немає ознак слабшання, перекупленість не є сигналом на вхід");
    if (primaryState === "none" || primaryState === "cancelled") reasons.push("Базовий сигнал SHORT відсутній або скасований");

    return {
      state: state,
      label: {
        disabled: "Додаткові індикатори вимкнені",
        conflict: "Суперечливі сигнали",
        confirmed: "SHORT підтверджено індикаторами",
        overheated: "Перегрів · розворот не підтверджено",
        exhaustion: "Виснаження · очікування підтвердження",
        waiting: "Очікування підтвердження ціною",
        neutral: "Базовий SHORT-сигнал відсутній",
        unavailable: "Підтвердження недоступне"
      }[state],
      quality: qualityLabel(bearish, bullish, unavailable, enabled),
      bearish: bearish,
      bullish: bullish,
      enabled: enabled,
      unavailable: results.filter(function (result) { return result.status === "unavailable"; }).map(function (result) { return result.key; }),
      conflict: conflict,
      indicators: results,
      reasons: reasons,
      closedCandleTime: closedCandles.length ? closedCandles[closedCandles.length - 1].time : null
    };
  } catch (error) {
    return {
      state: "unavailable",
      label: "Додаткове підтвердження недоступне",
      quality: "Недоступне · базовий радар працює окремо",
      bearish: 0,
      bullish: 0,
      enabled: 0,
      unavailable: ["RCI", "OBV", "EMA", "KDJ"],
      conflict: false,
      indicators: [],
      reasons: ["Помилка модуля підтвердження"],
      closedCandleTime: null
    };
  }
}

export function normalizeConfirmationSettings(settings) {
  return normalizeSettings(settings);
}
