const RADII = [1, 5, 15, 30, 50];
const MAX_GAP_MS = 180000;
const HISTORY_LIMIT = 40;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function cleanLevels(levels) {
  return Array.isArray(levels) ? levels.filter(level =>
    level && finite(level.price) && level.price > 0 &&
    finite(level.notionalUsd) && level.notionalUsd > 0
  ) : [];
}

function sideCoverage(levels, mid, requestedPercent) {
  if (!levels.length || !finite(mid) || mid <= 0) return 0;
  const furthest = Math.max(0, ...levels.map(level =>
    Math.abs(level.price / mid - 1) * 100
  ));
  return furthest / requestedPercent * 100;
}

function sumWithin(levels, mid, radiusPercent) {
  return levels.reduce((sum, level) =>
    Math.abs(level.price / mid - 1) <= radiusPercent / 100 + 1e-12 ?
      sum + level.notionalUsd : sum, 0
  );
}

function ratio(a, b) {
  return finite(a) && finite(b) && b > 0 ? a / b : null;
}

export function analyzeOrderBook(book) {
  if (!book || book.quality !== "OK" || !finite(book.bestBid) ||
      !finite(book.bestAsk) || book.bestBid <= 0 || book.bestAsk <= book.bestBid) {
    return { quality: book?.quality || "NO DATA", covered: false, reason: "Книга відсутня, застаріла або некоректна." };
  }
  const bids = cleanLevels(book.bidLevels);
  const asks = cleanLevels(book.askLevels);
  if (!bids.length || !asks.length) {
    return { quality: "INCOMPLETE", covered: false, reason: "Немає рівнів Bid або Ask." };
  }
  const mid = (book.bestBid + book.bestAsk) / 2;
  const coverageBelowPercent = sideCoverage(bids, mid, 50);
  const coverageAbovePercent = sideCoverage(asks, mid, 50);
  const bands = RADII.map(radius => {
    const bidUsd = sumWithin(bids, mid, radius);
    const askUsd = sumWithin(asks, mid, radius);
    return {
      radiusPercent: radius, bidUsd, askUsd,
      bidAskRatio: ratio(bidUsd, askUsd),
      imbalancePercent: bidUsd + askUsd > 0 ?
        (bidUsd - askUsd) / (bidUsd + askUsd) * 100 : null,
      coveredBelow: coverageBelowPercent >= radius / 50 * 100,
      coveredAbove: coverageAbovePercent >= radius / 50 * 100
    };
  });
  let balanceRadiusPercent = null;
  for (let radius = 1; radius <= 50; radius += 1) {
    if (coverageBelowPercent < radius / 50 * 100 ||
        coverageAbovePercent < radius / 50 * 100) break;
    const bidUsd = sumWithin(bids, mid, radius);
    const askUsd = sumWithin(asks, mid, radius);
    if (bidUsd >= askUsd) { balanceRadiusPercent = radius; break; }
  }
  const outer = bands[bands.length - 1];
  const covered = coverageBelowPercent >= 100 && coverageAbovePercent >= 100;
  return {
    quality: book.quality, mid, fetchedAt: book.fetchedAt,
    bidLevelsCount: bids.length, askLevelsCount: asks.length,
    coverageBelowPercent, coverageAbovePercent, covered,
    bidUsd: outer.bidUsd, askUsd: outer.askUsd,
    bidAskRatio: outer.bidAskRatio, imbalancePercent: outer.imbalancePercent,
    balanceRadiusPercent, bands,
    reason: covered ? "Книга покриває ±50%." :
      "Книга не покриває весь діапазон ±50%; новий вхід заблоковано."
  };
}

export function appendBookSnapshot(history, contract, analysis, now = Date.now()) {
  const next = { ...(history || {}) };
  const previous = Array.isArray(next[contract]) ? next[contract] : [];
  if (!analysis || analysis.quality !== "OK" || !finite(analysis.fetchedAt) ||
      !analysis.covered || analysis.fetchedAt > now + 5000 || now - analysis.fetchedAt > 30000) {
    return { history: next, snapshots: previous, accepted: false };
  }
  const snapshot = {
    time: analysis.fetchedAt,
    bidUsd: analysis.bidUsd,
    askUsd: analysis.askUsd,
    bidAskRatio: analysis.bidAskRatio
  };
  if (previous.some(item => item.time === snapshot.time)) {
    return { history: next, snapshots: previous, accepted: false };
  }
  const snapshots = previous.filter(item => now - item.time <= 35 * 60 * 1000);
  snapshots.push(snapshot);
  next[contract] = snapshots.slice(-HISTORY_LIMIT);
  return { history: next, snapshots: next[contract], accepted: true };
}

