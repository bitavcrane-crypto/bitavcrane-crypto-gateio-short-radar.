export const API_BASE = "https://fx-api.gateio.ws/api/v4";
export const CANDLE_INTERVAL_MS = 15 * 60 * 1000;

export function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeCandles(rows, now = Date.now(), intervalMs = CANDLE_INTERVAL_MS) {
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row) => {
      const values = Array.isArray(row)
        ? { t: row[0], v: row[1], c: row[2], h: row[3], l: row[4], o: row[5] }
        : row;
      const time = toNumber(values.t ?? values.time);
      const candle = {
        time: time === null ? null : time * 1000,
        open: toNumber(values.o ?? values.open),
        high: toNumber(values.h ?? values.high),
        low: toNumber(values.l ?? values.low),
        close: toNumber(values.c ?? values.close),
        volume: toNumber(values.v ?? values.volume),
      };
      return candle;
    })
    .filter((candle) =>
      candle.time !== null &&
      candle.time + intervalMs <= now &&
      candle.open !== null &&
      candle.high !== null &&
      candle.low !== null &&
      candle.close !== null &&
      candle.volume !== null
    )
    .sort((a, b) => a.time - b.time);
}

export function relativeVolume(candles, window = 20) {
  if (candles.length < window + 1) return null;
  const previous = candles.slice(-(window + 1), -1);
  const average = previous.reduce((sum, candle) => sum + candle.volume, 0) / window;
  return average > 0 ? candles.at(-1).volume / average : null;
}

function ema(values, period) {
  const multiplier = 2 / (period + 1);
  let value = values[0];
  return values.map((item, index) => {
    if (index === 0) return value;
    value = (item - value) * multiplier + value;
    return value;
  });
}

export function macdHistogram(closes) {
  if (closes.length < 35) return [];
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const macd = closes.map((_, index) => fast[index] - slow[index]);
  const signal = ema(macd.slice(25), 9);
  return macd.slice(25).map((value, index) => value - signal[index]);
}

function obv(candles) {
  const values = [0];
  for (let index = 1; index < candles.length; index += 1) {
    const direction = Math.sign(candles[index].close - candles[index - 1].close);
    values.push(values.at(-1) + direction * candles[index].volume);
  }
  return values;
}

function percentChange(from, to) {
  return from > 0 ? ((to - from) / from) * 100 : null;
}

