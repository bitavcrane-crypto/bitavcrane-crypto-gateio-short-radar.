import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenInterestSeries } from "../oi-visualization.mjs";

const sourceInterval = 300;

function samples(count, start) {
  return Array.from({ length: count }, function (_, index) {
    return {
      time: start + index * sourceInterval,
      topLongOpenInterest: 100 + index,
      topShortOpenInterest: 200 - index
    };
  });
}

test("OI timeframes aggregate 5m snapshots using the last observation in each completed bucket", function () {
  const start = Math.floor(1710000000 / sourceInterval) * sourceInterval;
  const rows = samples(96, start);
  const now = start + rows.length * sourceInterval + 1;
  [
    ["5m", 96, 0, 0],
    ["15m", 32, 2, 2],
    ["1h", 8, 11, 11],
    ["4h", 2, 47, 47]
  ].forEach(function (entry) {
    const result = buildOpenInterestSeries(rows, entry[0], now);
    assert.equal(result.status, "ok");
    assert.equal(result.rows.length, entry[1]);
    assert.deepEqual(result.rows[0], {
      time: start + entry[2] * sourceInterval,
      topLongOpenInterest: 100 + entry[3],
      topShortOpenInterest: 200 - entry[3]
    });
  });
  const fourHour = buildOpenInterestSeries(rows, "4h", now);
  assert.ok(fourHour.rows[0].topLongOpenInterest < fourHour.rows[0].topShortOpenInterest);
  assert.ok(fourHour.rows[1].topLongOpenInterest > fourHour.rows[1].topShortOpenInterest);
});

test("OI aggregation excludes incomplete buckets and leaves null gaps instead of connecting across missing data", function () {
  const start = Math.floor(1710000000 / sourceInterval) * sourceInterval;
  const rows = samples(9, start).filter(function (_, index) { return index !== 4; });
  const result = buildOpenInterestSeries(rows, "15m", start + 3 * 900);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.rows.map(function (row) { return row.topLongOpenInterest; }), [102, null, 108]);
  assert.ok(result.rows.every(function (row, index, all) {
    return index === 0 || row.time > all[index - 1].time;
  }));
});

test("OI snapshots are deduplicated and future, invalid, and open-bucket data are excluded", function () {
  const start = Math.floor(1710000000 / sourceInterval) * sourceInterval;
  const result = buildOpenInterestSeries([
    { time: start, topLongOpenInterest: 100, topShortOpenInterest: 200 },
    { time: start, topLongOpenInterest: 101, topShortOpenInterest: 199 },
    { time: start + sourceInterval, topLongOpenInterest: 102, topShortOpenInterest: 198 },
    { time: start + 2 * sourceInterval, topLongOpenInterest: 103, topShortOpenInterest: 197 },
    { time: start + 3 * sourceInterval, topLongOpenInterest: 104, topShortOpenInterest: 196 },
    { time: start + 4 * sourceInterval, topLongOpenInterest: "NaN", topShortOpenInterest: "NaN" },
    { time: start + 5 * sourceInterval, topLongOpenInterest: -1, topShortOpenInterest: -1 }
  ], "5m", start + 3 * sourceInterval + 1);
  assert.equal(result.duplicates, 1);
  assert.deepEqual(result.rows, [
    { time: start, topLongOpenInterest: 101, topShortOpenInterest: 199 },
    { time: start + sourceInterval, topLongOpenInterest: 102, topShortOpenInterest: 198 },
    { time: start + 2 * sourceInterval, topLongOpenInterest: 103, topShortOpenInterest: 197 }
  ]);
  assert.equal(buildOpenInterestSeries([], "4h", start).status, "unavailable");
  assert.equal(buildOpenInterestSeries([{ time: start, openInterest: 1000 }], "5m", start + 600).status, "unavailable");
  assert.equal(buildOpenInterestSeries([{ time: start, topLongOpenInterest: 10 }], "1m", start + 900).status, "unavailable");
});

