import test from "node:test";
import assert from "node:assert/strict";
import {
  CVD_TIMEFRAMES, bucketStart, calculateMetrics, detectDivergence, createCvdStore
} from "../cvd.mjs";

const M15 = CVD_TIMEFRAMES["15m"];
const H4 = CVD_TIMEFRAMES["4h"];
const CONTRACT = "BTC_USDT";

function trade(id, timestamp, direction = "BUY", quoteVolume = 10, price = 100, extra = {}) {
  return {
    contract: CONTRACT, id: String(id), timestamp, price, quantity: 1,
    quoteVolume, direction, source: "TEST", quality: "VERIFIED", ...extra
  };
}

function newStore(options = {}, startedAt = 0) {
  const store = createCvdStore(options);
  store.addContract(CONTRACT, { startedAt, multiplier: 0.001 });
  return store;
}

function ingest(store, row, now = row.timestamp) {
  assert.equal(store.ingest(row, now), true);
}

function freshSnapshot(store, now) {
  ingest(store, trade("fresh-" + now, now));
  return store.snapshot(CONTRACT, now);
}

function fixture(kind = "BEARISH", timeframe = "15m") {
  const interval = CVD_TIMEFRAMES[timeframe];
  const prices = [100, 101, 110, 102, 100, 101, 115, 102, 100];
  const cvds = [10, 20, 100, 30, 10, 20, 80, 30, 10];
  return prices.map((price, index) => {
    const cvd = kind === "BULLISH" ? -cvds[index] : cvds[index];
    const middle = kind === "BULLISH" ? 200 - price : price;
    return {
      time: index * interval, end: (index + 1) * interval,
      open: middle, high: middle + 1, low: middle - 1, close: middle,
      buyVolume: 20, sellVolume: 10, delta: 10,
      cvd, cvdHigh: cvd + 1, cvdLow: cvd - 1,
      sampleCount: 3, coverage: 1, closed: true
    };
  });
}

test("timeframes are frozen independent UTC-aligned intervals", () => {
  assert.deepEqual(CVD_TIMEFRAMES, { "15m": 900000, "1h": 3600000, "4h": 14400000 });
  assert.equal(Object.isFrozen(CVD_TIMEFRAMES), true);
  const utc = Date.parse("2026-10-20T12:37:42Z");
  const offset = Date.parse("2026-10-20T18:07:42+05:30");
  for (const timestamp of [utc, offset]) {
    assert.equal(bucketStart(timestamp, "15m"), Date.parse("2026-10-20T12:30:00Z"));
    assert.equal(bucketStart(timestamp, "1h"), Date.parse("2026-10-20T12:00:00Z"));
    assert.equal(bucketStart(timestamp, "4h"), Date.parse("2026-10-20T12:00:00Z"));
  }
  assert.equal(bucketStart(M15 - 1, "15m"), 0);
  assert.equal(bucketStart(M15, "15m"), M15);
  assert.equal(bucketStart(-1, "15m"), -M15);
  assert.throws(() => bucketStart(NaN, "15m"), TypeError);
  assert.throws(() => bucketStart(0, "5m"), RangeError);
});

test("pure metrics use signed quote volume, interval delta, chronological prices and minute slope", () => {
  const rows = [
    trade("last", M15 - 1, "SELL", 30, 120),
    trade("first", 0, "BUY", 100, 100),
    trade("middle", 300000, "SELL", 20, 110),
    trade("outside", M15, "BUY", 10000, 500)
  ];
  const before = structuredClone(rows);
  const metrics = calculateMetrics(rows, { start: 0, end: M15 });
  assert.equal(metrics.state, "AVAILABLE");
  assert.equal(metrics.buyVolume, 100);
  assert.equal(metrics.sellVolume, 50);
  assert.equal(metrics.delta, 50);
  assert.equal(metrics.cvd, 50);
  assert.equal(metrics.cvdChange, 50);
  assert.equal(metrics.imbalance, 1 / 3);
  assert.equal(metrics.slope, 50 / 15);
  assert.ok(Math.abs(metrics.priceChange - 20) < 1e-10);
  assert.equal(metrics.sampleCount, 3);
  assert.deepEqual(rows, before);
  assert.deepEqual(calculateMetrics([...rows].reverse(), { start: 0, end: M15 }), metrics);
});

