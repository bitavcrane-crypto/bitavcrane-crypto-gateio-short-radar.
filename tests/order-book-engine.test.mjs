import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeOrderBook, appendBookSnapshot, evaluateBookStability, calculateAtrEntry
} from "../order-book-engine.mjs";

function fullBook(fetchedAt, bidUsd = 10000, askUsd = 20000) {
  return {
    quality: "OK", fetchedAt, bestBid: 99, bestAsk: 101,
    bidLevels: [{ price: 99, notionalUsd: bidUsd }, { price: 50, notionalUsd: 1000 }],
    askLevels: [{ price: 101, notionalUsd: askUsd }, { price: 150, notionalUsd: 1000 }]
  };
}

test("book depth reports cumulative USD by symmetric mid radii and coverage independently", () => {
  const result = analyzeOrderBook(fullBook(1000000));
  assert.equal(result.covered, true);
  assert.equal(result.coverageBelowPercent, 100);
  assert.equal(result.coverageAbovePercent, 100);
  assert.equal(result.bidUsd, 11000);
  assert.equal(result.askUsd, 21000);
  assert.equal(result.imbalancePercent, (11000 - 21000) / 32000 * 100);
  assert.equal(result.bands.length, 5);
});

test("partial depth blocks coverage and is not accepted as a history snapshot", () => {
  const book = {
    quality: "OK", fetchedAt: 1000000, bestBid: 99, bestAsk: 101,
    bidLevels: [{ price: 99, notionalUsd: 1000 }, { price: 90, notionalUsd: 1000 }],
    askLevels: [{ price: 101, notionalUsd: 1000 }, { price: 125, notionalUsd: 1000 }]
  };
  const result = analyzeOrderBook(book);
  assert.equal(result.covered, false);
  assert.equal(result.coverageBelowPercent, 20);
  assert.equal(result.coverageAbovePercent, 50);
  const sampled = appendBookSnapshot({}, "BTC_USDT", result, 1000000);
  assert.equal(sampled.accepted, false);
  assert.equal(sampled.snapshots.length, 0);
});

test("15m stability requires continuous full-depth snapshots and Ask dominance", () => {
  let history = {};
  for (let index = 0; index <= 16; index += 1) {
    const time = 1000000 + index * 60000;
    const analysis = analyzeOrderBook(fullBook(time, 10000, 20000));
    history = appendBookSnapshot(history, "BTC_USDT", analysis, time).history;
  }
  const ready = evaluateBookStability(history.BTC_USDT, 1000000 + 16 * 60000);
  assert.equal(ready.window15.ready, true);
  assert.equal(ready.shortStrength, 2);
  assert.equal(ready.shortReady, true);
  assert.equal(ready.longReady, false);
});

test("a gap greater than three minutes blocks historical book confirmation", () => {
  const snapshots = [
    { time: 1000000, bidUsd: 10000, askUsd: 20000 },
    { time: 1000000 + 60000, bidUsd: 10000, askUsd: 20000 },
    { time: 1000000 + 5 * 60000, bidUsd: 10000, askUsd: 20000 },
    { time: 1000000 + 16 * 60000, bidUsd: 10000, askUsd: 20000 }
  ];
  const result = evaluateBookStability(snapshots, 1000000 + 16 * 60000);
  assert.equal(result.window15.ready, false);
  assert.match(result.window15.reason, /прогалина/);
});

test("ATR entry uses closed 15m candles and places stop at two ATR", () => {
  const candles = Array.from({ length: 16 }, (_, index) => ({
    time: 1000 + index * 900, open: 100, high: 102, low: 98, close: 100
  }));
  const plan = calculateAtrEntry(candles, "SHORT", 1.5);
  assert.ok(plan);
  assert.equal(plan.entry, 100);
  assert.equal(plan.atr14, 4);
  assert.equal(plan.stop, 108);
  assert.equal(plan.tp1, 88);
  assert.equal(plan.tp2, 84);
  assert.equal(plan.tp3, 76);
  assert.equal(calculateAtrEntry(candles.slice(0, 10), "SHORT"), null);
});
