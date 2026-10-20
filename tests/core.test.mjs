import test from "node:test";
import assert from "node:assert/strict";
import {
  addPair, buildMarketData, calculateContractMetrics, calculateLevels, normalizeCandles, removePair,
  signalState, sortPairsBySignal, transitionSignal, validatePairList
} from "../core.mjs";
import { normalizeContract, normalizeContractStats } from "../gate-api.mjs";

function makeCandles(count, start, interval, trend, volume) {
  const rows = [];
  let close = start;
  for (let i = 0; i < count; i += 1) {
    const open = close;
    close += trend(i);
    const high = Math.max(open, close) * 1.004;
    const low = Math.min(open, close) * 0.996;
    rows.push({
      t: 1700000000 + i * interval,
      o: String(open),
      h: String(high),
      l: String(low),
      c: String(close),
      v: String(volume(i))
    });
  }
  return rows;
}

function makeTimedCandles(count, now, interval, trend, volume) {
  return makeCandles(count, 100, interval, trend, volume).map(function (candle, index) {
    return Object.assign({}, candle, { t: now - (count - index) * interval });
  });
}

test("normalizes candles, removes duplicates and excludes open/future candles", function () {
  const now = 1700000000 + 4 * 300 + 250;
  const input = [
    { t: 1700000000, o: "10", h: "11", l: "9", c: "10", v: "5" },
    { t: 1700000300, o: "10", h: "11", l: "9", c: "10", v: "5" },
    { t: 1700000300, o: "10", h: "11", l: "9", c: "10", v: "5" },
    { t: 1700000600, o: "10", h: "11", l: "9", c: "10", v: "5" },
    { t: 1700000900, o: "10", h: "11", l: "9", c: "10", v: "5" },
    { t: 1700001200, o: "10", h: "11", l: "9", c: "10", v: "5" }
  ];
  const result = normalizeCandles(input, "5m", now);
  assert.equal(result.candles.length, 4);
  assert.equal(result.duplicates, 1);
  assert.equal(result.quality, "SUSPECT");
  assert.ok(result.candles.every(function (candle) { return candle.time + 300 <= now; }));
});

test("missing, stale, malformed timestamps and invalid OHLC remain unavailable", function () {
  assert.equal(normalizeCandles(null, "15m", 1700000000).quality, "NO DATA");
  const stale = normalizeCandles([{ t: 1699990000, o: "1", h: "2", l: "1", c: "2", v: "4" }], "15m", 1700000000);
  assert.equal(stale.quality, "STALE");
  const invalid = normalizeCandles([
    { t: 1700000000000, o: "1", h: "2", l: "1", c: "2", v: "5" },
    { t: 1699999100, o: "1", h: "0.5", l: "0.8", c: "1.1", v: "-2" }
  ], "15m", 1700000000);
  assert.equal(invalid.candles.length, 0);
  assert.equal(invalid.quality, "SUSPECT");
});

test("no lookahead uses only fully closed candles", function () {
  const rows = [
    { t: 1700000000, o: "10", h: "11", l: "9", c: "10", v: "5" },
    { t: 1700000900, o: "10", h: "20", l: "9", c: "19", v: "500" }
  ];
  const result = normalizeCandles(rows, "15m", 1700000900 + 899);
  assert.equal(result.candles.length, 1);
});

test("pump requires price and volume confirmation; missing volume is not zero", function () {
  const now = 1700000000 + 100 * 3600 + 14400;
  const candles15 = makeCandles(50, 10, 900, function (i) { return i > 45 ? 0.8 : 0.01; },
    function (i) { return i === 49 ? 1000 : 10; });
  const candles5 = makeCandles(50, 10, 300, function (i) { return i > 47 ? 0.5 : 0.01; }, function () { return 10; });
  const hourly = makeCandles(50, 10, 3600, function (i) { return i > 45 ? 0.3 : 0.01; }, function () { return 10; });
  const fourHourly = makeCandles(50, 10, 14400, function (i) { return i > 45 ? 0.5 : 0.01; }, function () { return 10; });
  const withVolume = buildMarketData({
    candles: { "5m": candles5, "15m": candles15, "1h": hourly, "4h": fourHourly },
    ticker: { quality: "OK", oi: 1000, funding: null }, nowSeconds: now
  });
  assert.ok(withVolume.pumpScore > 0);
  const noVolume = candles15.map(function (candle) {
    return { t: candle.t, o: candle.o, h: candle.h, l: candle.l, c: candle.c };
  });
  const withoutVolume = buildMarketData({
    candles: { "5m": candles5, "15m": noVolume, "1h": hourly, "4h": fourHourly },
    ticker: { quality: "OK" }, nowSeconds: now
  });
  assert.equal(withoutVolume.data.volumeRatio, null);
  assert.ok(withoutVolume.pumpScore < withVolume.pumpScore);
  assert.ok(withoutVolume.pumpScore <= 35);
});