test("empty metrics are unknown, while balanced real volume has zero imbalance", () => {
  const empty = calculateMetrics([], { start: 0, end: M15 });
  assert.equal(empty.state, "INSUFFICIENT_DATA");
  assert.equal(empty.sampleCount, 0);
  for (const name of ["buyVolume", "sellVolume", "delta", "cvd", "slope", "imbalance", "priceChange"]) {
    assert.equal(empty[name], null);
  }
  const balanced = calculateMetrics([trade(1, 0), trade(2, 1, "SELL")], { start: 0, end: M15 });
  assert.equal(balanced.delta, 0);
  assert.equal(balanced.imbalance, 0);
  assert.equal(balanced.priceChange, 0);
  const sell = calculateMetrics([trade(1, 0, "SELL", 40)], { start: 0, end: M15 });
  assert.equal(sell.imbalance, -1);
  assert.equal(sell.delta, -40);
  assert.equal(sell.slope, -40 / 15);
  assert.throws(() => calculateMetrics([], { start: 1, end: 1 }), TypeError);
});

test("pure metrics deduplicate contract and ID without mutating inputs", () => {
  const row = trade("same", 0);
  const result = calculateMetrics([row, { ...row }], { start: 0, end: M15 });
  assert.equal(result.sampleCount, 1);
  assert.equal(result.delta, 10);
});

test("normalized payload validation rejects malformed fields instead of guessing a side", () => {
  const invalid = [
    { direction: "buy" }, { direction: "UNKNOWN" }, { direction: undefined },
    { quantity: 0 }, { quantity: -1 }, { quantity: NaN }, { quantity: "1" },
    { price: 0 }, { price: -1 }, { price: Infinity }, { price: "100" },
    { quoteVolume: 0 }, { quoteVolume: -1 }, { quoteVolume: NaN },
    { quality: "INFERRED" }, { quality: undefined }, { source: "" },
    { id: 1 }, { id: "" }, { timestamp: NaN }, { timestamp: -1 }, { contract: "" }
  ];
  for (const fields of invalid) {
    const result = calculateMetrics([trade("bad", 0, "BUY", 10, 100, fields)], { start: 0, end: M15 });
    assert.equal(result.state, "INSUFFICIENT_DATA", JSON.stringify(fields));
    assert.equal(result.reason, "INVALID_TRADE");
    assert.equal(result.delta, null);
  }
});

test("store separates complete metrics from the provisional live bucket", () => {
  const store = newStore();
  ingest(store, trade(1, 0, "BUY", 100, 100));
  ingest(store, trade(2, M15 - 1, "SELL", 30, 120));
  const before = store.snapshot(CONTRACT, M15 - 1).frames["15m"];
  assert.equal(before.state, "INSUFFICIENT_DATA");
  assert.equal(before.delta, null);
  assert.equal(before.bars.length, 0);
  assert.equal(before.provisional.delta, null);
  assert.equal(before.provisional.bar.delta, 70);
  ingest(store, trade(3, M15, "BUY", 7, 130));
  const snapshot = store.snapshot(CONTRACT, M15);
  const frame = snapshot.frames["15m"];
  assert.equal(frame.state, "AVAILABLE");
  assert.equal(frame.delta, 70);
  assert.equal(frame.cvd, 70);
  assert.equal(frame.cvdChange, 70);
  assert.equal(frame.sampleCount, 2);
  assert.equal(frame.coverage, 1);
  assert.equal(frame.bars[0].closed, true);
  assert.equal(frame.bars[0].open, 100);
  assert.equal(frame.bars[0].close, 120);
  assert.equal(frame.provisional.bar.delta, 7);
  assert.equal(frame.provisional.bar.cvd, 77);
  assert.equal(frame.provisional.coverage, 0);
  assert.equal(snapshot.multiplier, 0.001);
  assert.equal(snapshot.quality, "VERIFIED");
  assert.deepEqual(snapshot.sources, ["TEST"]);
  assert.equal(snapshot.frames["1h"].delta, null);
  assert.equal(snapshot.frames["4h"].delta, null);
});

