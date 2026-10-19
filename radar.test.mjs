import test from "node:test";
import assert from "node:assert/strict";
import { analyzeContract, normalizeCandles, relativeVolume } from "./radar.mjs";

const now = Date.now();

function makeCandles({ breakout = false, openCandle = false } = {}) {
  const rows = [];
  let close = 100;
  for (let index = 0; index < 60; index += 1) {
    const time = Math.floor((now - (60 - index) * 15 * 60 * 1000) / 1000);
    const open = close;
    close *= index >= 42 ? 1.02 : 1.003;
    let candle = {
      t: time,
      o: open,
      h: close * 1.005,
      l: open * 0.995,
      c: close,
      v: 10,
    };
    if (breakout && index === 59) {
      candle = { ...candle, o: open, h: open * 1.002, l: open * 0.83, c: open * 0.84, v: 30 };
    }
    if (index === 59) candle.v = 30;
    rows.push(candle);
  }
  if (openCandle) {
    rows.push({
      t: Math.floor((now - 60_000) / 1000),
      o: close,
      h: close * 1.2,
      l: close * 0.9,
      c: close * 1.1,
      v: 1_000,
    });
  }
  return rows;
}

test("normalizeCandles sorts and excludes the still-open interval", () => {
  const candles = normalizeCandles(makeCandles({ openCandle: true }), now);
  assert.equal(candles.length, 60);
  assert.ok(candles[0].time < candles.at(-1).time);
});

test("relative volume compares the latest completed candle with prior candles", () => {
  const candles = normalizeCandles(makeCandles(), now);
  assert.equal(relativeVolume(candles), 3);
});

test("overheating alone does not qualify a short candidate", () => {
  const result = analyzeContract({
    contract: "TEST_USDT",
    candles: makeCandles(),
    ticker: { funding_rate: "0.0006" },
    now,
  });
  assert.equal(result.isPump, true);
  assert.equal(result.isOverheated, true);
  assert.notEqual(result.status, "short-candidate");
  assert.ok(result.pending.some((item) => item.includes("підтримки")));
  assert.ok(result.score < 100);
});

test("missing volume history does not create a pump signal", () => {
  const candles = makeCandles().map((candle) => ({ ...candle, v: 0 }));
  const result = analyzeContract({
    contract: "TEST_USDT",
    candles,
    ticker: { funding_rate: "0.0006" },
    now,
  });
  assert.equal(result.volumeRatio, null);
  assert.equal(result.isPump, false);
  assert.equal(result.isOverheated, false);
});

test("a closed bearish support break qualifies a pumped and overheated contract", () => {
  const result = analyzeContract({
    contract: "TEST_USDT",
    candles: makeCandles({ breakout: true }),
    ticker: { funding_rate: "0.0006" },
    now,
  });
  assert.equal(result.status, "short-candidate");
  assert.ok(result.reasons.some((reason) => reason.includes("пробила локальну підтримку")));
  assert.ok(result.support > result.price);
  assert.ok(result.invalidation > result.price);
});

test("open-interest changes are calculated in chronological order", () => {
  const result = analyzeContract({
    contract: "TEST_USDT",
    candles: makeCandles({ breakout: true }),
    oiHistory: [
      { time: 2, open_interest: "110" },
      { time: 1, open_interest: "100" },
    ],
    ticker: { funding_rate: "0.0006" },
    now,
  });
  assert.equal(result.oiChange, 10);
});