test("contract stats preserve documented OI units and derive time-based changes", function () {
  const rows = [];
  for (let i = 0; i <= 60; i += 1) {
    rows.push({
      time: 1710000000 - (60 - i) * 300,
      open_interest: String(120 - i * 0.5),
      open_interest_usd: String((120 - i * 0.5) * 1000),
      lsr_account: String(1 + i / 60),
      lsr_taker: "1.2",
      long_liq_usd: "100",
      short_liq_usd: "300"
    });
  }
  const normalized = normalizeContractStats(rows, 1710000000);
  const metrics = calculateContractMetrics(normalized);
  assert.equal(normalized.quality, "OK");
  assert.equal(metrics.openInterest, 90);
  assert.ok(metrics.oiChanges["15m"] < 0);
  assert.ok(metrics.oiChanges["1h"] < 0);
  assert.ok(metrics.oiChanges["4h"] < 0);
  assert.equal(metrics.shortLiquidationUsd, 300);
  assert.equal(calculateContractMetrics(normalizeContractStats([], 1710000000)).quality, "NO DATA");
});

test("OI changes anchor to the exact closed-candle price interval, not the latest stats timestamp", function () {
  const rows = [];
  for (let index = 0; index <= 13; index += 1) {
    rows.push({ time: index * 300, openInterest: 100 + index, lsrAccount: 1 + index / 100 });
  }
  const metrics = calculateContractMetrics({ rows: rows, quality: "OK" }, { "15m": 3600 });
  assert.equal(metrics.oiChanges["15m"], (112 / 109 - 1) * 100);
  assert.equal(metrics.lsrAccountChange15m, (1.12 / 1.09 - 1) * 100);
});

test("Price × OI cannot borrow stale samples or replace missing 4h history with zero", function () {
  const metrics = calculateContractMetrics({ quality: "OK", rows: [
    { time: 3000, openInterest: 100 }, { time: 6600, openInterest: 110 },
    { time: 9300, openInterest: 120 }, { time: 10200, openInterest: 125 }
  ] }, { "15m": 10200, "1h": 10200, "4h": 10200 });
  assert.ok(metrics.oiChanges["15m"] > 0);
  assert.ok(metrics.oiChanges["1h"] > 0);
  assert.equal(metrics.oiChanges["4h"], null);
  const stale = calculateContractMetrics({ quality: "OK", rows: [
    { time: 3000, openInterest: 100 }, { time: 10000, openInterest: 110 }
  ] }, { "15m": 11000 });
  assert.equal(stale.oiChanges["15m"], null);
});

test("4h OI covers the last closed price interval even when its close is almost four hours old", function () {
  const now = 1710000000;
  const rows = Array.from({ length: 100 }, function (_, index) {
    return { time: now - (99 - index) * 300, openInterest: 100 + index };
  });
  const anchors = { "4h": now - 14100 };
  const complete = calculateContractMetrics({ quality: "OK", rows: rows }, anchors);
  assert.equal(complete.oiChanges["4h"], (152 / 104 - 1) * 100);
  const truncated = calculateContractMetrics({ quality: "OK", rows: rows.slice(-60) }, anchors);
  assert.equal(truncated.oiChanges["4h"], null);
});

test("radar rejects missing closed-candle intervals rather than evaluating a discontinuous structure", function () {
  const rows = makeCandles(20, 100, 900, function () { return 0.1; }, function () { return 10; });
  rows.splice(10, 1);
  assert.equal(normalizeCandles(rows, "15m", 1700000000 + 20 * 900).quality, "INCOMPLETE");
});

function levelCandles() {
  const candles = Array.from({ length: 30 }, function (_, index) {
    return { time: 1710000000 + index * 900, open: 0.125, high: 0.126,
      low: 0.124, close: 0.125, volume: 100 };
  });
  candles[8].low = 0.115456;
  candles[12].low = 0.11;
  candles[14].low = 0.10;
  candles[10].high = 0.22;
  candles[29] = { time: candles[29].time, open: 0.123, high: 0.1235,
    low: 0.1218, close: 0.12214, volume: 300 };
  return candles;
}

test("Q_USDT reconstructed closed structure excludes an old 0.22 high and recalculates final R/R", function () {
  const levels = calculateLevels(levelCandles(), { type: "support_break", startIndex: 26 });
  assert.equal(levels.valid, true);
  assert.equal(levels.entry, 0.12214);
  assert.equal(levels.tp1, 0.115456);
  assert.ok(levels.stop < 0.13);
  assert.equal(levels.invalidation, 0.126);
  assert.ok(levels.stop > levels.entry && levels.tp3 < levels.tp2 && levels.tp2 < levels.tp1);
  assert.equal(levels.riskReward, (levels.entry - levels.tp1) / (levels.stop - levels.entry));
});