test("CVD is session anchored and never resets at each timeframe boundary", () => {
  const store = newStore();
  for (let index = 0; index < 16; index += 1) {
    ingest(store, trade(index, index * M15, index % 2 ? "SELL" : "BUY", index % 2 ? 3 : 10));
  }
  const snapshot = freshSnapshot(store, H4);
  const quarter = snapshot.frames["15m"];
  const hour = snapshot.frames["1h"];
  const fourHours = snapshot.frames["4h"];
  assert.equal(quarter.cvd, 56);
  assert.equal(quarter.delta, -3);
  assert.equal(quarter.cvdChange, -3);
  assert.equal(hour.cvd, 56);
  assert.equal(hour.delta, 14);
  assert.equal(fourHours.cvd, 56);
  assert.equal(fourHours.delta, 56);
  assert.equal(fourHours.slope, 56 / 240);
  assert.equal(quarter.bars.length, 16);
  assert.equal(hour.bars.length, 4);
  assert.equal(fourHours.bars.length, 1);
});

test("out-of-order trades recalculate OHLC and chronological CVD extrema deterministically", () => {
  const rows = [
    trade("a", 100, "SELL", 20, 100),
    trade("b", 200, "BUY", 50, 120),
    trade("c", 300, "SELL", 40, 90),
    trade("d", M15 + 100, "BUY", 5, 110)
  ];
  const sorted = newStore();
  const shuffled = newStore();
  for (const row of rows) ingest(sorted, row, M15 + 100);
  for (const row of [rows[3], rows[2], rows[0], rows[1]]) ingest(shuffled, row, M15 + 100);
  assert.deepEqual(shuffled.snapshot(CONTRACT, M15 + 100), sorted.snapshot(CONTRACT, M15 + 100));
  const bar = shuffled.snapshot(CONTRACT, M15 + 100).frames["15m"].bars[0];
  assert.equal(bar.open, 100);
  assert.equal(bar.close, 90);
  assert.equal(bar.high, 120);
  assert.equal(bar.low, 90);
  assert.equal(bar.cvd, -10);
  assert.equal(bar.cvdHigh, 30);
  assert.equal(bar.cvdLow, -20);
  const next = shuffled.snapshot(CONTRACT, M15 + 100).frames["15m"].provisional.bar;
  assert.equal(next.cvd, -5);
  assert.equal(next.cvdHigh, -5);
  assert.equal(next.cvdLow, -10);
});

test("same-timestamp trades have deterministic ID order and caller mutation cannot rewrite history", () => {
  const store = newStore();
  const a = trade("a", 0, "SELL", 20);
  ingest(store, trade("b", 0, "BUY", 50));
  ingest(store, a);
  a.direction = "BUY";
  a.quoteVolume = 999;
  const snapshot = freshSnapshot(store, M15);
  const bar = snapshot.frames["15m"].bars[0];
  assert.equal(bar.cvdLow, -20);
  assert.equal(bar.cvdHigh, 30);
  snapshot.frames["15m"].bars[0].delta = 9999;
  snapshot.sources.push("MUTATED");
  const again = store.snapshot(CONTRACT, M15);
  assert.equal(again.frames["15m"].bars[0].delta, 30);
  assert.deepEqual(again.sources, ["TEST"]);
});

test("duplicate IDs are bounded, scoped by contract, and do not refresh trade freshness", () => {
  const store = newStore();
  store.addContract("ETH_USDT", { startedAt: 0 });
  ingest(store, trade("id", 0));
  assert.equal(store.ingest(trade("id", 0), 31000), false);
  ingest(store, trade("id", 0, "SELL", 5, 100, { contract: "ETH_USDT" }), 31000);
  const btc = store.snapshot(CONTRACT, 31000);
  assert.equal(btc.state, "DELAYED");
  assert.equal(btc.lastTradeAt, 0);
  assert.equal(btc.duplicateCount, 1);
  assert.equal(btc.retainedIds, 1);
  assert.equal(btc.frames["15m"].provisional.bar.delta, 10);
  assert.equal(store.snapshot("ETH_USDT", 31000).frames["15m"].provisional.bar.delta, -5);
});

