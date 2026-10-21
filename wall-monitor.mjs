const DEFAULTS = Object.freeze({ maxSnapshots: 6, minNotionalUsd: 10000, medianMultiple: 3, tolerance: 0.0015 });
const MAX_BOOK_AGE_MS = 30000;

function validLevel(level) {
  return level && Number.isFinite(level.price) && level.price > 0 &&
    Number.isFinite(level.notionalUsd) && level.notionalUsd > 0;
}

function candidates(levels, minNotionalUsd, medianMultiple) {
  const values = (Array.isArray(levels) ? levels : []).filter(validLevel);
  if (!values.length) return [];
  const amounts = values.map(level => level.notionalUsd).sort((a, b) => a - b);
  const middle = Math.floor(amounts.length / 2);
  const median = amounts.length % 2 ? amounts[middle] : (amounts[middle - 1] + amounts[middle]) / 2;
  const threshold = Math.max(minNotionalUsd, median * medianMultiple);
  return values.filter(level => level.notionalUsd >= threshold);
}

export function createVisibleWallTracker(options = {}) {
  const maxSnapshots = options.maxSnapshots ?? DEFAULTS.maxSnapshots;
  const minNotionalUsd = options.minNotionalUsd ?? DEFAULTS.minNotionalUsd;
  const medianMultiple = options.medianMultiple ?? DEFAULTS.medianMultiple;
  const tolerance = options.tolerance ?? DEFAULTS.tolerance;
  if (!Number.isInteger(maxSnapshots) || maxSnapshots < 2 ||
      !Number.isFinite(minNotionalUsd) || minNotionalUsd <= 0 ||
      !Number.isFinite(medianMultiple) || medianMultiple <= 1 ||
      !Number.isFinite(tolerance) || tolerance <= 0 || tolerance >= 0.02) {
    throw new RangeError("Invalid visible wall tracker options");
  }

  const histories = new Map();

  function summarize(level, side, snapshots) {
    if (!level) return null;
    const observed = snapshots.filter(function (snapshot) {
      return snapshot[side].some(function (item) {
        return Math.abs(item.price / level.price - 1) <= tolerance;
      });
    }).length;
    return {
      price: level.price,
      notionalUsd: level.notionalUsd,
      observedSnapshots: observed,
      sampleCount: snapshots.length,
      persistent: snapshots.length >= 4 && observed / snapshots.length >= 0.67
    };
  }

  function observe(contract, book, observedAtMs = Date.now()) {
    if (typeof contract !== "string" || !contract.trim()) {
      return { status: "UNAVAILABLE", reason: "Невідома торгова пара.", bid: null, ask: null };
    }
    const unavailable = function (reason) {
      histories.delete(contract);
      return { status: "UNAVAILABLE", reason: reason, bid: null, ask: null };
    };
    if (!book || book.quality !== "OK" ||
        !Number.isFinite(book.generatedAt) ||
        !Number.isFinite(book.fetchedAt) ||
        !Array.isArray(book.bidLevels) || !Array.isArray(book.askLevels)) {
      return unavailable("Потрібен свіжий якісний знімок книги заявок.");
    }
    const observedAt = Number.isFinite(observedAtMs) ? observedAtMs : Date.now();
    const generatedAgeMs = observedAt - book.generatedAt * 1000;
    const receiptAgeMs = observedAt - book.fetchedAt;
    if (generatedAgeMs > MAX_BOOK_AGE_MS || generatedAgeMs < -5000 ||
        receiptAgeMs > MAX_BOOK_AGE_MS || receiptAgeMs < -5000) {
      return unavailable("Знімок книги застарів до моменту аналізу.");
    }
    const previous = histories.get(contract) || [];
    const last = previous[previous.length - 1];
    if (last && book.generatedAt <= last.time) return last.summary;
    const snapshot = {
      time: book.generatedAt,
      bid: candidates(book.bidLevels, minNotionalUsd, medianMultiple),
      ask: candidates(book.askLevels, minNotionalUsd, medianMultiple)
    };
    const snapshots = previous.concat(snapshot).slice(-maxSnapshots);
    const bidLevel = [...snapshot.bid].sort((a, b) => b.notionalUsd - a.notionalUsd)[0] || null;
    const askLevel = [...snapshot.ask].sort((a, b) => b.notionalUsd - a.notionalUsd)[0] || null;
    const summary = {
      status: bidLevel || askLevel ? "AVAILABLE" : "NO_WALL",
      reason: bidLevel || askLevel ? null : "Великого рівня за порогом не знайдено.",
      observedSnapshots: snapshots.length,
      maxSnapshots,
      bid: summarize(bidLevel, "bid", snapshots),
      ask: summarize(askLevel, "ask", snapshots)
    };
    snapshots[snapshots.length - 1].summary = summary;
    histories.set(contract, snapshots);
    return summary;
  }

  return {
    observe,
    remove: contract => histories.delete(contract),
    clear: () => histories.clear()
  };
}