test("a real but excessively distant local invalidation is rejected, never tightened to manufacture R/R", function () {
  const candles = levelCandles();
  candles[28].high = 0.22;
  const levels = calculateLevels(candles, { type: "support_break", startIndex: 26 });
  assert.equal(levels.valid, false);
  assert.ok(levels.stop > 0.22);
  assert.match(levels.reason, /3 ATR/);
  assert.equal(levels.riskReward, null);
});

test("levels require a recent formation and structural support below entry", function () {
  assert.equal(calculateLevels(levelCandles(), { startIndex: 10 }), null);
  const candles = levelCandles();
  candles[8].low = 0.124;
  candles[12].low = 0.124;
  candles[14].low = 0.124;
  const result = calculateLevels(candles, { startIndex: 26 });
  assert.equal(result.valid, false);
  assert.match(result.reason, /підтримки/);
});

test("contract metadata uses the reported funding interval and active status", function () {
  const active = normalizeContract({ name: "BTC_USDT", status: "trading", funding_interval: 28800 });
  const unknown = normalizeContract({ name: "ALT_USDT", status: "trading" });
  const delisted = normalizeContract({ name: "OLD_USDT", status: "delisting", funding_interval: 28800 });
  assert.equal(active.fundingIntervalSeconds, 28800);
  assert.equal(unknown.fundingIntervalSeconds, null);
  assert.equal(delisted.active, false);
});

test("contract stats flag duplicate, bad timestamp and invalid values", function () {
  const valid = {
    time: 1710000000,
    open_interest: "100",
    open_interest_usd: "1000",
    lsr_account: "1.2",
    long_liq_usd: "0",
    short_liq_usd: "0"
  };
  assert.equal(normalizeContractStats([valid, valid], 1710000000).quality, "SUSPECT");
  assert.equal(normalizeContractStats([Object.assign({}, valid, { time: 1710000000000 })], 1710000000).quality, "SUSPECT");
  assert.equal(normalizeContractStats([Object.assign({}, valid, { open_interest: "-1" })], 1710000000).quality, "SUSPECT");
});

test("contract stats use only documented quote-currency liquidation aggregates", function () {
  const normalized = normalizeContractStats([{
    time: 1710000000,
    open_interest: "10",
    long_liq_usd: "10",
    long_liq_usd_new: "25",
    short_liq_usd: "5",
    short_liq_usd_new: "0"
  }], 1710000000);
  assert.equal(normalized.rows[0].longLiquidationUsd, 10);
  assert.equal(normalized.rows[0].shortLiquidationUsd, 5);
});

test("unknown funding interval does not normalize funding", function () {
  const now = 1701000000;
  const rows15 = makeCandles(30, 100, 900, function () { return 0.01; }, function () { return 10; });
  const data = buildMarketData({
    candles: { "5m": [], "15m": rows15, "1h": [], "4h": [] },
    ticker: { quality: "OK", funding: 0.01, oi: 100 },
    fundingIntervalSeconds: null,
    nowSeconds: now
  });
  assert.equal(data.data.fundingNormalized, null);
  assert.equal(data.data.fundingIntervalSeconds, null);
});

test("normal market and pump without exhaustion do not produce SHORT", function () {
  const now = 1700054010;
  const flat = makeCandles(60, 100, 900, function () { return 0.01; }, function () { return 10; });
  const model = buildMarketData({
    candles: { "5m": [], "15m": flat, "1h": [], "4h": [] },
    ticker: { quality: "OK", last: 100, funding: null },
    nowSeconds: now
  });
  assert.equal(model.state.key, "none");
  assert.equal(model.state.label, "Спокійний ринок");
  assert.equal(model.shortScore, 0);
  assert.notEqual(model.state.key, "entry");
  assert.equal(model.levels, null);

  const pump = makeCandles(60, 100, 900, function (i) { return i > 40 ? 0.35 : 0.02; },
    function (i) { return i > 57 ? 200 : 10; });
  const pumpModel = buildMarketData({
    candles: { "5m": [], "15m": pump, "1h": [], "4h": [] },
    ticker: { quality: "OK", last: 120 },
    nowSeconds: now
  });
  assert.ok(pumpModel.pumpScore > 0);
  assert.notEqual(pumpModel.state.key, "entry");
  if (pumpModel.state.key === "watch" || pumpModel.state.key === "pump") {
    assert.match(pumpModel.why, /SHORT не підтверджено/);
  }
  assert.equal(pumpModel.quality, "INCOMPLETE");
});