test("coverage starts explicitly; older backfill is rejected and partial buckets are not directional", () => {
  const store = newStore({}, 1000);
  assert.equal(store.ingest(trade("old", 0), 1000), false);
  ingest(store, trade(1, 1000, "BUY", 100));
  ingest(store, trade(2, M15 - 1, "SELL", 20));
  let snapshot = freshSnapshot(store, M15);
  assert.equal(snapshot.rejectedCount, 1);
  assert.equal(snapshot.frames["15m"].state, "INSUFFICIENT_DATA");
  assert.equal(snapshot.frames["15m"].reason, "PARTIAL_COVERAGE");
  assert.equal(snapshot.frames["15m"].delta, null);
  assert.equal(snapshot.frames["15m"].bars[0].coverage, (M15 - 1000) / M15);
  snapshot = freshSnapshot(store, M15 * 2);
  assert.equal(snapshot.frames["15m"].state, "AVAILABLE");
  assert.equal(snapshot.frames["15m"].delta, 10);
  assert.equal(snapshot.frames["15m"].cvd, 90);
});

test("missing completed buckets remain gaps instead of zero-volume bars", () => {
  const store = newStore();
  ingest(store, trade(1, 0));
  const snapshot = freshSnapshot(store, M15 * 2);
  const frame = snapshot.frames["15m"];
  assert.equal(frame.state, "INSUFFICIENT_DATA");
  assert.equal(frame.reason, "NO_TRADES");
  assert.equal(frame.delta, null);
  assert.equal(frame.cvd, null);
  assert.equal(frame.coverage, 0);
  assert.deepEqual(frame.bars.map(bar => bar.time), [0, M15]);
  const gap = frame.bars[1];
  assert.equal(gap.gap, true);
  assert.equal(gap.sampleCount, 0);
  assert.equal(gap.coverage, 0);
  for (const field of ["open", "high", "low", "close", "buyVolume", "sellVolume", "delta", "cvd", "cvdHigh", "cvdLow"]) {
    assert.equal(gap[field], null);
  }
  assert.equal(frame.divergence.status, "INSUFFICIENT_DATA");
});

test("freshness is based on last trade rather than heartbeat, with exact thresholds and recovery", () => {
  const store = newStore();
  assert.equal(store.snapshot(CONTRACT, 0).state, "LOADING");
  store.status(CONTRACT, "AVAILABLE");
  assert.equal(store.snapshot(CONTRACT, 0).state, "LOADING");
  ingest(store, trade(1, 0));
  assert.equal(store.snapshot(CONTRACT, 30000).state, "AVAILABLE");
  store.status(CONTRACT, "AVAILABLE", "HEARTBEAT");
  assert.equal(store.snapshot(CONTRACT, 30001).state, "DELAYED");
  assert.equal(store.snapshot(CONTRACT, 120000).state, "DELAYED");
  store.status(CONTRACT, "AVAILABLE");
  let snapshot = store.snapshot(CONTRACT, 120001);
  assert.equal(snapshot.state, "UNAVAILABLE");
  assert.equal(snapshot.frames["15m"].delta, null);
  assert.equal(snapshot.reason, "STALE_TRADES");
  ingest(store, trade(2, 120002));
  snapshot = store.snapshot(CONTRACT, 120002);
  assert.equal(snapshot.state, "AVAILABLE");
  assert.equal(snapshot.lastTradeAt, 120002);
  assert.throws(() => store.snapshot(CONTRACT, 1), RangeError);
});

test("transport status states and reasons propagate without fabricating usable metrics", () => {
  const store = newStore();
  ingest(store, trade(1, 0));
  for (const state of ["LOADING", "DELAYED", "UNAVAILABLE", "ERROR"]) {
    assert.equal(store.status(CONTRACT, state, "TRANSPORT_TEST"), true);
    const snapshot = store.snapshot(CONTRACT, 0);
    assert.equal(snapshot.state, state);
    assert.equal(snapshot.reason, "TRANSPORT_TEST");
    assert.equal(snapshot.frames["15m"].state, state);
    assert.equal(snapshot.frames["15m"].delta, null);
    assert.equal(snapshot.frames["15m"].divergence.status, "INSUFFICIENT_DATA");
  }
  assert.throws(() => store.status(CONTRACT, "CONNECTED"), RangeError);
  assert.equal(store.status("UNKNOWN", "AVAILABLE"), false);
});

