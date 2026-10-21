export const CVD_TIMEFRAMES = Object.freeze({
  "15m": 900000,
  "1h": 3600000,
  "4h": 14400000
});

const FRAME_NAMES = Object.keys(CVD_TIMEFRAMES);
const TRANSPORT_STATES = new Set(["LOADING", "AVAILABLE", "DELAYED", "UNAVAILABLE", "ERROR"]);
const METRIC_NAMES = [
  "buyVolume", "sellVolume", "delta", "cvd", "cvdChange", "slope", "imbalance", "priceChange"
];

function duration(timeframe) {
  const value = CVD_TIMEFRAMES[timeframe];
  if (!Number.isFinite(value)) throw new RangeError("Unknown CVD timeframe");
  return value;
}

export function bucketStart(timestampMs, timeframe) {
  if (!Number.isFinite(timestampMs)) throw new TypeError("Timestamp must be finite milliseconds");
  const interval = duration(timeframe);
  return Math.floor(timestampMs / interval) * interval;
}

function validTrade(trade) {
  return trade !== null && typeof trade === "object"
    && typeof trade.contract === "string" && trade.contract.trim().length > 0
    && typeof trade.id === "string" && trade.id.length > 0
    && Number.isFinite(trade.timestamp) && trade.timestamp >= 0
    && Number.isFinite(trade.price) && trade.price > 0
    && Number.isFinite(trade.quantity) && trade.quantity > 0
    && Number.isFinite(trade.quoteVolume) && trade.quoteVolume > 0
    && (trade.direction === "BUY" || trade.direction === "SELL")
    && typeof trade.source === "string" && trade.source.trim().length > 0
    && trade.quality === "VERIFIED";
}