test("strong rising pump remains active despite high RSI", function () {
  const now = 1710000000;
  const candles15 = makeTimedCandles(60, now, 900,
    function (index) { return index === 59 ? 4 : 0.05; },
    function (index) { return index === 59 ? 200 : 10; });
  const candles5 = makeTimedCandles(60, now, 300,
    function (index) { return index === 59 ? 3 : 0.01; }, function () { return 10; });
  const candles1h = makeTimedCandles(60, now, 3600, function () { return 0.05; }, function () { return 10; });
  const candles4h = makeTimedCandles(60, now, 14400, function () { return 0.05; }, function () { return 10; });
  const model = buildMarketData({
    candles: { "5m": candles5, "15m": candles15, "1h": candles1h, "4h": candles4h },
    ticker: { quality: "OK", last: 120 }, nowSeconds: now
  });
  assert.ok(model.data.indicators.rsi >= 75);
  assert.equal(model.stage.key, "active");
  assert.match(model.stage.againstShort.join(" "), /високий RSI не переважає/);
  assert.match(model.stage.priceMomentum, /уповільнення не підтверджено/);
  assert.match(model.stage.volumeEvidence, /RVOL .*від середнього 20/);
  assert.notEqual(model.state.key, "entry");
  assert.equal(model.strategy.allowed, false);
});

test("genuine price deceleration compares equal 45-minute windows from closed 15m candles", function () {
  const now = 1710000000;
  const candles15 = makeTimedCandles(60, now, 900, function (index) {
    if (index >= 54 && index <= 56) return 5;
    if (index === 59) return 3.2;
    if (index >= 57) return 1;
    return 0.05;
  }, function (index) { return index === 59 ? 200 : 10; });
  const candles5 = makeTimedCandles(60, now, 300,
    function (index) { return index === 59 ? 1 : 0.01; }, function () { return 10; });
  const candles1h = makeTimedCandles(60, now, 3600, function () { return 0.05; }, function () { return 10; });
  const candles4h = makeTimedCandles(60, now, 14400, function () { return 0.05; }, function () { return 10; });
  const model = buildMarketData({
    candles: { "5m": candles5, "15m": candles15, "1h": candles1h, "4h": candles4h },
    ticker: { quality: "OK", last: 120 }, nowSeconds: now
  });
  assert.ok(model.pumpScore >= 45);
  assert.equal(model.stage.key, "exhaustion");
  assert.match(model.stage.priceMomentum, /останні 45 хв.*попередні 45 хв/);
  assert.ok(model.stage.supportingShort.some(function (reason) { return reason.includes("сповільнився"); }));
  assert.notEqual(model.strategy.allowed, true);
});

test("missing volume remains unavailable and is not described as elevated or holding", function () {
  const now = 1710000000;
  const noVolume = function (candles) {
    return candles.map(function (candle) {
      const result = Object.assign({}, candle);
      delete result.v;
      return result;
    });
  };
  const model = buildMarketData({
    candles: {
      "5m": noVolume(makeTimedCandles(60, now, 300, function () { return 0.1; }, function () { return 10; })),
      "15m": noVolume(makeTimedCandles(60, now, 900, function () { return 0.1; }, function () { return 10; })),
      "1h": makeTimedCandles(60, now, 3600, function () { return 0.1; }, function () { return 10; }),
      "4h": makeTimedCandles(60, now, 14400, function () { return 0.1; }, function () { return 10; })
    },
    ticker: { quality: "OK", last: 120 }, nowSeconds: now
  });
  assert.equal(model.data.volumeRatio, null);
  assert.match(model.stage.volumeEvidence, /RVOL недоступний/);
  assert.match(model.stage.missing.join(" "), /RVOL.*недоступний/);
  assert.doesNotMatch(model.stage.continuationRisk, /RVOL підвищений|обсяг зберігається|обсяг підвищений/);
});

test("weak price structure and momentum with pumpScore zero do not indicate distribution or reversal", function () {
  const now = 1710000000;
  const candles15 = makeTimedCandles(60, now, 900, function (index) {
    return index >= 57 ? -0.1 : 0.01;
  }, function (index) {
    return index === 55 ? 200 : index >= 57 ? 5 : 10;
  });
  const candles5 = makeTimedCandles(60, now, 300, function () { return 0; }, function () { return 10; });
  const candles1h = makeTimedCandles(60, now, 3600, function () { return 0; }, function () { return 10; });
  const candles4h = makeTimedCandles(60, now, 14400, function () { return 0; }, function () { return 10; });
  const model = buildMarketData({
    candles: { "5m": candles5, "15m": candles15, "1h": candles1h, "4h": candles4h },
    ticker: { quality: "OK", last: Number(candles15[candles15.length - 1].c) }, nowSeconds: now
  });
  assert.equal(model.pumpScore, 0);
  assert.notEqual(model.stage.key, "distribution");
  assert.notEqual(model.stage.key, "reversal");
});

