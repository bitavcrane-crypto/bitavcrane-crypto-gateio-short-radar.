import test from "node:test";
import assert from "node:assert/strict";
import {
  addPair, buildMarketData, calculateContractMetrics, normalizeCandles, removePair,
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

test("contract stats prefer Gate's explicit USDT liquidation aggregates", function () {
  const normalized = normalizeContractStats([{
    time: 1710000000,
    open_interest: "10",
    long_liq_usd: "10",
    long_liq_usd_new: "25",
    short_liq_usd: "5",
    short_liq_usd_new: "0"
  }], 1710000000);
  assert.equal(normalized.rows[0].longLiquidationUsd, 25);
  assert.equal(normalized.rows[0].shortLiquidationUsd, 0);
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

test("a support break with poor risk/reward is blocked even when the older setup conditions pass", function () {
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
    ticker: { quality: "OK", last: Number(rows[59].c), volume24h: 10000000, funding: 0.0005 },
    stats: { rows: statsRows, quality: "OK" },
    orderBook: { quality: "OK", spreadPercent: 0.1, depthUsd: 50000 },
    fundingIntervalSeconds: 28800,
    nowSeconds: now
  });
  assert.notEqual(model.state.key, "entry");
  assert.match(model.strategy.blockers.join(" "), /Reward\/Risk/);
  assert.ok(model.levels.stop > model.levels.entry);
  assert.ok(model.levels.tp1 < model.levels.entry);
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