test("invalid ingestion invalidates history and permits recovery only from a new coverage anchor", () => {
  const store = newStore();
  ingest(store, trade(1, 0));
  assert.equal(store.ingest(trade("bad", 1000, "INVALID"), 1000), false);
  let snapshot = store.snapshot(CONTRACT, 1000);
  assert.equal(snapshot.state, "UNAVAILABLE");
  assert.equal(snapshot.reason, "INVALID_TRADE");
  assert.equal(snapshot.quality, "SUSPECT");
  assert.equal(snapshot.invalidCount, 1);
  assert.equal(snapshot.startedAt, 1000);
  assert.equal(snapshot.sessionReason, "INVALID_TRADE");
  assert.equal(snapshot.lastTradeAt, null);
  assert.equal(snapshot.retainedIds, 0);
  store.status(CONTRACT, "AVAILABLE");
  assert.equal(store.snapshot(CONTRACT, 1000).state, "UNAVAILABLE");
  ingest(store, trade(2, 1001));
  snapshot = freshSnapshot(store, M15);
  assert.equal(snapshot.quality, "VERIFIED");
  assert.equal(snapshot.frames["15m"].delta, null);
  assert.equal(snapshot.frames["15m"].reason, "PARTIAL_COVERAGE");
  assert.equal(snapshot.frames["15m"].bars[0].cvd, 10);
  snapshot = freshSnapshot(store, M15 * 2);
  assert.equal(snapshot.frames["15m"].state, "AVAILABLE");
  assert.equal(snapshot.frames["15m"].cvd, 20);
});

test("future-dated payloads invalidate coverage, and all bad price/quantity/direction variants return false", () => {
  const store = newStore();
  const invalid = [
    { timestamp: 1 }, { direction: "sell" }, { quantity: -1 },
    { quantity: 0 }, { price: 0 }, { price: NaN }, { quoteVolume: Infinity },
    { quality: "UNKNOWN" }
  ];
  for (const fields of invalid) {
    assert.equal(store.ingest(trade("bad", 0, "BUY", 10, 100, fields), 0), false);
    assert.equal(store.snapshot(CONTRACT, 0).state, "UNAVAILABLE");
  }
  assert.equal(store.snapshot(CONTRACT, 0).invalidCount, invalid.length);
  assert.equal(store.ingest(null, 0), false);
  assert.equal(store.ingest(trade(1, 0, "BUY", 10, 100, { contract: "UNKNOWN" }), 0), false);
  assert.throws(() => store.ingest(trade(1, 0), NaN), TypeError);
});

test("resetCoverage and removal discard history, dedup IDs and the session anchor", () => {
  const store = newStore();
  assert.equal(store.addContract(CONTRACT, { startedAt: 0 }), false);
  ingest(store, trade("reusable", 0));
  assert.equal(store.resetCoverage(CONTRACT, M15, "RECONNECTED"), true);
  let snapshot = store.snapshot(CONTRACT, M15);
  assert.equal(snapshot.state, "LOADING");
  assert.equal(snapshot.startedAt, M15);
  assert.equal(snapshot.sessionReason, "RECONNECTED");
  assert.equal(snapshot.session, 2);
  assert.equal(snapshot.retainedIds, 0);
  assert.equal(snapshot.frames["15m"].bars.length, 0);
  ingest(store, trade("reusable", M15, "SELL", 30));
  snapshot = freshSnapshot(store, M15 * 2);
  assert.equal(snapshot.frames["15m"].cvd, -30);
  assert.equal(store.removeContract(CONTRACT), true);
  assert.equal(store.snapshot(CONTRACT, M15 * 2), null);
  assert.equal(store.removeContract(CONTRACT), false);
  assert.equal(store.resetCoverage(CONTRACT, M15 * 2), false);
  assert.equal(store.ingest(trade(1, M15 * 2), M15 * 2), false);
  assert.equal(store.addContract(CONTRACT, { startedAt: M15 * 2 }), true);
  assert.equal(store.snapshot(CONTRACT, M15 * 2).session, 1);
});