test("pumpScore 35 with a closed support break and bearish 1h does not confirm pump reversal", function () {
  const now = 1710000000;
  const candles15 = makeTimedCandles(60, now, 900, function () { return 0.05; },
    function (index) { return index === 59 ? 100 : 10; });
  candles15[59] = Object.assign({}, candles15[59], {
    o: "110", h: "110.5", l: "100", c: "101", v: "100"
  });
  const candles5 = makeTimedCandles(60, now, 300, function () { return 0; }, function () { return 10; });
  const candles1h = makeTimedCandles(60, now, 3600, function () { return -0.05; }, function () { return 10; });
  const candles4h = makeTimedCandles(60, now, 14400, function () { return -0.05; }, function () { return 10; });
  const model = buildMarketData({
    candles: { "5m": candles5, "15m": candles15, "1h": candles1h, "4h": candles4h },
    ticker: { quality: "OK", last: 101 }, nowSeconds: now
  });
  assert.equal(model.pumpScore, 35);
  assert.equal(model.strategy.flags.bearish1h, true);
  assert.notEqual(model.stage.key, "reversal");
});

test("incomplete interval quality cannot confirm distribution or reversal", function () {
  const now = 1710000000;
  const candles15 = makeTimedCandles(60, now, 900, function (index) {
    if (index === 55) return 12;
    if (index >= 56 && index <= 58) return -2;
    if (index === 59) return 3;
    return 0.05;
  }, function (index) {
    if (index === 55) return 200;
    if (index === 57 || index === 58) return 5;
    if (index === 59) return 100;
    return 10;
  });
  const candles5 = makeTimedCandles(60, now, 300,
    function (index) { return index === 59 ? 3 : 0.01; }, function () { return 10; });
  const candles1h = makeTimedCandles(60, now, 3600, function () { return 0.05; }, function () { return 10; });
  candles1h.splice(30, 1);
  const candles4h = makeTimedCandles(60, now, 14400, function () { return 0.05; }, function () { return 10; });
  const model = buildMarketData({
    candles: { "5m": candles5, "15m": candles15, "1h": candles1h, "4h": candles4h },
    ticker: { quality: "OK", last: 120 }, nowSeconds: now
  });
  assert.ok(model.pumpScore >= 45);
  assert.equal(model.data.qualities["1h"], "INCOMPLETE");
  assert.notEqual(model.stage.key, "distribution");
  assert.notEqual(model.stage.key, "reversal");
  assert.match(model.stage.missing.join(" "), /якість свічок 1h/);

  const missingIntervalModel = buildMarketData({
    candles: { "5m": candles5, "15m": candles15, "1h": [], "4h": candles4h },
    ticker: { quality: "OK", last: 120 }, nowSeconds: now
  });
  assert.ok(missingIntervalModel.pumpScore >= 45);
  assert.equal(missingIntervalModel.data.qualities["1h"], "NO DATA");
  assert.notEqual(missingIntervalModel.stage.key, "distribution");
  assert.notEqual(missingIntervalModel.stage.key, "reversal");
  assert.match(missingIntervalModel.stage.missing.join(" "), /якість свічок 1h/);
});

test("lower highs and fading volume from independent groups indicate possible distribution", function () {
  const now = 1710000000;
  const candles15 = makeTimedCandles(60, now, 900, function (index) {
    if (index === 55) return 12;
    if (index >= 56 && index <= 58) return -2;
    if (index === 59) return 3;
    return 0.05;
  }, function (index) {
    if (index === 55) return 200;
    if (index === 57 || index === 58) return 5;
    if (index === 59) return 100;
    return 10;
  });
  const candles5 = makeTimedCandles(60, now, 300,
    function (index) { return index === 59 ? 3 : 0.01; }, function () { return 10; });
  const candles1h = makeTimedCandles(60, now, 3600, function () { return 0.05; }, function () { return 10; });
  const candles4h = makeTimedCandles(60, now, 14400, function () { return 0.05; }, function () { return 10; });
  const model = buildMarketData({
    candles: { "5m": candles5, "15m": candles15, "1h": candles1h, "4h": candles4h },
    ticker: { quality: "OK", last: 120 }, nowSeconds: now
  });
  assert.ok(model.pumpScore >= 45);
  assert.equal(model.stage.key, "distribution");
  assert.match(model.stage.supportingShort.join(" "), /максимуми/);
  assert.match(model.stage.supportingShort.join(" "), /обсяг/);
  assert.equal(model.strategy.allowed, false);
});

test("closed support break with bearish hourly structure confirms reversal stage, not entry by itself", function () {
  const now = 1710000000;
  const candles15 = makeTimedCandles(60, now, 900, function () { return 0.05; },
    function (index) { return index === 59 ? 100 : 10; });
  candles15[59] = Object.assign({}, candles15[59], {
    o: "110", h: "110.5", l: "100", c: "101", v: "100"
  });
  const candles5 = makeTimedCandles(60, now, 300, function () { return 0.05; }, function () { return 10; });
  const previous5mClose = Number(candles5[58].c);
  candles5[59] = Object.assign({}, candles5[59], {
    o: String(previous5mClose), h: String(previous5mClose * 1.018),
    l: String(previous5mClose * 0.996), c: String(previous5mClose * 1.012)
  });
  const candles1h = makeTimedCandles(60, now, 3600, function () { return -0.05; }, function () { return 10; });
  const candles4h = makeTimedCandles(60, now, 14400, function () { return 0.05; }, function () { return 10; });
  const previous4hClose = Number(candles4h[58].c);
  candles4h[59] = Object.assign({}, candles4h[59], {
    o: String(previous4hClose), h: String(previous4hClose * 1.125),
    l: String(previous4hClose * 0.996), c: String(previous4hClose * 1.12)
  });
  const model = buildMarketData({
    candles: { "5m": candles5, "15m": candles15, "1h": candles1h, "4h": candles4h },
    ticker: { quality: "OK", last: 101 }, nowSeconds: now
  });
  assert.ok(model.pumpScore >= 45);
  assert.equal(model.stage.key, "reversal");
  assert.ok(model.stage.supportingShort.some(function (reason) { return reason.includes("нижче мінімумів"); }));
  assert.notEqual(model.state.key, "entry");
  assert.equal(model.strategy.allowed, false);
});