test("OI source freshness is independent per field and missing trailing samples stay null", function () {
  const start = 1710000000;
  const rows = samples(12, start);
  rows[10].topLongOpenInterest = null;
  rows[11].topLongOpenInterest = null;
  const result = buildOpenInterestSeries(rows, "5m", start + 3900);
  assert.equal(result.source.long.status, "missing");
  assert.equal(result.source.long.lastTime, start + 2700);
  assert.equal(result.source.long.stale, true);
  assert.equal(result.source.short.status, "ok");
  assert.equal(result.source.short.lastTime, start + 3300);
  assert.deepEqual(result.rows.slice(-3).map(function (row) {
    return [row.topLongOpenInterest, row.topShortOpenInterest];
  }), [[null, 190], [null, 189], [null, null]]);
  assert.equal(result.rows.at(-1).time, start + 3600);
});

test("an absent or malformed single OI field never removes the other series", function () {
  const start = 1710000000;
  const result = buildOpenInterestSeries([
    { time: start, topLongOpenInterest: -1, topShortOpenInterest: 200 },
    { time: start + 300, topLongOpenInterest: null, topShortOpenInterest: 201 }
  ], "5m", start + 600);
  assert.equal(result.status, "ok");
  assert.equal(result.source.long.status, "unavailable");
  assert.equal(result.source.long.lastTime, null);
  assert.deepEqual(result.rows.map(function (row) { return row.topLongOpenInterest; }), [null, null]);
  assert.deepEqual(result.rows.map(function (row) { return row.topShortOpenInterest; }), [200, 201]);
});

test("aggregation requires exact five-minute cadence and complete values independently per field", function () {
  const start = 1710000000;
  const irregular = buildOpenInterestSeries([0, 1, 2].map(function (offset) {
    return { time: start + offset, topLongOpenInterest: 100, topShortOpenInterest: 200 };
  }), "15m", start + 900);
  assert.equal(irregular.status, "unavailable");
  assert.equal(irregular.rows[0].topLongOpenInterest, null);
  const rows = samples(3, start);
  rows[1].topLongOpenInterest = null;
  const partial = buildOpenInterestSeries(rows, "15m", start + 900);
  assert.equal(partial.rows[0].topLongOpenInterest, null);
  assert.equal(partial.rows[0].topShortOpenInterest, 198);
});

test("source age is not the age of a completed four-hour aggregate", function () {
  const start = 1710000000;
  const rows = samples(95, start);
  const now = start + 95 * 300;
  const result = buildOpenInterestSeries(rows, "4h", now);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].time, start + 47 * 300);
  assert.equal(result.source.long.lastTime, start + 94 * 300);
  assert.equal(result.source.long.status, "ok");
  assert.equal(buildOpenInterestSeries(rows, "4h", now + 601).source.long.status, "stale");
});

test("ancient source timestamps cannot produce unbounded trailing gaps and retain their actual stale time", function () {
  const now = 1792457700;
  for (const interval of ["5m", "15m", "1h", "4h"]) {
    const result = buildOpenInterestSeries([
      { time: 300, topLongOpenInterest: 100, topShortOpenInterest: 200 }
    ], interval, now);
    assert.ok(result.rows.length <= 100);
    assert.equal(result.status, "unavailable");
    assert.equal(result.source.long.status, "stale");
    assert.equal(result.source.long.lastTime, 300);
    assert.equal(result.source.short.lastTime, 300);
    assert.equal(result.rows.at(-1).topLongOpenInterest, null);
  }
});

test("a consistent five-minute phase offset preserves actual snapshot times without rounding or interpolation", function () {
  const start = 1710000000;
  for (const phase of [1, 60, 299]) {
    const rows = samples(6, start + phase);
    const result = buildOpenInterestSeries(rows, "15m", start + 1800);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.rows.map(function (row) { return row.time; }), [start + 600 + phase, start + 1500 + phase]);
    assert.deepEqual(result.rows.map(function (row) { return row.topLongOpenInterest; }), [102, 105]);
    assert.equal(result.source.long.lastTime, start + 1500 + phase);
    const inconsistent = buildOpenInterestSeries([
      rows[0], { ...rows[1], time: rows[1].time + 1 }, rows[2]
    ], "15m", start + 900);
    assert.equal(inconsistent.status, "unavailable");
    assert.equal(inconsistent.rows[0].topLongOpenInterest, null);
  }
});
