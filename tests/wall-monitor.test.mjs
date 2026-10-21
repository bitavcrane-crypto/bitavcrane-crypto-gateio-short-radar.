import test from "node:test";
import assert from "node:assert/strict";
import { createVisibleWallTracker } from "../wall-monitor.mjs";

function book(time, hasBid = true) {
  return {
    quality: "OK",
    generatedAt: time,
    fetchedAt: time * 1000,
    bidLevels: [
      ...(hasBid ? [{ price: 99.9, notionalUsd: 50000 }] : []),
      { price: 99.8, notionalUsd: 1500 },
      { price: 99.7, notionalUsd: 2000 }
    ],
    askLevels: [
      { price: 100.2, notionalUsd: 1400 },
      { price: 100.3, notionalUsd: 1800 }
    ]
  };
}

test("visible large levels report repeated appearances across distinct book snapshots", () => {
  const tracker = createVisibleWallTracker();
  let result;
  for (let index = 1; index <= 6; index += 1) {
    result = tracker.observe("BTC_USDT", book(index * 60, index !== 3), index * 60000 + 500);
  }
  assert.equal(result.status, "AVAILABLE");
  assert.deepEqual(
    [result.bid.observedSnapshots, result.bid.sampleCount, result.bid.persistent],
    [5, 6, true]
  );
  assert.equal(result.ask, null);
  assert.equal(tracker.observe("BTC_USDT", book(360), 360500).bid.observedSnapshots, 5);
});

test("stale, malformed and cross-pair book data do not create wall persistence", () => {
  const tracker = createVisibleWallTracker();
  assert.equal(tracker.observe("BTC_USDT", { quality: "STALE" }, 61000).status, "UNAVAILABLE");
  assert.equal(tracker.observe("ETH_USDT", book(60, false), 61000).status, "NO_WALL");
  assert.equal(tracker.observe("BTC_USDT", book(60), 61000).bid.sampleCount, 1);
  assert.equal(tracker.observe("BTC_USDT", book(30), 31000).bid.sampleCount, 1);
});

test("stale generated or received books clear prior wall history before a later sample", () => {
  const tracker = createVisibleWallTracker();
  tracker.observe("BTC_USDT", book(60), 61000);
  assert.equal(tracker.observe("BTC_USDT", book(120), 150500).status, "UNAVAILABLE");
  assert.equal(tracker.observe("BTC_USDT", book(151, true), 151500).bid.sampleCount, 1);
  tracker.observe("ETH_USDT", book(60), 61000);
  const receivedTooOld = { ...book(145), fetchedAt: 120000 };
  assert.equal(tracker.observe("ETH_USDT", receivedTooOld, 151000).status, "UNAVAILABLE");
  assert.equal(tracker.observe("ETH_USDT", book(152), 152500).bid.sampleCount, 1);
});

test("invalid wall thresholds are rejected", () => {
  assert.throws(() => createVisibleWallTracker({ maxSnapshots: 1 }), RangeError);
});