test("insufficient candle history produces an unavailable stage instead of a directional assessment", function () {
  const model = buildMarketData({
    candles: { "5m": [], "15m": [], "1h": [], "4h": [] },
    ticker: { quality: "NO DATA" }, nowSeconds: 1710000000
  });
  assert.equal(model.stage.key, "insufficient");
  assert.equal(model.stage.continuationRisk, "неможливо оцінити");
  assert.ok(model.stage.missing.length > 0);
  assert.match(model.stage.volumeEvidence, /RVOL недоступний/);
});

test("lifecycle states distinguish calm, pump, overheating, exhaustion, setup, entry and unavailable data", function () {
  assert.deepEqual(signalState(0, 0, false, false, false, false), {
    key: "incomplete", label: "Дані недоступні", score: 0
  });
  assert.equal(signalState(0, 0, false, false, true, false).label, "Спокійний ринок");
  assert.equal(signalState(25, 0, false, false, true, false).key, "watch");
  assert.equal(signalState(45, 0, false, false, true, false).label, "Памп формується");
  assert.equal(signalState(65, 0, false, false, true, false).label, "Перегрів");
  assert.equal(signalState(55, 45, false, false, true, false).label, "Виснаження · очікування пробою");
  assert.equal(signalState(45, 55, true, false, true, true).key, "setup");
  assert.equal(signalState(45, 60, true, true, true, true).label, "SHORT підтверджено");
});

test("watchlist ordering prioritizes confirmed SHORT proximity, then signal scores, stably", function () {
  const pairs = ["calm", "pump-low", "pump-high", "setup", "missing"];
  const models = {
    calm: { state: { key: "none" }, shortScore: 0, exhaustionScore: 0, pumpScore: 0 },
    "pump-low": { state: { key: "pump" }, shortScore: 5, exhaustionScore: 10, pumpScore: 50 },
    "pump-high": { state: { key: "pump" }, shortScore: 10, exhaustionScore: 20, pumpScore: 60 },
    setup: { state: { key: "setup" }, shortScore: 70, exhaustionScore: 60, pumpScore: 70 }
  };
  assert.deepEqual(sortPairsBySignal(pairs, models), ["setup", "pump-high", "pump-low", "calm", "missing"]);
});

test("a support break with a distant stop is blocked even when the older setup conditions pass", function () {
  const now = 1710000000;
  const rows = [];
  const statsRows = [];
  for (let i = 0; i <= 60; i += 1) {
    statsRows.push({
      time: now - (60 - i) * 300,
      openInterest: 120 + i * 0.5,
      openInterestUsd: (120 + i * 0.5) * 1000,
      lsrAccount: 1 + i / 40,
      lsrTaker: 1.2,
      longLiquidationUsd: 1000,
      shortLiquidationUsd: 10
    });
  }
  let close = 100;
  for (let i = 0; i < 60; i += 1) {
    const open = close;
    if (i < 45) close *= 1.01;
    else if (i === 55) close *= 1.08;
    else if (i === 58) close *= 1.005;
    let high = Math.max(open, close) * 1.004;
    let low = Math.min(open, close) * 0.996;
    if (i === 57) {
      high = close * 1.25;
      close = open * 0.998;
      low = open * 0.995;
    }
    if (i === 59) close = Number(rows[58].c) * 0.97;
    rows.push({
      t: now - 900 * (60 - i), o: String(open),
      h: String(Math.max(open, close, high)), l: String(Math.min(open, close, low)),
      c: String(close), v: String(i === 59 ? 10000 : 10)
    });
  }
  function steady(interval, count, rise) {
    const candles = [];
    let price = 100;
    for (let i = 0; i < count; i += 1) {
      const open = price;
      price *= 1 + rise;
      candles.push({
        t: now - interval * (count - i), o: String(open),
        h: String(Math.max(open, price) * 1.004), l: String(Math.min(open, price) * 0.996), c: String(price), v: "10"
      });
    }
    return candles;
  }
  const model = buildMarketData({
    candles: { "5m": steady(300, 50, 0.01), "15m": rows, "1h": steady(3600, 50, -0.005), "4h": steady(14400, 50, -0.005) },
    ticker: { quality: "OK", last: Number(rows[59].c), volume24h: 10000000, funding: 0.0005, fetchedAt: now * 1000 },
    stats: { rows: statsRows, quality: "OK" },
    orderBook: { quality: "OK", spreadPercent: 0.1, slippagePercent: 0.05, depthUsd: 50000,
      fetchedAt: now * 1000, generatedAt: now },
    fundingIntervalSeconds: 28800,
    nowSeconds: now
  });
  assert.notEqual(model.state.key, "entry");
  assert.match(model.strategy.blockers.join(" "), /Stop надто далекий/);
  assert.equal(model.levels, null);
  assert.equal(model.strategy.allowed, false);
  const rejected = calculateLevels(model.data.candles15);
  assert.ok(rejected.stop > rejected.entry);
  assert.ok(rejected.tp1 < rejected.entry);
});

