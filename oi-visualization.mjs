import { OPEN_INTEREST_INTERVALS } from "./visualization-state.mjs";

const SOURCE_INTERVAL_SECONDS = 300;
const MAX_SERIES_POINTS = 100;

function numeric(value) {
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && !value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

export function buildOpenInterestSeries(rows, interval, nowSeconds) {
  const intervalSeconds = OPEN_INTEREST_INTERVALS[interval];
  const unavailableSource = { status: "unavailable", lastTime: null, stale: false };
  if (!intervalSeconds || !Number.isFinite(nowSeconds) || !Array.isArray(rows)) {
    return {
      status: "unavailable", intervalSeconds: intervalSeconds || null, rows: [], duplicates: 0,
      source: { long: unavailableSource, short: unavailableSource }
    };
  }

  const samples = new Map();
  let duplicates = 0;
  rows.forEach(function (row) {
    const time = numeric(row && row.time);
    const long = numeric(row && row.topLongOpenInterest);
    const short = numeric(row && row.topShortOpenInterest);
    if (time === null || time <= 0 || time > 10000000000 || time > nowSeconds || !Number.isInteger(time)) return;
    const timestamp = time;
    if (samples.has(timestamp)) duplicates += 1;
    samples.set(timestamp, {
      time: timestamp,
      topLongOpenInterest: long !== null && long >= 0 ? long : null,
      topShortOpenInterest: short !== null && short >= 0 ? short : null
    });
  });

  const orderedSamples = Array.from(samples.values()).sort(function (a, b) { return a.time - b.time; });
  // A five-minute cadence does not require snapshots to fall on UTC multiples of 300.
  const phases = new Map();
  orderedSamples.forEach(function (sample) {
    const phase = sample.time % SOURCE_INTERVAL_SECONDS;
    phases.set(phase, (phases.get(phase) || 0) + 1);
  });
  const sourcePhase = phases.size ? Array.from(phases.entries()).sort(function (a, b) {
    return b[1] - a[1] || a[0] - b[0];
  })[0][0] : 0;
  function sourceState(field) {
    const valid = orderedSamples.filter(function (sample) { return sample[field] !== null; });
    const latest = valid[valid.length - 1];
    if (!latest) return { status: "unavailable", lastTime: null, stale: false };
    const stale = nowSeconds - latest.time > 2 * SOURCE_INTERVAL_SECONDS;
    const missing = orderedSamples[orderedSamples.length - 1][field] === null;
    return {
      status: missing ? "missing" : stale ? "stale" : "ok",
      lastTime: latest.time,
      stale: stale
    };
  }
  const source = { long: sourceState("topLongOpenInterest"), short: sourceState("topShortOpenInterest") };
  const buckets = new Map();
  samples.forEach(function (sample) {
    const bucketStart = Math.floor(sample.time / intervalSeconds) * intervalSeconds;
    if (bucketStart + intervalSeconds > nowSeconds) return;
    if (!buckets.has(bucketStart)) buckets.set(bucketStart, new Map());
    buckets.get(bucketStart).set(sample.time, sample);
  });
  if (!buckets.size) {
    return { status: "unavailable", intervalSeconds: intervalSeconds, rows: [], duplicates: duplicates, source: source };
  }

  const starts = Array.from(buckets.keys()).sort(function (a, b) { return a - b; });
  const last = Math.floor(nowSeconds / intervalSeconds) * intervalSeconds - intervalSeconds;
  // Bound gap padding even when the last source sample is years old.
  const first = Math.max(starts[0], last - (MAX_SERIES_POINTS - 1) * intervalSeconds);
  const expectedSamples = intervalSeconds / SOURCE_INTERVAL_SECONDS;
  const series = [];
  for (let bucketStart = first; bucketStart <= last; bucketStart += intervalSeconds) {
    const bucket = buckets.get(bucketStart);
    const expected = Array.from({ length: expectedSamples }, function (_, index) {
      return bucket && bucket.get(bucketStart + sourcePhase + index * SOURCE_INTERVAL_SECONDS);
    });
    function lastCompleteValue(field) {
      return bucket && bucket.size === expectedSamples &&
        expected.every(function (sample) { return sample && sample[field] !== null; }) ?
        expected[expected.length - 1][field] : null;
    }
    series.push({
      time: bucketStart + sourcePhase + (expectedSamples - 1) * SOURCE_INTERVAL_SECONDS,
      topLongOpenInterest: lastCompleteValue("topLongOpenInterest"),
      topShortOpenInterest: lastCompleteValue("topShortOpenInterest")
    });
  }

  return {
    status: series.some(function (point) {
      return Number.isFinite(point.topLongOpenInterest) || Number.isFinite(point.topShortOpenInterest);
    }) ? "ok" : "unavailable",
    intervalSeconds: intervalSeconds,
    rows: series,
    duplicates: duplicates,
    source: source
  };
}
