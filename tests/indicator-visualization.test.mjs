import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIRMATION_SETTINGS } from "../indicator-confirmation.mjs";
import { buildIndicatorVisualization } from "../indicator-visualization.mjs";
import { DEFAULT_VISUALIZATION_INTERVAL, getVisualizationInterval, setVisualizationInterval } from "../visualization-state.mjs";

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

test("KDJ visualization applies the configured MA1 and MA2 lengths", function () {
  const nowSeconds = 1701000000;
  const rows = candles(50, nowSeconds, 100, 1);
  const custom = Object.assign({}, DEFAULT_CONFIRMATION_SETTINGS, {
    kdj: Object.assign({}, DEFAULT_CONFIRMATION_SETTINGS.kdj, { ma1: 2, ma2: 5 })
  });
  const standard = buildIndicatorVisualization(rows, DEFAULT_CONFIRMATION_SETTINGS, nowSeconds);
  const configured = buildIndicatorVisualization(rows, custom, nowSeconds);
  assert.equal(configured.indicators.kdj.ma1, 2);
  assert.equal(configured.indicators.kdj.ma2, 5);
  assert.notDeepEqual(configured.indicators.kdj.kValues, standard.indicators.kdj.kValues);
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

function intervalCandles(count, intervalSeconds, nowSeconds, trend) {
  const lastOpen = Math.floor(nowSeconds / intervalSeconds) * intervalSeconds - intervalSeconds;
  let close = 100;
  return Array.from({ length: count }, function (_, index) {
    const open = close;
    close += trend || 0.1;
    return {
      time: lastOpen - (count - index - 1) * intervalSeconds,
      open: open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close: close,
      volume: index + 1
    };
  });
}

test("all supported timeframe data is aligned, complete, and isolated by its interval", function () {
  const now = 1710000000;
  const periods = [["5m", 300], ["15m", 900], ["1h", 3600], ["4h", 14400]];
  periods.forEach(function (entry) {
    const rows = intervalCandles(12, entry[1], now, 0.2);
    const result = buildIndicatorVisualization(rows, DEFAULT_CONFIRMATION_SETTINGS, now, entry[1]);
    assert.equal(result.status, "ok");
    assert.equal(result.candles.length, 12);
    assert.equal(result.candles.at(-1).time + entry[1] <= now, true);
    assert.equal(result.candles.every(function (candle) { return candle.time % entry[1] === 0; }), true);
  });
  const wrongInterval = buildIndicatorVisualization(intervalCandles(12, 900, now), DEFAULT_CONFIRMATION_SETTINGS, now, 300);
  assert.equal(wrongInterval.status, "incomplete");
});

test("visualization uses three configured RCI and EMA periods without altering radar settings", function () {
  const now = 1710000000;
  const settings = {
    rci: { periods: [6, 12, 24] },
    obv: { lookback: 10 },
    ema: { periods: [200, 55, 22] },
    kdj: { period: 9, ma1: 3, ma2: 3 }
  };
  const result = buildIndicatorVisualization(intervalCandles(300, 900, now), settings, now, 900);
  assert.deepEqual(result.indicators.rci.periods, [6, 12, 24]);
  assert.equal(result.indicators.rci.lines.length, 3);
  assert.deepEqual(result.indicators.ema.periods, [200, 55, 22]);
  assert.equal(result.indicators.ema.lines.length, 3);
  assert.equal(result.indicators.ema.lines[0].value !== null, true);
  assert.equal(result.indicators.rci.upper, 80);
  assert.equal(result.indicators.rci.lower, -80);
});

test("EMA 200 and KDJ length 99 require their configured closed-candle histories", function () {
  const now = 1710000000;
  const settings = {
    rci: { periods: [6, 12, 24] }, obv: { lookback: 10 },
    ema: { periods: [200, 55, 22] }, kdj: { period: 99, ma1: 1, ma2: 1 }
  };
  const short = buildIndicatorVisualization(intervalCandles(199, 900, now), settings, now, 900);
  assert.equal(short.indicators.ema.lines[0].value, null);
  assert.equal(Number.isFinite(short.indicators.kdj.k), true);
  const enough = buildIndicatorVisualization(intervalCandles(200, 900, now), settings, now, 900);
  assert.equal(Number.isFinite(enough.indicators.ema.lines[0].value), true);
  assert.equal(Number.isFinite(enough.indicators.kdj.k), true);
});

test("duplicate candles are deduplicated and gaps are reported as incomplete history", function () {
  const now = 1710000000;
  const rows = intervalCandles(4, 900, now);
  const duplicate = buildIndicatorVisualization([rows[0], rows[1], rows[1], rows[2], rows[3]],
    DEFAULT_CONFIRMATION_SETTINGS, now, 900);
  assert.equal(duplicate.status, "ok");
  assert.equal(duplicate.candles.length, 4);
  const gap = buildIndicatorVisualization([rows[0], rows[1], rows[3]], DEFAULT_CONFIRMATION_SETTINGS, now, 900);
  assert.equal(gap.status, "incomplete");
});

test("EMA intersections report an actual direction and the crossed periods", function () {
  const now = 1710000000;
  const rows = intervalCandles(5, 900, now);
  [10, 9, 8, 7, 20].forEach(function (close, index) {
    rows[index].open = close;
    rows[index].close = close;
    rows[index].high = close + 1;
    rows[index].low = close - 1;
  });
  const settings = {
    rci: { periods: [2, 3, 4] }, obv: { lookback: 2 },
    ema: { periods: [2, 3, 4] }, kdj: { period: 2, ma1: 1, ma2: 1 }
  };
  const result = buildIndicatorVisualization(rows, settings, now, 900);
  assert.equal(result.indicators.ema.crosses.some(function (cross) {
    return cross.periods.join("/") === "2/3" && cross.direction === "bullish";
  }), true);
});

test("per-contract selections default to 15m and parameter changes do not switch other pairs", function () {
  let selections = {};
  assert.equal(DEFAULT_VISUALIZATION_INTERVAL, "15m");
  selections = setVisualizationInterval(selections, "BTC_USDT", "5m");
  assert.equal(getVisualizationInterval(selections, "BTC_USDT"), "5m");
  assert.equal(getVisualizationInterval(selections, "ETH_USDT"), "15m");
});