test("same-candle refresh rechecks blockers immediately and invalidation cancels a setup", function () {
  const current = {
    state: { key: "pump", label: "PUMP ACTIVE" },
    data: { candles15: [{ time: 10, close: 100 }] },
    levels: null,
    shortScore: 0
  };
  const old = { state: { key: "entry", label: "SHORT ENTRY" }, candleTime: 10, levels: { stop: 110 } };
  const same = transitionSignal(current, old, 10);
  assert.equal(same.state.key, "pump");
  assert.equal(same.unchangedCandle, true);
  const unavailable = Object.assign({}, old, { state: { key: "incomplete", label: "Дані недоступні" } });
  const recovered = transitionSignal(current, unavailable, 10);
  assert.equal(recovered.state.key, "pump");
  assert.equal(recovered.unchangedCandle, true);
  const next = Object.assign({}, current, { data: { candles15: [{ time: 20, close: 111 }] } });
  assert.equal(transitionSignal(next, old, 10).state.key, "cancelled");
});

test("Price × OI scenario transitions are surfaced across refreshes", function () {
  const current = {
    state: { key: "watch" },
    data: { candles15: [{ time: 20, close: 100 }] },
    strategy: { matrix: {
      "15m": { key: "down_up", label: "PRICE ↓ · OI ↑" },
      "1h": { key: "down_up", label: "PRICE ↓ · OI ↑" },
      "4h": { key: "down_down", label: "PRICE ↓ · OI ↓" }
    } }
  };
  const previous = {
    state: { key: "watch" },
    strategy: { matrix: {
      "15m": { key: "down_down", label: "PRICE ↓ · OI ↓" },
      "1h": { key: "down_up", label: "PRICE ↓ · OI ↑" },
      "4h": { key: "down_down", label: "PRICE ↓ · OI ↓" }
    } }
  };
  const result = transitionSignal(current, previous, 10);
  assert.equal(result.strategy.matrixTransitions["15m"], "PRICE ↓ · OI ↓ → PRICE ↓ · OI ↑");
  assert.equal(result.strategy.matrixTransitions["1h"], null);
});

test("pair list validates duplicates and add/remove behavior", function () {
  const allowed = ["BTC_USDT", "ETH_USDT"];
  assert.deepEqual(validatePairList(["btc_usdt", "BTC_USDT", "BAD_USDT", "ETH_USDT"], allowed), ["BTC_USDT", "ETH_USDT"]);
  const added = addPair(["BTC_USDT"], "eth_usdt", allowed);
  assert.deepEqual(added.list, ["BTC_USDT", "ETH_USDT"]);
  assert.equal(addPair(added.list, "NOPE_USDT", allowed).error !== null, true);
  assert.deepEqual(removePair(added.list, "BTC_USDT"), ["ETH_USDT"]);
});

test("malformed scalar types never become measured candle prices or volumes", function () {
  [true, false, [], {}, " ", "NaN", "Infinity"].forEach(function (value) {
    const rows = [{ t: 1710000000, o: value, h: "2", l: "1", c: "1", v: "10" }];
    assert.equal(normalizeCandles(rows, "15m", 1710000900).quality, "SUSPECT");
  });
});

test("candles become stale as soon as an expected completed interval is absent", function () {
  const rows = [{ t: 1710000000, o: "1", h: "2", l: "1", c: "1", v: "10" }];
  assert.equal(normalizeCandles(rows, "15m", 1710001799).quality, "OK");
  assert.equal(normalizeCandles(rows, "15m", 1710001800).quality, "STALE");
});

test("OI refuses unequal endpoint offsets and cannot borrow past a missing latest field", function () {
  const unequal = { quality: "OK", rows: [
    { time: 600, openInterest: 100 }, { time: 1202, openInterest: 120 }
  ] };
  assert.equal(calculateContractMetrics(unequal, { "15m": 1500 }).oiChanges["15m"], null);
  const missing = { quality: "OK", rows: [
    { time: 600, openInterest: 100 }, { time: 1400, openInterest: 120 },
    { time: 1500, openInterest: null }
  ] };
  assert.equal(calculateContractMetrics(missing, { "15m": 1500 }).oiChanges["15m"], null);
});