test("ID capacity exhaustion resets the session instead of silently evicting dedup IDs", () => {
  const store = newStore({ maxIds: 2 });
  ingest(store, trade(1, 0));
  ingest(store, trade(2, 1));
  ingest(store, trade(3, 2));
  let snapshot = store.snapshot(CONTRACT, 2);
  assert.equal(snapshot.session, 2);
  assert.equal(snapshot.sessionReason, "ID_CAPACITY");
  assert.equal(snapshot.startedAt, 2);
  assert.equal(snapshot.retainedIds, 1);
  assert.equal(snapshot.frames["15m"].provisional.bar.cvd, 10);
  assert.equal(store.ingest(trade(1, 0), 3), false);
  snapshot = store.snapshot(CONTRACT, M15);
  assert.equal(snapshot.frames["15m"].delta, null);
  assert.ok(snapshot.retainedIds <= 2);
});

test("history exhaustion explicitly resets coverage both on snapshot and ingestion", () => {
  const limit = 36 * 3600000;
  const store = newStore({ maxHistoryMs: limit });
  ingest(store, trade(1, 0));
  let snapshot = store.snapshot(CONTRACT, limit + 1);
  assert.equal(snapshot.sessionReason, "HISTORY_LIMIT");
  assert.equal(snapshot.startedAt, limit + 1);
  assert.equal(snapshot.state, "LOADING");
  assert.equal(snapshot.retainedIds, 0);
  assert.equal(snapshot.frames["4h"].bars.length, 0);
  const other = newStore({ maxHistoryMs: limit });
  ingest(other, trade(1, 0));
  ingest(other, trade(2, limit + 1));
  snapshot = other.snapshot(CONTRACT, limit + 1);
  assert.equal(snapshot.sessionReason, "HISTORY_LIMIT");
  assert.equal(snapshot.frames["4h"].provisional.bar.cvd, 10);
  assert.equal(snapshot.frames["4h"].delta, null);
  assert.throws(() => createCvdStore({ maxIds: 0 }), RangeError);
  assert.throws(() => createCvdStore({ maxHistoryMs: 3600000 }), RangeError);
  assert.throws(() => other.addContract("X", { startedAt: NaN }), TypeError);
  assert.throws(() => other.addContract("X", { startedAt: 0, multiplier: 0 }), TypeError);
});

test("64-bar retention preserves the session CVD baseline, including late trades in pruned buckets", () => {
  const store = newStore();
  for (let index = 0; index < 70; index += 1) ingest(store, trade(index, index * M15));
  let snapshot = freshSnapshot(store, 70 * M15);
  let frame = snapshot.frames["15m"];
  assert.ok(frame.bars.length <= 64);
  assert.equal(frame.cvd, 700);
  assert.equal(frame.delta, 10);
  const firstTime = frame.bars[0].time;
  assert.ok(firstTime > 0);
  ingest(store, trade("late", 1, "SELL", 100), 70 * M15);
  snapshot = store.snapshot(CONTRACT, 70 * M15);
  frame = snapshot.frames["15m"];
  assert.ok(frame.bars.length <= 64);
  assert.equal(frame.bars[0].time, firstTime);
  assert.equal(frame.cvd, 600);
  assert.equal(frame.delta, 10);
  assert.equal(snapshot.frames["4h"].bars[0].cvd, 60);
});

test("default history retains enough data for at least nine full four-hour buckets", () => {
  const store = newStore();
  for (let index = 0; index < 10; index += 1) {
    ingest(store, trade(index, index * H4));
  }
  const snapshot = freshSnapshot(store, 10 * H4);
  assert.equal(snapshot.session, 1);
  assert.equal(snapshot.frames["4h"].bars.length, 10);
  assert.equal(snapshot.frames["4h"].cvd, 100);
});

for (const kind of ["BEARISH", "BULLISH"]) {
  test(`pure divergence confirms strict paired ${kind.toLowerCase()} pivots after two closed right bars`, () => {
    for (const timeframe of ["15m", "1h", "4h"]) {
      const rows = fixture(kind, timeframe);
      const before = structuredClone(rows);
      const now = 9 * CVD_TIMEFRAMES[timeframe];
      const result = detectDivergence(rows, { timeframe, now });
      assert.equal(result.status, kind);
      assert.equal(result.timeframe, timeframe);
      assert.deepEqual(result.reasonCodes, []);
      assert.equal(result.confirmedAt, now);
      assert.deepEqual(result.pivots.map(pivot => pivot.timestamp), [
        2 * CVD_TIMEFRAMES[timeframe], 6 * CVD_TIMEFRAMES[timeframe]
      ]);
      assert.deepEqual(rows, before);
      assert.deepEqual(detectDivergence([...rows].reverse(), { timeframe, now }), result);
    }
  });
}