export function analyzeContract({
  contract,
  candles,
  ticker = {},
  oiHistory = [],
  fiveMinuteConfirmed = null,
  now = Date.now(),
}) {
  const completed = normalizeCandles(candles, now);
  if (completed.length < 36) {
    return {
      contract,
      status: "insufficient",
      candles: completed,
      score: 0,
      reasons: [],
      pending: ["Потрібно щонайменше 36 закритих свічок 15хв."],
    };
  }

  const latest = completed.at(-1);
  const previous = completed.at(-2);
  const closes = completed.map((candle) => candle.close);
  const histogram = macdHistogram(closes);
  const lastHistogram = histogram.at(-1);
  const priorHistogram = histogram.at(-2);
  const recent = completed.slice(-8);
  const prior = completed.slice(-16, -8);
  const localHigh = Math.max(...completed.slice(-16).map((candle) => candle.high));
  const support = Math.min(...completed.slice(-9, -1).map((candle) => candle.low));
  const recentHigh = Math.max(...recent.map((candle) => candle.high));
  const priorHigh = Math.max(...prior.map((candle) => candle.high));
  const obvValues = obv(completed);
  const recentObvHigh = Math.max(...obvValues.slice(-8));
  const priorObvHigh = Math.max(...obvValues.slice(-16, -8));
  const oneHourChange = percentChange(completed.at(-5).close, latest.close);
  const fourHourChange = percentChange(completed.at(-17).close, latest.close);
  const lastBarChange = percentChange(previous.close, latest.close);
  const priorBarChange = percentChange(completed.at(-3).close, previous.close);
  const volumeRatio = relativeVolume(completed);
  const candleRange = latest.high - latest.low;
  const upperWickRatio = candleRange > 0 ? (latest.high - Math.max(latest.open, latest.close)) / candleRange : 0;
  const fundingRate = toNumber(ticker.funding_rate);
  const oiPoints = Array.isArray(oiHistory)
    ? oiHistory
      .map((point) => ({
        time: toNumber(point.time ?? point.t ?? point.timestamp),
        value: toNumber(point.open_interest ?? point.openInterest ?? point.value),
      }))
      .filter((point) => point.value !== null)
      .sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
      .map((point) => point.value)
    : [];
  const oiChange = oiPoints.length >= 2 && oiPoints.at(-2) !== 0
    ? ((oiPoints.at(-1) - oiPoints.at(-2)) / Math.abs(oiPoints.at(-2))) * 100
    : null;

  const isEarlyPump = oneHourChange >= 1.5 && volumeRatio !== null && volumeRatio >= 1.5 && lastBarChange > priorBarChange;
  const isPump = isEarlyPump || ((oneHourChange >= 3 || fourHourChange >= 6) && volumeRatio !== null && volumeRatio >= 1.2);
  const isOverheated = isPump && (oneHourChange >= 6 || fourHourChange >= 12) &&
    ((volumeRatio !== null && volumeRatio >= 1.4) || (fundingRate !== null && fundingRate >= 0.0005));
  const decelerating = lastBarChange < 0 || (priorBarChange > 0 && lastBarChange < priorBarChange * 0.65);
  const macdWeakening = lastHistogram < priorHistogram;
  const obvDivergence = recentHigh > priorHigh * 1.002 && recentObvHigh <= priorObvHigh;
  const upperWick = upperWickRatio >= 0.45;
  const oiPriceDivergence = oiChange !== null && oiChange > 0 && lastBarChange <= 0;
  const weaknessSignals = [
    decelerating,
    macdWeakening,
    obvDivergence,
    upperWick,
    oiPriceDivergence,
  ].filter(Boolean).length;
  const supportBreak = latest.close < support && latest.close < latest.open;
  const reversalWatch = isOverheated && weaknessSignals >= 2;
  const shortCandidate = isPump && isOverheated && supportBreak;

  const reasons = [];
  if (isEarlyPump) reasons.push(`Початок пампу: +${oneHourChange.toFixed(1)}% за 1г зі зростанням обсягу.`);
  if (isPump && !isEarlyPump) reasons.push(`Памп: +${oneHourChange.toFixed(1)}% за 1г / +${fourHourChange.toFixed(1)}% за 4г.`);
  if (volumeRatio !== null) reasons.push(`Обсяг 15хв: ${volumeRatio.toFixed(2)}× від середнього за 20 свічок.`);
  if (decelerating) reasons.push("Темп ціни сповільнився.");
  if (macdWeakening) reasons.push("Гістограма MACD слабшає.");
  if (obvDivergence) reasons.push("OBV не підтверджує локальний максимум ціни.");
  if (upperWick) reasons.push(`Верхня тінь: ${(upperWickRatio * 100).toFixed(0)}% діапазону свічки.`);
  if (oiPriceDivergence) reasons.push(`OI зріс на ${oiChange.toFixed(1)}%, ціна не зростає.`);
  if (supportBreak) reasons.push("Закрита ведмежа свічка пробила локальну підтримку.");
  if (fiveMinuteConfirmed === true) reasons.push("5хв підтверджує ведмежий імпульс.");
  if (fundingRate !== null && fundingRate >= 0.0005) reasons.push("Funding вказує на перевагу LONG.");

  const pending = [];
  if (!isPump) pending.push("Потрібен виразний памп із підтвердженням обсягу.");
  if (isPump && !isOverheated) pending.push("Очікується підтвердження перегріву.");
  if (isOverheated && weaknessSignals < 2) pending.push("Потрібні щонайменше дві незалежні ознаки ослаблення.");
  if (isOverheated && !supportBreak) pending.push(`Очікується закриття нижче підтримки ${support.toPrecision(6)}.`);

  const scoreFactors = {
    pump: isPump ? 20 : 0,
    volume: volumeRatio !== null && volumeRatio >= 1.5 ? 15 : 0,
    overheated: isOverheated ? 20 : 0,
    weakness: Math.min(weaknessSignals, 4) * 8,
    supportBreak: supportBreak ? 20 : 0,
    funding: fundingRate !== null && fundingRate >= 0.0005 ? 5 : 0,
    openInterest: oiPriceDivergence ? 5 : 0,
  };
  const score = Math.min(100, Object.values(scoreFactors).reduce((sum, value) => sum + value, 0));
  const status = shortCandidate
    ? "short-candidate"
    : reversalWatch
      ? "reversal-watch"
      : isOverheated && weaknessSignals > 0
        ? "weakening"
        : isOverheated
          ? "overheated"
          : isPump
            ? isEarlyPump ? "early-pump" : "active-pump"
            : "scanning";

  return {
    contract,
    status,
    score,
    isPump,
    isOverheated,
    candles: completed,
    scoreFactors,
    price: latest.close,
    change1h: oneHourChange,
    change4h: fourHourChange,
    volumeRatio,
    fundingRate,
    oiChange,
    heat: isOverheated,
    weaknessSignals,
    support,
    invalidation: localHigh,
    latestCandleTime: latest.time,
    lastUpdated: now,
    sources: {
      price: "Gate.io REST · свічки 15хв",
      volume: "Gate.io REST · свічки 15хв",
      funding: fundingRate === null ? null : "Gate.io REST · тікер",
      oi: oiChange === null ? null : "Gate.io REST · contract_stats",
    },
    reasons,
    pending,
  };
}

export function rankTickers(tickers) {
  return [...tickers].sort((a, b) =>
    (toNumber(b.change_percentage) ?? -Infinity) - (toNumber(a.change_percentage) ?? -Infinity)
  );
}