test("Q_USDT funding is normalized once with source, units, interval and receipt timestamp", function () {
  [14400, 28800].forEach(function (interval) {
    const model = buildMarketData({
      candles: {}, stats: { rows: [], quality: "NO DATA" },
      ticker: { funding: -0.000794, fetchedAt: 1710000000000 },
      fundingIntervalSeconds: interval, nowSeconds: 1710000000
    });
    assert.equal(model.data.fundingNormalized, -0.000794 * 28800 / interval);
    assert.equal(model.data.funding.normalized, model.data.fundingNormalized);
    assert.equal(model.data.funding.raw, -0.000794);
    assert.equal(model.data.funding.intervalSeconds, interval);
    assert.equal(model.data.funding.fetchedAt, 1710000000000);
    assert.equal(model.data.funding.unit, "decimal");
  });
});

test("targets are distinct confirmed supports, never invented ATR extensions", function () {
  const candles = levelCandles();
  let levels = calculateLevels(candles, { startIndex: 26 });
  assert.deepEqual([levels.tp1, levels.tp2, levels.tp3], [0.115456, 0.11, 0.10]);
  candles[12].low = 0.124;
  candles[14].low = 0.124;
  levels = calculateLevels(candles, { startIndex: 26 });
  assert.equal(levels.valid, false);
  assert.equal(levels.tp2, null);
  assert.match(levels.reason, /трьох/);
});

test("cancellation revokes confirmed entry consistently across model and strategy", function () {
  const prior = { state: { key: "entry" }, levels: { stop: 110 } };
  const current = {
    state: { key: "entry" }, confirmed: true,
    data: { candles15: [{ time: 1710000000, close: 111 }] },
    strategy: { status: "SHORT ENTRY", allowed: true, blockers: [] }
  };
  const result = transitionSignal(current, prior, 0);
  assert.equal(result.state.key, "cancelled");
  assert.equal(result.confirmed, false);
  assert.equal(result.strategy.status, "NO TRADE");
  assert.equal(result.strategy.allowed, false);
});

test("complete closed-candle and stats pipeline permits entry only after every mandatory gate passes", function () {
  const now = 1710000000;
  const raw = function (seconds, count, declining) {
    return Array.from({ length: count }, function (_, index) {
      const close = declining ? 102 - index * 0.1 : 100;
      return { t: now - (count - index) * seconds, o: String(close + (declining ? 0.1 : 0)),
        h: String(close + 0.2), l: String(close - 0.2), c: String(close), v: "100" };
    });
  };
  const main = raw(900, 80, false);
  main[65].l = "91.3";
  main[68].l = "88.3";
  main[71].l = "85.3";
  Object.assign(main[79], { o: "100", h: "100.2", l: "97.1", c: "97.3", v: "300" });
  const input = {
    candles: { "5m": raw(300, 80, false), "15m": main, "1h": raw(3600, 20, true), "4h": raw(14400, 20, true) },
    stats: normalizeContractStats(Array.from({ length: 100 }, function (_, index) {
      return { time: now - (99 - index) * 300, open_interest: String(1000 + index),
        lsr_account: "1.5", long_liq_usd: "0", short_liq_usd: "0" };
    }), now),
    ticker: { quality: "OK", last: 97.3, funding: 0.0005, volume24h: 10000000, fetchedAt: now * 1000 },
    orderBook: { quality: "OK", depthUsd: 50000, spreadPercent: 0.1, slippagePercent: 0.05,
      fetchedAt: now * 1000, generatedAt: now },
    fundingIntervalSeconds: 28800, nowSeconds: now, minimumRiskReward: 1.5, takerFeeRate: 0.0005
  };
  const model = buildMarketData(input);
  assert.deepEqual(model.strategy.missing, []);
  assert.deepEqual(model.strategy.blockers, []);
  assert.equal(model.strategy.allowed, true);
  assert.equal(model.confirmed, true);
  assert.equal(model.state.key, "entry");
  assert.equal(model.pumpScore, 23);
  assert.equal(model.exhaustionScore, 0);
  assert.equal(model.shortScore, 81);
  assert.equal(model.strategy.status, "SHORT ENTRY");
  assert.deepEqual(
    [model.levels.entry, model.levels.stop, model.levels.tp1, model.levels.tp2, model.levels.tp3],
    [97.3, 100.69, 91.3, 88.3, 85.3]
  );
  assert.ok(model.strategy.netRiskReward >= 1.5);
  input.orderBook.depthUsd = 9999;
  const blocked = buildMarketData(input);
  assert.equal(blocked.strategy.setupConfirmed, true);
  assert.equal(blocked.strategy.allowed, false);
  assert.notEqual(blocked.state.key, "entry");
});