test("divergence requires at least nine contiguous covered bars, two samples each, twenty total", () => {
  const options = { timeframe: "15m", now: 9 * M15 };
  const insufficient = rows => {
    const result = detectDivergence(rows, options);
    assert.equal(result.status, "INSUFFICIENT_DATA");
    assert.equal(result.pivots.length, 0);
    assert.equal(result.confirmedAt, null);
    assert.ok(result.reasonCodes.length > 0);
  };
  insufficient(fixture().slice(0, 8));
  insufficient(fixture().map(bar => ({ ...bar, sampleCount: 2 })));
  for (const fields of [
    { coverage: 0.99 }, { closed: false }, { sampleCount: 1 }, { cvd: NaN },
    { high: Infinity }, { open: null }, { low: -1 }, { end: M15 - 1 },
    { cvdLow: 9999 }, { buyVolume: -1 }
  ]) {
    const rows = fixture();
    rows[0] = { ...rows[0], ...fields };
    insufficient(rows);
  }
  const gap = fixture();
  gap[0] = { ...gap[0], time: -M15, end: 0 };
  insufficient(gap);
  const duplicate = fixture();
  duplicate[1] = { ...duplicate[0] };
  insufficient(duplicate);
  assert.equal(detectDivergence(fixture(), { ...options, now: NaN }).status, "INSUFFICIENT_DATA");
});

test("price-only or non-strict CVD pivots never confirm divergence", () => {
  const options = { timeframe: "15m", now: 9 * M15 };
  const increasing = fixture().map((bar, index) => ({
    ...bar, cvd: index * 20, cvdHigh: index * 20 + 1, cvdLow: index * 20 - 1
  }));
  assert.equal(detectDivergence(increasing, options).status, "NONE");
  const equalHighs = fixture();
  equalHighs[2].high = equalHighs[6].high;
  assert.equal(detectDivergence(equalHighs, options).status, "NONE");
  const noCvdLocalPivot = fixture();
  noCvdLocalPivot[5].cvdHigh = noCvdLocalPivot[6].cvdHigh;
  assert.equal(detectDivergence(noCvdLocalPivot, options).status, "NONE");
});

test("right-unconfirmed and unfinished pivots cannot produce a confirmed divergence", () => {
  const options = { timeframe: "15m", now: 9 * M15 };
  const rows = fixture();
  rows[8].closed = false;
  assert.equal(detectDivergence(rows, options).status, "INSUFFICIENT_DATA");
  assert.equal(detectDivergence(fixture(), { ...options, now: 9 * M15 - 1 }).status, "INSUFFICIENT_DATA");
  const shifted = fixture();
  shifted[6] = {
    ...shifted[6], open: 101, high: 102, low: 100, close: 101,
    cvd: 29, cvdHigh: 30, cvdLow: 28
  };
  shifted[8].high = 120;
  shifted[8].cvdHigh = 80;
  assert.equal(detectDivergence(shifted, options).status, "NONE");
});

for (const kind of ["BEARISH", "BULLISH"]) {
  test(`a later nondivergent pivot pair retires an older ${kind.toLowerCase()} divergence`, () => {
    const bars = fixture(kind);
    const prices = [101, 120, 101, 100];
    const values = [20, 120, 20, 10];
    for (let index = 0; index < prices.length; index += 1) {
      const middle = kind === "BEARISH" ? prices[index] : 200 - prices[index];
      const cvd = kind === "BEARISH" ? values[index] : -values[index];
      bars.push({
        ...bars[0], time: (index + 9) * M15, end: (index + 10) * M15,
        open: middle, high: middle + 1, low: middle - 1, close: middle,
        cvd, cvdHigh: cvd + 1, cvdLow: cvd - 1
      });
    }
    assert.equal(detectDivergence(bars.slice(0, 9), { timeframe: "15m", now: 9 * M15 }).status, kind);
    assert.equal(detectDivergence(bars, { timeframe: "15m", now: 13 * M15 }).status, "NONE");
    for (const [index, value] of [[9, 150], [10, 70], [11, 140]]) {
      const cvd = kind === "BEARISH" ? value : -value;
      Object.assign(bars[index], { cvd, cvdHigh: cvd + 1, cvdLow: cvd - 1 });
    }
    assert.equal(detectDivergence(bars, { timeframe: "15m", now: 13 * M15 }).status, "NONE");
  });
}