function continuousWindow(snapshots, minutes, now) {
  const duration = minutes * 60000;
  if (!Array.isArray(snapshots) || snapshots.length < 2) {
    return { ready: false, reason: "Ще немає достатньо реальних знімків." };
  }
  const end = snapshots[snapshots.length - 1];
  const startTarget = end.time - duration;
  const eligibleStarts = snapshots.filter(item => item.time <= startTarget);
  const start = eligibleStarts.length ? eligibleStarts[eligibleStarts.length - 1] : null;
  if (!start || startTarget - start.time > MAX_GAP_MS) {
    return { ready: false, reason: "Період спостереження ще не завершився." };
  }
  const window = snapshots.filter(item => item.time >= start.time && item.time <= end.time);
  for (let index = 1; index < window.length; index += 1) {
    if (window[index].time - window[index - 1].time > MAX_GAP_MS) {
      return { ready: false, reason: "У спостереженнях є прогалина понад 3 хв." };
    }
  }
  if (now - end.time > MAX_GAP_MS) {
    return { ready: false, reason: "Останній знімок старший за 3 хв." };
  }
  return { ready: true, start, end, samples: window.length };
}

export function evaluateBookStability(snapshots, now = Date.now()) {
  const window15 = continuousWindow(snapshots, 15, now);
  const window30 = continuousWindow(snapshots, 30, now);
  const current = Array.isArray(snapshots) && snapshots.length ? snapshots[snapshots.length - 1] : null;
  const longStrength = current && current.askUsd > 0 ? current.bidUsd / current.askUsd : null;
  const shortStrength = current && current.bidUsd > 0 ? current.askUsd / current.bidUsd : null;
  const longStable = window15.ready && window15.start.bidUsd > 0 && window15.start.askUsd > 0 &&
    longStrength !== null && longStrength >= (window15.start.bidUsd / window15.start.askUsd) * 0.9;
  const shortStable = window15.ready && window15.start.bidUsd > 0 && window15.start.askUsd > 0 &&
    shortStrength !== null && shortStrength >= (window15.start.askUsd / window15.start.bidUsd) * 0.9;
  return {
    window15, window30, longStrength, shortStrength,
    longStable, shortStable,
    longReady: Boolean(window15.ready && longStrength >= 1.5 && longStable),
    shortReady: Boolean(window15.ready && shortStrength >= 1.5 && shortStable)
  };
}

export function calculateAtrEntry(candles, direction, minimumRiskReward = 1.5) {
  if (!Array.isArray(candles) || candles.length < 15 ||
      !["LONG", "SHORT"].includes(direction)) return null;
  const closed = candles.filter(candle =>
    candle && finite(candle.time) && finite(candle.open) && finite(candle.high) &&
    finite(candle.low) && finite(candle.close) && candle.high >= candle.low
  );
  if (closed.length < 15) return null;
  const ranges = [];
  for (let index = 1; index < closed.length; index += 1) {
    const candle = closed[index];
    const previousClose = closed[index - 1].close;
    ranges.push(Math.max(candle.high - candle.low,
      Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose)));
  }
  if (ranges.length < 14) return null;
  const atr = ranges.slice(-14).reduce((sum, value) => sum + value, 0) / 14;
  const entry = closed[closed.length - 1].close;
  if (!finite(atr) || atr <= 0 || !finite(entry) || entry <= 0) return null;
  const risk = atr * 2;
  const stop = direction === "LONG" ? entry - risk : entry + risk;
  if (stop <= 0) return null;
  const sign = direction === "LONG" ? 1 : -1;
  const target = multiple => entry + sign * risk * multiple;
  return {
    direction, entry, atr14: atr, stop,
    tp1: target(Math.max(1.5, minimumRiskReward)),
    tp2: target(2), tp3: target(3),
    riskReward: Math.max(1.5, minimumRiskReward),
    basis: "Закрита 15m свічка · стоп 2×ATR(14)"
  };
}
