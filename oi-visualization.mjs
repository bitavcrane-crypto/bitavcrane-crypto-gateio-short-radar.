import { OPEN_INTEREST_INTERVALS } from "./visualization-state.mjs";

const SOURCE_INTERVAL_SECONDS = 300;

function numeric(value) {
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && !value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

export function buildOpenInterestSeries(rows, interval, nowSeconds) {
  const intervalSeconds = OPEN_INTEREST_INTERVALS[interval];
  if (!intervalSeconds || !Number.isFinite(nowSeconds) || !Array.isArray(rows)) {
    return { status: "unavailable", intervalSeconds: intervalSeconds || null, rows: [], duplicates: 0 };
  }

  const samples = new Map();
  let duplicates = 0;
  rows.forEach(function (row) {
    const time = numeric(row && row.time);
    const topLongOpenInterest = numeric(row && row.topLongOpenInterest);
    const topShortOpenInterest = numeric(row && row.topShortOpenInterest);
    if (time === null || time <= 0 || time > 10000000000 || time > nowSeconds ||
        (topLongOpenInterest === null && topShortOpenInterest === null) ||
        (topLongOpenInterest !== null && topLongOpenInterest < 0) ||
        (topShortOpenInterest !== null && topShortOpenInterest < 0)) return;
    const timestamp = Math.floor(time);
    if (samples.has(timestamp)) duplicates += 1;
    samples.set(timestamp, {
      time: timestamp,
      topLongOpenInterest: topLongOpenInterest,
      topShortOpenInterest: topShortOpenInterest
    });
  });

  const buckets = new Map();
  samples.forEach(function (sample) {
    const bucketStart = Math.floor(sample.time / intervalSeconds) * intervalSeconds;
    if (bucketStart + intervalSeconds > nowSeconds) return;
    if (!buckets.has(bucketStart)) buckets.set(bucketStart, new Map());
    buckets.get(bucketStart).set(sample.time, sample);
  });
  if (!buckets.size) {
    return { status: "unavailable", intervalSeconds: intervalSeconds, rows: [], duplicates: duplicates };
  }

  const starts = Array.from(buckets.keys()).sort(function (a, b) { return a - b; });
  const first = starts[0];
  const last = starts[starts.length - 1];
  const expectedSamples = intervalSeconds / SOURCE_INTERVAL_SECONDS;
  const series = [];
  for (let bucketStart = first; bucketStart <= last; bucketStart += intervalSeconds) {
    const bucket = buckets.get(bucketStart);
    const ordered = bucket ? Array.from(bucket.values()).sort(function (a, b) { return a.time - b.time; }) : [];
    if (ordered.length === expectedSamples) {
      series.push(ordered[ordered.length - 1]);
    } else {
      series.push({ time: bucketStart, topLongOpenInterest: null, topShortOpenInterest: null });
    }
  }

  return {
    status: series.some(function (point) {
      return Number.isFinite(point.topLongOpenInterest) || Number.isFinite(point.topShortOpenInterest);
    }) ? "ok" : "unavailable",
    intervalSeconds: intervalSeconds,
    rows: series,
    duplicates: duplicates
  };
}