test("numerical overflow is unavailable rather than a fabricated finite signal", () => {
  const result = calculateMetrics([
    trade(1, 0, "BUY", Number.MAX_VALUE),
    trade(2, 1, "BUY", Number.MAX_VALUE)
  ], { start: 0, end: M15 });
  assert.equal(result.state, "INSUFFICIENT_DATA");
  assert.equal(result.reason, "INVALID_AGGREGATE");
  assert.equal(result.delta, null);
  const store = newStore();
  ingest(store, trade(1, 0, "BUY", Number.MAX_VALUE));
  assert.equal(store.ingest(trade(2, 1, "BUY", Number.MAX_VALUE), 1), false);
  const snapshot = store.snapshot(CONTRACT, 1);
  assert.equal(snapshot.state, "UNAVAILABLE");
  assert.equal(snapshot.reason, "INVALID_AGGREGATE");
  assert.equal(snapshot.frames["15m"].delta, null);
});

for (const kind of ["BEARISH", "BULLISH"]) {
  test(`store confirms ${kind.toLowerCase()} divergence from actual trade paths, never from its live bucket`, () => {
    const store = newStore();
    const bars = fixture(kind);
    for (const [index, bar] of bars.entries()) {
      const peak = Math.abs(bar.cvd);
      const direction = kind === "BEARISH" ? "BUY" : "SELL";
      const opposite = kind === "BEARISH" ? "SELL" : "BUY";
      ingest(store, trade(`${index}-a`, bar.time, direction, peak, bar.open));
      ingest(store, trade(`${index}-b`, bar.time + 1, opposite, peak / 2, kind === "BEARISH" ? bar.high : bar.low));
      ingest(store, trade(`${index}-c`, bar.time + 2, opposite, peak / 2, bar.close));
    }
    let snapshot = store.snapshot(CONTRACT, 9 * M15 - 1);
    assert.equal(snapshot.frames["15m"].divergence.status, "INSUFFICIENT_DATA");
    ingest(store, trade("unconfirmed", 9 * M15, "BUY", 100000, 10000));
    snapshot = store.snapshot(CONTRACT, 9 * M15);
    assert.equal(snapshot.frames["15m"].divergence.status, kind);
    assert.equal(snapshot.frames["15m"].divergence.confirmedAt, 9 * M15);
    assert.equal(snapshot.frames["15m"].bars.length, 9);
    assert.equal(snapshot.frames["15m"].provisional.bar.high, 10000);
    assert.equal(snapshot.frames["15m"].delta, 0);
    assert.equal(snapshot.frames["15m"].cvd, 0);
  });
}

test("divergence can recover after a gap only once a new contiguous nine-bar sample exists", () => {
  const store = newStore();
  ingest(store, trade("early", 0));
  const shift = 2 * M15;
  for (const [index, bar] of fixture().entries()) {
    const time = shift + bar.time;
    ingest(store, trade(`${index}-a`, time, "BUY", bar.cvd, bar.open));
    ingest(store, trade(`${index}-b`, time + 1, "SELL", bar.cvd / 2, bar.high));
    ingest(store, trade(`${index}-c`, time + 2, "SELL", bar.cvd / 2, bar.close));
  }
  const snapshot = freshSnapshot(store, shift + 9 * M15);
  assert.equal(snapshot.frames["15m"].divergence.status, "BEARISH");
  assert.equal(snapshot.frames["15m"].divergence.pivots[0].timestamp, shift + 2 * M15);
  assert.equal(snapshot.frames["15m"].bars.find(bar => bar.time === M15).gap, true);
});
