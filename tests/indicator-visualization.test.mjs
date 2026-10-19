import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIRMATION_SETTINGS } from "../indicator-confirmation.mjs";
import { buildIndicatorVisualization } from "../indicator-visualization.mjs";

function candles(count, nowSeconds, start, change, missingVolume) {
  let close = start;
  return Array.from({ length: count }, function (_, index) {
    const open = close;
    close += change * (1 + index / count);
    return {
      time: nowSeconds - (count - index) * 900,
      open: open,
      high: Math.max(open, close) * 1.01,
      low: Math.min(open, close) * 0.99,
      close: close,
      volume: missingVolume && index === count - 1 ? null : index + 1
    };
  });
}

test("visualizations use each contract's own closed candles and current settings", function () {
  const nowSeconds = 1701000000;
  const btc = buildIndicatorVisualization(candles(50, nowSeconds, 100, 1), DEFAULT_CONFIRMATION_SETTINGS, nowSeconds);
  const eth = buildIndicatorVisualization(candles(50, nowSeconds, 20, -0.1), DEFAULT_CONFIRMATION_SETTINGS, nowSeconds);
  assert.equal(btc.status, "ok");
  assert.equal(eth.status, "ok");
  assert.notEqual(btc.indicators.ema.close, eth.indicators.ema.close);
  assert.equal(btc.indicators.rci.period, DEFAULT_CONFIRMATION_SETTINGS.rci.period);
  assert.equal(btc.indicators.kdj.period, DEFAULT_CONFIRMATION_SETTINGS.kdj.period);
  assert.equal(btc.indicators.kdj.ma1, DEFAULT_CONFIRMATION_SETTINGS.kdj.ma1);
  assert.equal(btc.indicators.kdj.ma2, DEFAULT_CONFIRMATION_SETTINGS.kdj.ma2);
  assert.equal(btc.candles.at(-1).time + 900, nowSeconds);
});

test("visualizations distinguish unavailable data from insufficient history", function () {
  const nowSeconds = 1701000000;
  const missing = buildIndicatorVisualization([], DEFAULT_CONFIRMATION_SETTINGS, nowSeconds);
  const short = buildIndicatorVisualization(candles(4, nowSeconds, 100, 1), DEFAULT_CONFIRMATION_SETTINGS, nowSeconds);
  assert.equal(missing.status, "unavailable");
  assert.equal(short.status, "ok");
  assert.equal(short.indicators.ema.fast, null);
  assert.equal(short.indicators.rci.value, null);
});

test("missing volume leaves OBV unavailable without suppressing price indicators", function () {
  const nowSeconds = 1701000000;
  const result = buildIndicatorVisualization(candles(50, nowSeconds, 100, 1, true),
    DEFAULT_CONFIRMATION_SETTINGS, nowSeconds);
  assert.equal(result.status, "ok");
  assert.equal(result.indicators.obv.value, null);
  assert.equal(result.indicators.ema.close, result.candles.at(-1).close);
});

test("open candles do not affect visualization values", function () {
  const nowSeconds = 1701000000;
  const closed = candles(50, nowSeconds, 100, 1);
  const current = Object.assign({}, closed.at(-1), {
    time: nowSeconds,
    close: 100000,
    high: 100000,
    volume: 100000
  });
  const expected = buildIndicatorVisualization(closed, DEFAULT_CONFIRMATION_SETTINGS, nowSeconds);
  const withOpen = buildIndicatorVisualization(closed.concat(current), DEFAULT_CONFIRMATION_SETTINGS, nowSeconds);
  assert.deepEqual(withOpen, expected);
});