function ordered(a, b) {
  return a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function emptyMetrics(reason, sampleCount = 0) {
  return {
    state: "INSUFFICIENT_DATA",
    reason,
    ...Object.fromEntries(METRIC_NAMES.map(name => [name, null])),
    sampleCount
  };
}

function appendAggregate(value, trade) {
  const delta = (value?.delta ?? 0) + (trade.direction === "BUY" ? trade.quoteVolume : -trade.quoteVolume);
  return {
    open: value?.open ?? trade.price,
    high: Math.max(value?.high ?? trade.price, trade.price),
    low: Math.min(value?.low ?? trade.price, trade.price),
    close: trade.price,
    buyVolume: (value?.buyVolume ?? 0) + (trade.direction === "BUY" ? trade.quoteVolume : 0),
    sellVolume: (value?.sellVolume ?? 0) + (trade.direction === "SELL" ? trade.quoteVolume : 0),
    delta,
    cvdHigh: Math.max(value?.cvdHigh ?? 0, delta),
    cvdLow: Math.min(value?.cvdLow ?? 0, delta),
    sampleCount: (value?.sampleCount ?? 0) + 1
  };
}

function aggregate(trades) {
  return [...trades].sort(ordered).reduce(appendAggregate, null) ?? { sampleCount: 0 };
}

function metrics(aggregateValue, interval) {
  const { buyVolume, sellVolume, delta, open, close, sampleCount } = aggregateValue;
  if (!sampleCount) return emptyMetrics("NO_TRADES");
  const result = {
    state: "AVAILABLE",
    reason: null,
    buyVolume,
    sellVolume,
    delta,
    cvd: delta,
    cvdChange: delta,
    slope: delta / (interval / 60000),
    imbalance: buyVolume + sellVolume > 0 ? delta / (buyVolume + sellVolume) : null,
    priceChange: (close / open - 1) * 100,
    sampleCount
  };
  if (METRIC_NAMES.some(name => !Number.isFinite(result[name]))
      || !Number.isFinite(buyVolume + sellVolume)) {
    return emptyMetrics("INVALID_AGGREGATE", sampleCount);
  }
  return result;
}

// Intervals are half-open [start, end); volumes are authoritative quote volumes.
export function calculateMetrics(trades, { start, end }) {
  if (!Array.isArray(trades) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new TypeError("Expected trades and a finite increasing interval");
  }
  const unique = new Map();
  for (const trade of trades) {
    if (!validTrade(trade)) return emptyMetrics("INVALID_TRADE");
    if (trade.timestamp < start || trade.timestamp >= end) continue;
    const key = JSON.stringify([trade.contract, trade.id]);
    if (!unique.has(key)) unique.set(key, trade);
  }
  return metrics(aggregate([...unique.values()]), end - start);
}

function divergenceResult(status, reasonCodes, timeframe, pivots = [], confirmedAt = null) {
  return { status, reasonCodes, timeframe, pivots, confirmedAt };
}

function validBar(bar, interval, now) {
  return bar !== null && typeof bar === "object"
    && Number.isFinite(bar.time) && bucketStart(bar.time, interval.name) === bar.time
    && bar.end === bar.time + interval.ms && bar.end <= now
    && bar.closed === true && bar.coverage === 1
    && Number.isInteger(bar.sampleCount) && bar.sampleCount >= 2
    && ["open", "high", "low", "close", "buyVolume", "sellVolume", "delta", "cvd", "cvdHigh", "cvdLow"]
      .every(key => Number.isFinite(bar[key]))
    && bar.low > 0 && bar.high >= Math.max(bar.open, bar.close)
    && bar.low <= Math.min(bar.open, bar.close)
    && bar.buyVolume >= 0 && bar.sellVolume >= 0 && bar.buyVolume + bar.sellVolume > 0
    && bar.cvdHigh >= bar.cvd && bar.cvdLow <= bar.cvd && bar.cvdHigh >= bar.cvdLow;
}

export function detectDivergence(bars, { timeframe, now }) {
  const ms = duration(timeframe);
  const insufficient = reason => divergenceResult("INSUFFICIENT_DATA", [reason], timeframe);
  if (!Number.isFinite(now) || !Array.isArray(bars)) return insufficient("INVALID_INPUT");
  if (bars.length < 9) return insufficient("MINIMUM_BARS");
  const sorted = [...bars].sort((a, b) => (a?.time ?? 0) - (b?.time ?? 0));
  if (!sorted.every(bar => validBar(bar, { name: timeframe, ms }, now))) {
    return insufficient("INCOMPLETE_OR_INVALID_BARS");
  }
  if (sorted.some((bar, index) => index > 0 && bar.time !== sorted[index - 1].end)) {
    return insufficient("GAPPED_BARS");
  }
  if (sorted.reduce((sum, bar) => sum + bar.sampleCount, 0) < 20) {
    return insufficient("MINIMUM_TRADES");
  }
  const highs = [];
  const lows = [];
  const candidates = [];
  for (let index = 2; index < sorted.length - 2; index += 1) {
    const bar = sorted[index];
    const neighbors = [sorted[index - 2], sorted[index - 1], sorted[index + 1], sorted[index + 2]];
    if (neighbors.every(other => bar.high > other.high)) {
      highs.push(index);
    }
    if (neighbors.every(other => bar.low < other.low)) {
      lows.push(index);
    }
  }
  for (const [indices, status, priceKey, cvdKey] of [
    [highs, "BEARISH", "high", "cvdHigh"], [lows, "BULLISH", "low", "cvdLow"]
  ]) {
    if (indices.length < 2) continue;
    const first = sorted[indices.at(-2)];
    const second = sorted[indices.at(-1)];
    const cvdPivots = indices.slice(-2).every(index => {
      const neighbors = [index - 2, index - 1, index + 1, index + 2];
      return neighbors.every(other => status === "BEARISH"
        ? sorted[index][cvdKey] > sorted[other][cvdKey]
        : sorted[index][cvdKey] < sorted[other][cvdKey]);
    });
    const divergent = status === "BEARISH"
      ? second.high > first.high && second.cvdHigh < first.cvdHigh
      : second.low < first.low && second.cvdLow > first.cvdLow;
    if (divergent && cvdPivots) candidates.push({
      status, first, second, priceKey, cvdKey,
      confirmedAt: sorted[indices.at(-1) + 2].end
    });
  }
  const candidate = candidates.sort((a, b) => a.confirmedAt - b.confirmedAt).at(-1);
  if (!candidate) return divergenceResult("NONE", [], timeframe);
  return divergenceResult(candidate.status, [], timeframe,
    [candidate.first, candidate.second].map(bar => ({
      timestamp: bar.time, price: bar[candidate.priceKey], cvd: bar[candidate.cvdKey]
    })), candidate.confirmedAt);
}

export function createCvdStore(options = {}) {
  const maxIds = options.maxIds ?? 20000;
  const maxHistoryMs = options.maxHistoryMs ?? 72 * 3600000;
  if (!Number.isInteger(maxIds) || maxIds < 1
      || !Number.isFinite(maxHistoryMs) || maxHistoryMs < 36 * 3600000) {
    throw new RangeError("Expected positive maxIds and at least 36 hours of history");
  }
  const contracts = new Map();

  function reset(entry, startedAt, reason) {
    entry.startedAt = startedAt;
    entry.sessionReason = reason;
    entry.session += 1;
    entry.lastTradeAt = null;
    entry.ids = new Set();
    entry.sources = new Set();
    entry.suspect = false;
    entry.totalVolume = 0;
    entry.frames = Object.fromEntries(FRAME_NAMES.map(name => [name, {
      buckets: new Map(), baseline: 0, cutoff: bucketStart(startedAt, name)
    }]));
  }

  function prune(entry, now) {
    for (const name of FRAME_NAMES) {
      const frame = entry.frames[name];
      const cutoff = bucketStart(now, name) - 63 * CVD_TIMEFRAMES[name];
      frame.cutoff = Math.max(frame.cutoff, cutoff);
      for (const [time, bucket] of frame.buckets) {
        if (time < frame.cutoff) {
          frame.baseline += bucket.value.delta;
          frame.buckets.delete(time);
        }
      }
    }
  }

  function addContract(contract, { startedAt, multiplier = null } = {}) {
    if (typeof contract !== "string" || !contract.trim() || !Number.isFinite(startedAt)
        || startedAt < 0 || (multiplier !== null && (!Number.isFinite(multiplier) || multiplier <= 0))) {
      throw new TypeError("Expected a contract, coverage start, and optional positive multiplier");
    }
    if (contracts.has(contract)) return false;
    const entry = {
      contract, multiplier, session: 0, invalidCount: 0, rejectedCount: 0, duplicateCount: 0,
      transportState: "LOADING", transportReason: null, clock: startedAt
    };
    reset(entry, startedAt, "SESSION_STARTED");
    contracts.set(contract, entry);
    return true;
  }

  function resetCoverage(contract, startedAt, reason = "COVERAGE_RESET") {
    const entry = contracts.get(contract);
    if (!entry) return false;
    if (!Number.isFinite(startedAt) || startedAt < 0) throw new TypeError("Invalid coverage start");
    entry.clock = Math.max(entry.clock, startedAt);
    reset(entry, startedAt, reason);
    entry.transportState = "LOADING";
    entry.transportReason = null;
    return true;
  }

  function ingest(trade, now) {
    const entry = contracts.get(trade?.contract);
    if (!entry) return false;
    if (!Number.isFinite(now) || now < 0) throw new TypeError("Invalid current time");
    entry.clock = Math.max(entry.clock, now);
    if (!validTrade(trade) || trade.timestamp > now) {
      entry.invalidCount += 1;
      reset(entry, entry.clock, "INVALID_TRADE");
      entry.suspect = true;
      return false;
    }
    if (entry.clock - entry.startedAt > maxHistoryMs) {
      reset(entry, entry.clock, "HISTORY_LIMIT");
    }
    if (trade.timestamp < entry.startedAt) {
      entry.rejectedCount += 1;
      return false;
    }
    if (entry.ids.has(trade.id)) {
      entry.duplicateCount += 1;
      return false;
    }
    if (entry.ids.size >= maxIds) reset(entry, entry.clock, "ID_CAPACITY");
    if (trade.timestamp < entry.startedAt) {
      entry.rejectedCount += 1;
      return false;
    }
    if (!Number.isFinite(entry.totalVolume + trade.quoteVolume)) {
      entry.invalidCount += 1;
      reset(entry, entry.clock, "INVALID_AGGREGATE");
      entry.suspect = true;
      return false;
    }
    const normalized = { ...trade };
    entry.ids.add(trade.id);
    entry.sources.add(trade.source);
    entry.totalVolume += trade.quoteVolume;
    entry.suspect = false;
    entry.lastTradeAt = Math.max(entry.lastTradeAt ?? trade.timestamp, trade.timestamp);
    entry.transportState = "AVAILABLE";
    entry.transportReason = null;
    prune(entry, entry.clock);
    for (const name of FRAME_NAMES) {
      const frame = entry.frames[name];
      const time = bucketStart(trade.timestamp, name);
      if (time < frame.cutoff) {
        frame.baseline += trade.direction === "BUY" ? trade.quoteVolume : -trade.quoteVolume;
        continue;
      }
      const bucket = frame.buckets.get(time) ?? { trades: [], value: null };
      const last = bucket.trades.at(-1);
      bucket.trades.push(normalized);
      if (!last || ordered(last, normalized) <= 0) {
        bucket.value = appendAggregate(bucket.value, normalized);
      } else {
        bucket.trades.sort(ordered);
        bucket.value = bucket.trades.reduce(appendAggregate, null);
      }
      frame.buckets.set(time, bucket);
    }
    return true;
  }

  function status(contract, state, reason = null) {
    const entry = contracts.get(contract);
    if (!entry) return false;
    if (!TRANSPORT_STATES.has(state)) throw new RangeError("Unknown transport state");
    entry.transportState = state;
    entry.transportReason = reason;
    return true;
  }

  function snapshot(contract, now) {
    const entry = contracts.get(contract);
    if (!entry) return null;
    if (!Number.isFinite(now) || now < entry.clock) {
      throw new RangeError("Snapshot time must not precede the observed clock");
    }
    entry.clock = now;
    if (now - entry.startedAt > maxHistoryMs) {
      reset(entry, now, "HISTORY_LIMIT");
      entry.transportState = "LOADING";
      entry.transportReason = "HISTORY_LIMIT";
    }
    prune(entry, now);
    let state = entry.transportState;
    let reason = entry.transportReason;
    if (entry.suspect) {
      state = "UNAVAILABLE";
      reason = entry.sessionReason;
    } else if (state === "AVAILABLE") {
      if (entry.lastTradeAt === null) {
        state = "LOADING";
        reason = "NO_TRADES";
      } else if (now - entry.lastTradeAt > 120000) {
        state = "UNAVAILABLE";
        reason = "STALE_TRADES";
      } else if (now - entry.lastTradeAt > 30000) {
        state = "DELAYED";
        reason = "STALE_TRADES";
      }
    }
    const frames = {};
    for (const name of FRAME_NAMES) {
      const interval = CVD_TIMEFRAMES[name];
      const current = bucketStart(now, name);
      const stored = entry.frames[name];
      let cumulative = stored.baseline;
      const bars = [];
      for (const [time, bucket] of [...stored.buckets].sort(([a], [b]) => a - b)) {
        const value = bucket.value;
        const end = time + interval;
        const coveredStart = Math.max(time, entry.startedAt);
        const coveredEnd = Math.min(end, now);
        const coverage = Math.max(0, Math.min(1, (coveredEnd - coveredStart) / interval));
        const bar = {
          time, end, ...value,
          cvd: cumulative + value.delta,
          cvdHigh: cumulative + value.cvdHigh,
          cvdLow: cumulative + value.cvdLow,
          coverage,
          closed: end <= now
        };
        cumulative += value.delta;
        bars.push(bar);
      }
      const byTime = new Map(bars.map(bar => [bar.time, bar]));
      const completed = [];
      for (let time = stored.cutoff; time < current; time += interval) {
        completed.push(byTime.get(time) ?? {
          time, end: time + interval,
          open: null, high: null, low: null, close: null,
          buyVolume: null, sellVolume: null, delta: null, cvd: null,
          cvdHigh: null, cvdLow: null, sampleCount: 0,
          coverage: 0, closed: true, gap: true
        });
      }
      const latest = completed.find(bar => bar.time === current - interval);
      const provisionalBar = bars.find(bar => bar.time === current);
      let result = !latest || latest.sampleCount === 0 ? emptyMetrics("NO_TRADES")
        : latest.coverage !== 1 ? emptyMetrics("PARTIAL_COVERAGE", latest.sampleCount)
          : metrics(latest, interval);
      if (result.state === "AVAILABLE") result.cvd = latest.cvd;
      if (state !== "AVAILABLE") result = { ...emptyMetrics(reason ?? state, latest?.sampleCount ?? 0), state };
      const eligible = [];
      // Only the contiguous, fully sampled tail can confirm a current signal.
      for (let index = completed.length - 1; index >= 0; index -= 1) {
        const bar = completed[index];
        if (bar.coverage !== 1 || bar.sampleCount < 2
            || (eligible.length && bar.end !== eligible[0].time)) break;
        eligible.unshift(bar);
      }
      const divergence = result.state === "AVAILABLE"
        ? detectDivergence(eligible, { timeframe: name, now })
        : divergenceResult("INSUFFICIENT_DATA", [reason ?? result.reason ?? "INCOMPLETE_COVERAGE"], name);
      frames[name] = {
        ...result,
        coverage: latest?.coverage ?? 0,
        bars: completed,
        provisional: provisionalBar ? {
          ...emptyMetrics("PROVISIONAL", provisionalBar.sampleCount),
          time: provisionalBar.time, end: provisionalBar.end,
          coverage: provisionalBar.coverage, bar: provisionalBar
        } : null,
        divergence
      };
    }
    return {
      contract, state, reason, lastTradeAt: entry.lastTradeAt,
      startedAt: entry.startedAt, session: entry.session, sessionReason: entry.sessionReason,
      multiplier: entry.multiplier, quality: entry.suspect ? "SUSPECT" : entry.lastTradeAt === null ? null : "VERIFIED",
      sources: [...entry.sources].sort(), invalidCount: entry.invalidCount,
      rejectedCount: entry.rejectedCount, duplicateCount: entry.duplicateCount,
      retainedIds: entry.ids.size, frames
    };
  }

  return {
    addContract, removeContract: contract => contracts.delete(contract),
    resetCoverage, ingest, status, snapshot
  };
}
