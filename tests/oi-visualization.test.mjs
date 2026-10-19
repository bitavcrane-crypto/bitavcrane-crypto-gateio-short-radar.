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
