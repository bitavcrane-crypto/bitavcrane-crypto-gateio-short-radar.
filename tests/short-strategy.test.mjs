import test from "node:test";
import assert from "node:assert/strict";
import { classifyPriceOi, detectShortSetup, evaluateShortStrategy } from "../short-strategy.mjs";
import { evaluateShortConfirmation } from "../indicator-confirmation.mjs";

function candle(open, high, low, close, volume) {
  return { open: open, high: high, low: low, close: close, volume: volume === undefined ? 100 : volume };
}

function timestampCandles(candles, seconds, now = 1700000000) {
  return candles.map(function (item, index) {
    return Object.assign(item, { time: now - (candles.length - index) * seconds });
  });
}

function validInput() {
  const candles15 = Array.from({ length: 20 }, function (_, index) {
    return candle(100, 100.2, 99.8, 100, 100);
  });
  candles15[candles15.length - 1] = candle(100, 100.2, 97.1, 97.3, 300);
  return {
    nowSeconds: 1700000000,
    candles: {
      "15m": timestampCandles(candles15, 900),
      "1h": timestampCandles([
        candle(100, 101, 99, 100), candle(100, 100.5, 98, 99),
        candle(99, 99.5, 97, 98), candle(98, 98.5, 96, 97)
      ], 3600),
      "4h": timestampCandles([
        candle(104, 105, 103, 104), candle(103, 104, 102, 103),
        candle(102, 103, 101, 102), candle(101, 102, 100, 101)
      ], 14400)
    },
    changes: { "15m": -1, "1h": -2, "4h": -1 },
    oiChanges: { "15m": 1, "1h": 1.2, "4h": 1.5 },
    qualities: { "15m": "OK", "1h": "OK", "4h": "OK" },
    stats: { quality: "OK", time: 1700000000, lsrAccount: 1.5, shortLiquidationUsd: 100, longLiquidationUsd: 100 },
    ticker: { quality: "OK", last: 97.3, volume24h: 10000000, fetchedAt: 1700000000000 },
    orderBook: { quality: "OK", spreadPercent: 0.1, slippagePercent: 0.05, depthUsd: 50000,
      fetchedAt: 1700000000000, generatedAt: 1700000000 },
    volumeRatio: 2,
    indicators: { rsi: 45, macd: { histogram: -1 }, obvDivergence: true },
    fundingNormalized: 0.0005,
    levels: { entry: 97.3, stop: 100.3, tp1: 91.3, tp2: 88.3, tp3: 85.3, atr: 2, valid: true,
      invalidation: 100.2, sourceTime: 1700000000 - 3600 },
    minimumRiskReward: 1.5
  };
}

test("a closed-candle reference cannot remain an entry after price reaches stop or TP1", () => {
  for (const price of [100.3, 101, 91.3, 90]) {
    const input = validInput();
    input.ticker.last = price;
    const result = evaluateShortStrategy(input);
    assert.equal(result.allowed, false);
    assert.equal(result.liveRiskReward, null);
    assert.ok(result.blockers.some(reason => /вже досягла/.test(reason)));
  }
});

test("blocks a late short whose current-price reward/risk no longer meets the minimum", () => {
  const input = validInput();
  input.ticker.last = 92;
  const result = evaluateShortStrategy(input);
  assert.equal(result.riskReward, 2);
  assert.ok(result.liveRiskReward < 1.5);
  assert.equal(result.allowed, false);
  assert.ok(result.blockers.some(reason => /поточна ціна/.test(reason)));
});

test("current-price net risk includes fees and slippage on both sides", () => {
  const input = validInput();
  input.takerFeeRate = 0.0005;
  const result = evaluateShortStrategy(input);
  assert.equal(result.allowed, true);
  assert.ok(result.liveNetRiskReward < result.liveRiskReward);
  assert.equal(result.liveNetRiskReward, result.netRiskReward);
});

test("classifies all four Price × OI combinations and neutral/missing data", function () {
  assert.equal(classifyPriceOi(1, 2).key, "up_up");
  assert.equal(classifyPriceOi(1, -2).key, "up_down");
  assert.equal(classifyPriceOi(-1, 2).key, "down_up");
  assert.equal(classifyPriceOi(-1, -2).key, "down_down");
  assert.equal(classifyPriceOi(0, 0).key, "flat_flat");
  assert.equal(classifyPriceOi(null, 1).key, "unavailable");
  assert.equal(classifyPriceOi(0.2, 0.3).strength, "СЛАБКІ ЗМІНИ");
  assert.equal(classifyPriceOi(-4, 3).strength, "РІЗКІ ЗМІНИ");
});

test("allows only a confirmed bearish support break after every execution gate passes", function () {
  const result = evaluateShortStrategy(validInput());
  assert.equal(result.setup.type, "support_break");
  assert.equal(result.setup.startIndex, 16);
  assert.equal(result.setup.invalidation, 100.2);
  assert.equal(result.setup.confirmed, true);
  assert.equal(result.dataReady, true);
  assert.equal(result.allowed, true);
  assert.equal(result.matrix["4h"].key, "down_up");
  assert.equal(result.score, 100);
  assert.equal(result.status, "SHORT ENTRY");
  assert.equal(result.setupConfirmed, true);
  assert.equal(result.setupStatus, "SETUP CONFIRMED");
  assert.equal(result.liquidity.passed, true);
  assert.deepEqual(result.blockers, []);
});

test("recognizes a failed retest after support breaks and gives it priority", function () {
  const input = validInput();
  const candles = Array.from({ length: 20 }, function () { return candle(100, 100.2, 99.8, 100); });
  candles[16] = candle(100, 100.1, 97, 98);
  candles[17] = candle(98, 98.1, 97.3, 97.5);
  candles[18] = candle(97.5, 98, 97.4, 97.7);
  candles[19] = candle(99.9, 100, 98, 98.5, 300);
  candles[19].time = input.nowSeconds - 900;
  input.candles["15m"] = timestampCandles(candles, 900);
  const setup = detectShortSetup(candles);
  assert.equal(setup.type, "failed_retest");
  assert.equal(setup.startIndex, 19);
  assert.equal(setup.invalidation, 100);
  assert.equal(setup.sourceTime, candles[19].time);
  assert.equal(setup.confirmed, true);
  assert.deepEqual(evaluateShortStrategy(input).setup, setup);
});

test("recognizes a failed local-high breakout only after price returns below its level", function () {
  const input = validInput();
  const candles = Array.from({ length: 20 }, function () { return candle(100, 100.2, 99.8, 100); });
  candles[16] = candle(100, 103, 99, 99.9);
  candles[16].time = input.nowSeconds - 3600;
  candles[19] = candle(100, 100.1, 98.8, 99, 300);
  input.candles["15m"] = timestampCandles(candles, 900);
  const result = evaluateShortStrategy(input);
  assert.equal(result.setup.type, "failed_high_break");
  assert.equal(result.setup.level, 100.2);
  assert.equal(result.setup.startIndex, 16);
  assert.equal(result.setup.invalidation, 103);
  assert.equal(result.setup.sourceTime, candles[16].time);
  assert.equal(result.setupConfirmed, true);
});

test("missing order book data blocks entries and identifies unavailable critical data", function () {
  const input = validInput();
  input.orderBook = { quality: "NO DATA" };
  const result = evaluateShortStrategy(input);
  assert.equal(result.allowed, false);
  assert.equal(result.dataReady, false);
  assert.match(result.blockers.join(" "), /DATA UNAVAILABLE/);
});

test("unknown directional liquidation aggregates cannot be treated as zero squeeze risk", function () {
  const input = validInput();
  input.stats.shortLiquidationUsd = null;
  const result = evaluateShortStrategy(input);
  assert.equal(result.allowed, false);
  assert.equal(result.dataReady, false);
  assert.ok(result.missing.includes("stats.shortLiquidationUsd"));
});

test("blocks strong 4h advances, conflicting timeframes, stretched falls, squeeze risk and poor R/R", function () {
  const bullish = validInput();
  bullish.changes["4h"] = 3;
  assert.equal(evaluateShortStrategy(bullish).allowed, false);
  assert.match(evaluateShortStrategy(bullish).blockers.join(" "), /висхідний тренд/);

  const conflict = validInput();
  conflict.changes["1h"] = 2;
  assert.equal(evaluateShortStrategy(conflict).flags.matrixConflict, true);

  const oiContradiction = validInput();
  oiContradiction.changes["4h"] = 1;
  assert.equal(evaluateShortStrategy(oiContradiction).blockers.some(function (reason) {
    return reason.includes("Price × OI 4h");
  }), true);

  const stretched = validInput();
  stretched.changes["4h"] = -9;
  assert.equal(evaluateShortStrategy(stretched).flags.stretched, true);

  const squeeze = validInput();
  squeeze.stats.shortLiquidationUsd = 1000;
  assert.equal(evaluateShortStrategy(squeeze).flags.shortSqueezeRisk, true);

  const poorReward = validInput();
  poorReward.levels.tp1 = 94.3;
  poorReward.levels.riskReward = 100;
  assert.match(evaluateShortStrategy(poorReward).blockers.join(" "), /Reward\/Risk/);
});

test("requires a failed rebound retest after sharp price and OI liquidation declines", function () {
  const input = validInput();
  input.changes["15m"] = -2.5;
  input.changes["1h"] = -3;
  input.changes["4h"] = -3;
  input.oiChanges = { "15m": -2.5, "1h": -3, "4h": -3 };
  const result = evaluateShortStrategy(input);
  assert.equal(result.flags.liquidationFlush, true);
  assert.equal(result.allowed, false);
  assert.match(result.blockers.join(" "), /невдалого ретесту/);
});

test("a high score cannot bypass volume, bearish structure, spread or depth blockers", function () {
  const noVolume = validInput();
  noVolume.volumeRatio = 1.1;
  assert.equal(evaluateShortStrategy(noVolume).allowed, false);

  const noBearishHour = validInput();
  noBearishHour.candles["1h"] = Array.from({ length: 4 }, function (_, index) {
    return candle(100 + index, 101 + index, 99 + index, 100 + index);
  });
  assert.equal(evaluateShortStrategy(noBearishHour).allowed, false);

  const wideSpread = validInput();
  wideSpread.orderBook.spreadPercent = 0.4;
  assert.equal(evaluateShortStrategy(wideSpread).allowed, false);

  const shallowBook = validInput();
  shallowBook.orderBook.depthUsd = 9000;
  assert.equal(evaluateShortStrategy(shallowBook).allowed, false);

  const slippage = validInput();
  slippage.orderBook.slippagePercent = 0.2;
  assert.equal(evaluateShortStrategy(slippage).allowed, false);

  const lowVolumeContract = validInput();
  lowVolumeContract.ticker.volume24h = 500000;
  assert.equal(evaluateShortStrategy(lowVolumeContract).allowed, false);
});

test("a single rejection wick without a confirmed breakdown does not create a SHORT setup", function () {
  const input = validInput();
  input.candles["15m"][19] = candle(100, 101, 99.8, 100.2, 300);
  const result = evaluateShortStrategy(input);
  assert.equal(result.allowed, false);
  assert.equal(result.setup, null);
});

test("all required missing fields share one canonical DATA UNAVAILABLE blocker", function () {
  const input = validInput();
  delete input.changes["4h"];
  input.oiChanges["4h"] = null;
  input.stats.longLiquidationUsd = null;
  delete input.fundingNormalized;
  delete input.stats.lsrAccount;
  const result = evaluateShortStrategy(input);
  assert.equal(result.allowed, false);
  assert.equal(result.dataReady, false);
  assert.equal(result.missingData, true);
  assert.equal(result.status, "DATA UNAVAILABLE");
  ["changes.4h", "oiChanges.4h", "stats.longLiquidationUsd", "fundingNormalized", "stats.lsrAccount"]
    .forEach(function (field) {
      assert.ok(result.missing.includes(field), field);
      assert.ok(result.missingScoreData.includes(field), field);
    });
  assert.equal(result.blockers.filter(function (reason) { return reason.includes("DATA UNAVAILABLE"); }).length, 1);
  assert.ok(result.blockers.includes("NO TRADE — DATA UNAVAILABLE"));
  assert.equal(new Set(result.blockers).size, result.blockers.length);
});

test("each required market numeric field rejects absent, non-finite and invalid negative values", function () {
  const fields = [
    ["orderBook", "depthUsd"], ["orderBook", "spreadPercent"], ["orderBook", "slippagePercent"],
    ["ticker", "volume24h"], ["ticker", "last"], ["stats", "lsrAccount"],
    ["stats", "shortLiquidationUsd"], ["stats", "longLiquidationUsd"]
  ];
  fields.forEach(function (path) {
    [undefined, null, NaN, Infinity, -Infinity, -1].forEach(function (value) {
      const input = validInput();
      input[path[0]][path[1]] = value;
      const result = evaluateShortStrategy(input);
      assert.equal(result.allowed, false, path.join(".") + "=" + value);
      assert.equal(result.dataReady, false, path.join(".") + "=" + value);
      assert.ok(result.missing.includes(path.join(".")));
    });
  });
  ["volumeRatio", "fundingNormalized"].forEach(function (field) {
    [undefined, null, NaN, Infinity, -Infinity].forEach(function (value) {
      const input = validInput();
      input[field] = value;
      assert.ok(evaluateShortStrategy(input).missing.includes(field));
    });
  });
  const zeroPrice = validInput();
  zeroPrice.ticker.last = 0;
  assert.ok(evaluateShortStrategy(zeroPrice).missing.includes("ticker.last"));
  const negativeRatio = validInput();
  negativeRatio.volumeRatio = -1;
  assert.ok(evaluateShortStrategy(negativeRatio).missing.includes("volumeRatio"));
});

test("valid liquidity threshold failures retain data readiness and show actual values with units", function () {
  [
    ["orderBook", "depthUsd", 9999, /9999.*10000 USD/],
    ["orderBook", "spreadPercent", 0.21, /0.21.*0.2%/],
    ["orderBook", "slippagePercent", 0.16, /0.16.*0.15%/],
    ["ticker", "volume24h", 999999, /999999.*1000000 USD\/24h/]
  ].forEach(function (row) {
    const input = validInput();
    input[row[0]][row[1]] = row[2];
    const result = evaluateShortStrategy(input);
    assert.equal(result.dataReady, true);
    assert.equal(result.allowed, false);
    assert.equal(result.status, "NO TRADE");
    assert.equal(result.setupConfirmed, true);
    assert.equal(result.liquidity.passed, false);
    assert.match(result.liquidity.reasons.join(" "), row[3]);
    assert.match(result.blockers.join(" "), row[3]);
    assert.equal(result.scoreReasons.some(function (reason) {
      return reason.includes("ліквідність і спред придатні");
    }), false);
  });
});

test("zero spread and slippage and exact liquidity thresholds are valid", function () {
  const input = validInput();
  input.orderBook.spreadPercent = 0;
  input.orderBook.slippagePercent = 0;
  input.orderBook.depthUsd = 10000;
  input.ticker.volume24h = 1000000;
  input.stats.shortLiquidationUsd = 0;
  input.stats.longLiquidationUsd = 0;
  assert.equal(evaluateShortStrategy(input).allowed, true);
});

test("stale, future, missing timestamps and non-OK source quality cannot permit entry", function () {
  [["orderBook", 31], ["ticker", 121], ["orderBook", -6], ["ticker", -6]].forEach(function (row) {
    const input = validInput();
    input[row[0]].fetchedAt -= row[1] * 1000;
    assert.ok(evaluateShortStrategy(input).missing.includes(row[0] + ".fetchedAt"));
  });
  ["orderBook", "ticker"].forEach(function (field) {
    const input = validInput();
    delete input[field].fetchedAt;
    assert.equal(evaluateShortStrategy(input).allowed, false);
    input[field].fetchedAt = input.nowSeconds;
    assert.equal(evaluateShortStrategy(input).allowed, true);
  });
  ["orderBook", "ticker", "stats"].forEach(function (field) {
    const input = validInput();
    input[field].quality = "STALE";
    assert.ok(evaluateShortStrategy(input).missing.includes(field + ".quality"));
  });
  const input = validInput();
  delete input.nowSeconds;
  assert.ok(evaluateShortStrategy(input).missing.includes("nowSeconds"));
});

test("detection is not confirmation without actual selling, volume and bearish 1h structure", function () {
  const input = validInput();
  input.volumeRatio = 1.1;
  const result = evaluateShortStrategy(input);
  assert.equal(result.setup.type, "support_break");
  assert.equal(result.setupStatus, "SETUP DETECTED");
  assert.equal(result.setupConfirmed, false);
  assert.equal(result.status, "NO TRADE");
  input.volumeRatio = 2;
  input.candles["1h"] = Array.from({ length: 4 }, function () { return candle(100, 101, 99, 100); });
  assert.equal(evaluateShortStrategy(input).setupConfirmed, false);
});

test("failed high break rejects a continuation that remains above swept resistance", function () {
  const input = validInput();
  input.candles["15m"][16] = candle(100, 103, 99.8, 102.5);
  input.candles["15m"][19] = candle(102.7, 102.9, 101.8, 102.2, 300);
  const result = evaluateShortStrategy(input);
  assert.notEqual(result.setup && result.setup.type, "failed_high_break");
  assert.equal(result.allowed, false);
});

test("Price × OI conflicts include 15m and report each interval with its values", function () {
  const input = validInput();
  input.changes["15m"] = 1;
  const result = evaluateShortStrategy(input);
  assert.equal(result.flags.matrixConflict, true);
  assert.equal(result.allowed, false);
  const reason = result.blockers.find(function (item) { return item.includes("конфлікт"); });
  assert.match(reason, /15m: price=1%, OI=1%/);
  assert.match(reason, /1h: price=-2%, OI=1.2%/);
  assert.match(reason, /4h: price=-1%, OI=1.5%/);
});

test("funding squeeze uses normalized decimals and AND L/S, independently of latest 5m liquidation rule", function () {
  const input = validInput();
  input.fundingNormalized = -0.000846;
  input.stats.lsrAccount = 0.713;
  assert.equal(evaluateShortStrategy(input).flags.shortSqueezeRisk, false);
  input.fundingNormalized = -0.001;
  let result = evaluateShortStrategy(input);
  assert.equal(result.flags.shortSqueezeRisk, true);
  assert.equal(result.squeezeReasons.length, 1);
  assert.match(result.squeezeReasons[0], /-0.1%\/8h.*AND L\/S account=0.713 < 0.8/);
  assert.equal(result.allowed, false);
  input.stats.lsrAccount = 0.8;
  assert.equal(evaluateShortStrategy(input).flags.shortSqueezeRisk, false);
  input.stats.shortLiquidationUsd = 301;
  result = evaluateShortStrategy(input);
  assert.equal(result.squeezeReasons.length, 1);
  assert.match(result.squeezeReasons[0], /latest 5m: SHORT=301 USD > 3 × LONG=100 USD/);
  input.stats.lsrAccount = 0.713;
  assert.equal(evaluateShortStrategy(input).squeezeReasons.length, 2);
  input.fundingNormalized = -0.000846 * 2;
  assert.equal(evaluateShortStrategy(input).squeezeReasons.length, 2);
  input.stats.shortLiquidationUsd = 300;
  input.stats.lsrAccount = 1;
  assert.equal(evaluateShortStrategy(input).flags.shortSqueezeRisk, false);
});

test("all five numeric short levels are required; caller-provided R/R cannot bypass real reward", function () {
  ["entry", "stop", "tp1", "tp2", "tp3"].forEach(function (field) {
    [undefined, null, NaN, Infinity, 0, -1].forEach(function (value) {
      const input = validInput();
      input.levels[field] = value;
      input.levels.riskReward = 100;
      const result = evaluateShortStrategy(input);
      assert.equal(result.allowed, false, field + "=" + value);
      assert.equal(result.riskReward, null);
      assert.equal(result.dataReady, true);
      assert.equal(result.status, "NO TRADE");
      assert.match(result.blockers.join(" "), /некоректний stop/);
    });
  });
  const input = validInput();
  input.levels.riskReward = 0;
  assert.equal(evaluateShortStrategy(input).riskReward, 2);
  assert.equal(evaluateShortStrategy(input).allowed, true);
  input.levels.tp1 = 96;
  input.levels.riskReward = 100;
  assert.equal(evaluateShortStrategy(input).allowed, false);
  const absent = validInput();
  delete absent.levels;
  assert.equal(evaluateShortStrategy(absent).allowed, false);
});

test("wrong target ordering, invalid stops, invalidation flag and stops beyond 3 ATR block high scores", function () {
  [
    { stop: 97.3 },
    { stop: 96 },
    { tp1: 98 },
    { tp2: 92 },
    { tp3: 89 },
    { stop: 104, tp1: 80, tp2: 70, tp3: 60 },
    { valid: false, reason: "local invalidation is stale" }
  ].forEach(function (patch) {
    const input = validInput();
    Object.assign(input.levels, patch, { riskReward: 100 });
    const result = evaluateShortStrategy(input);
    assert.equal(result.dataReady, true);
    assert.equal(result.setupConfirmed, true);
    assert.equal(result.score, 100);
    assert.equal(result.allowed, false);
    assert.equal(result.riskReward, null);
    assert.match(result.blockers.join(" "), /stop|invalidation/);
  });
});

test("supplied invalidation metadata must identify a recent local high below the stop", function () {
  const input = validInput();
  input.candles["15m"].forEach(function (item, index) {
    item.time = input.nowSeconds - (20 - index) * 900;
  });
  input.levels.invalidation = 100.2;
  input.levels.sourceTime = input.candles["15m"][16].time;
  assert.equal(evaluateShortStrategy(input).allowed, true);
  input.levels.sourceTime = input.candles["15m"][0].time;
  assert.equal(evaluateShortStrategy(input).allowed, false);
  input.levels.sourceTime = input.candles["15m"][16].time;
  input.levels.invalidation = 99;
  assert.match(evaluateShortStrategy(input).blockers.join(" "), /invalidation/);
  input.levels.invalidation = 101;
  assert.equal(evaluateShortStrategy(input).allowed, false);
  input.levels.sourceTime = NaN;
  assert.equal(evaluateShortStrategy(input).dataReady, true);
  assert.match(evaluateShortStrategy(input).blockers.join(" "), /invalidation/);
});

test("invalid level calculation retains its explicit reason even when target fields are absent", function () {
  const input = validInput();
  input.levels.valid = false;
  input.levels.reason = "Stop too far from recent invalidation";
  input.levels.tp2 = null;
  input.levels.tp3 = null;
  const result = evaluateShortStrategy(input);
  assert.equal(result.allowed, false);
  assert.match(result.blockers.join(" "), /Stop too far from recent invalidation/);
  assert.equal(result.status, "NO TRADE");
  assert.deepEqual(result.missing, []);
  assert.equal(result.blockers.filter(function (reason) { return reason.includes("DATA UNAVAILABLE"); }).length, 0);
});

test("optional score inputs are distinguished from the canonical execution missing fields", function () {
  const input = validInput();
  delete input.indicators;
  const result = evaluateShortStrategy(input);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.missingData, false);
  assert.deepEqual(result.missingScoreData, ["indicators.rsi", "indicators.macd.histogram", "indicators.obvDivergence"]);
});

test("missing or malformed candle arrays cannot be marked structurally confirmed", function () {
  ["15m", "1h", "4h"].forEach(function (interval) {
    const input = validInput();
    input.candles[interval] = null;
    const result = evaluateShortStrategy(input);
    assert.equal(result.allowed, false);
    assert.ok(result.missing.includes("candles." + interval));
    assert.equal(result.setupConfirmed, false);
  });
  const input = validInput();
  input.candles["15m"][19].high = NaN;
  assert.equal(evaluateShortStrategy(input).setupConfirmed, false);
});

test("shared detector returns recent absolute formation indices and only structural confirmation", function () {
  const input = validInput();
  input.candles["15m"].forEach(function (item, index) {
    item.time = input.nowSeconds - (20 - index) * 900;
  });
  let setup = detectShortSetup(input.candles["15m"]);
  assert.equal(setup.startIndex, 16);
  assert.equal(setup.invalidation, 100.2);
  assert.equal(setup.sourceTime, input.candles["15m"][16].time);
  assert.equal(setup.confirmed, true);
  input.candles["15m"][19].low = 90;
  setup = detectShortSetup(input.candles["15m"]);
  assert.equal(setup.type, "support_break");
  assert.equal(setup.confirmed, false);
  assert.equal(evaluateShortStrategy(input).setupConfirmed, false);
  assert.equal(evaluateShortStrategy(input).setupStatus, "SETUP DETECTED");
});

test("shared detector tolerates absent, empty and malformed candles", function () {
  [undefined, null, [], {}, [null], [candle(100, NaN, 99, 100)]].forEach(function (candles) {
    assert.equal(detectShortSetup(candles), null);
  });
});

test("normal market without generated levels does not imply missing market data", function () {
  const input = validInput();
  input.candles["15m"][19] = candle(100, 100.2, 99.8, 100, 300);
  timestampCandles(input.candles["15m"], 900);
  input.levels = null;
  const result = evaluateShortStrategy(input);
  assert.equal(result.setup, null);
  assert.equal(result.dataReady, true);
  assert.equal(result.status, "NO TRADE");
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.blockers, []);
});

test("missing 4h Price × OI or quality keeps a detected setup unconfirmed", function () {
  ["changes", "oiChanges", "qualities"].forEach(function (field) {
    const input = validInput();
    delete input[field]["4h"];
    const result = evaluateShortStrategy(input);
    assert.equal(result.setup.type, "support_break");
    assert.equal(result.setupConfirmed, false);
    assert.equal(result.setupStatus, "SETUP DETECTED");
    assert.equal(result.status, "DATA UNAVAILABLE");
  });
});

test("recalculated R/R remains finite or unavailable for extreme and precision-limited levels", function () {
  const input = validInput();
  input.levels = {
    entry: 1e-300, stop: 1.0000000000000002e-300,
    tp1: Number.MIN_VALUE * 3, tp2: Number.MIN_VALUE * 2, tp3: Number.MIN_VALUE,
    valid: true, riskReward: Infinity
  };
  assert.equal(evaluateShortStrategy(input).riskReward, null);
  assert.equal(evaluateShortStrategy(input).allowed, false);
  input.levels.stop = input.levels.entry + Number.MIN_VALUE;
  const result = evaluateShortStrategy(input);
  assert.equal(result.riskReward, null);
  assert.equal(result.allowed, false);
});

test("missing OI has explicit per-timeframe readiness and recovers without borrowing another interval", function () {
  ["15m", "1h", "4h"].forEach(function (interval) {
    const input = validInput();
    input.oiChanges[interval] = null;
    const result = evaluateShortStrategy(input);
    assert.equal(result.allowed, false);
    assert.equal(result.matrix[interval].key, "unavailable");
    assert.deepEqual(result.readiness.timeframes[interval].missing, ["oiChanges." + interval]);
    assert.equal(result.readiness.timeframes[interval].ready, false);
    assert.equal(result.missingData, true);
    input.oiChanges[interval] = 0;
    assert.equal(evaluateShortStrategy(input).allowed, true);
  });
});

test("liquidity thresholds are inclusive and high scores cannot bypass any execution limit", function () {
  [
    ["depthUsd", 9999.99, 10000, 10000.01, false],
    ["spreadPercent", 0.19999, 0.2, 0.20001, true],
    ["slippagePercent", 0.14999, 0.15, 0.15001, true]
  ].forEach(function ([field, below, equal, above, maximum]) {
    [below, equal, above].forEach(function (value, index) {
      const input = validInput();
      input.orderBook[field] = value;
      const result = evaluateShortStrategy(input);
      const passes = maximum ? index < 2 : index > 0;
      assert.equal(result.allowed, passes, field + "=" + value);
      assert.equal(result.liquidity.passed, passes);
      assert.equal(result.setupConfirmed, true);
      assert.equal(result.dataReady, true);
      if (!passes) assert.match(result.blockers.join(" "), new RegExp(field));
    });
  });
});

test("R/R just below, equal to and above the configured minimum uses finalized prices", function () {
  [1.4999, 1.5, 1.5001].forEach(function (ratio) {
    const input = validInput();
    input.levels.tp1 = input.levels.entry - (input.levels.stop - input.levels.entry) * ratio;
    input.levels.riskReward = 999;
    const result = evaluateShortStrategy(input);
    assert.ok(Math.abs(result.riskReward - ratio) < 1e-12);
    assert.equal(result.allowed, ratio >= 1.5);
  });
});

test("published fees and estimated two-sided slippage reduce net R/R and may block gross-valid entries", function () {
  const input = validInput();
  input.takerFeeRate = 0.0005;
  let result = evaluateShortStrategy(input);
  assert.ok(result.netRiskReward < result.riskReward);
  assert.equal(result.allowed, true);
  input.levels.tp1 = input.levels.entry - (input.levels.stop - input.levels.entry) * 1.5;
  result = evaluateShortStrategy(input);
  assert.equal(result.riskReward, 1.5);
  assert.ok(result.netRiskReward < 1.5);
  assert.equal(result.allowed, false);
  assert.match(result.blockers.join(" "), /Net Reward\/Risk/);
});

test("timestamps, incomplete candles and level provenance cannot be bypassed by OK quality labels", function () {
  ["15m", "1h", "4h"].forEach(function (interval) {
    [undefined, 1, 1700000000].forEach(function (time) {
      const input = validInput();
      input.candles[interval].at(-1).time = time;
      const result = evaluateShortStrategy(input);
      assert.equal(result.allowed, false);
      assert.ok(result.missing.includes("candles." + interval));
      assert.equal(result.matrix[interval].key, "unavailable");
    });
  });
  [undefined, 1, 1700000001].forEach(function (time) {
    const input = validInput();
    input.stats.time = time;
    assert.ok(evaluateShortStrategy(input).missing.includes("stats.time"));
  });
  ["sourceTime", "invalidation", "atr"].forEach(function (field) {
    const input = validInput();
    delete input.levels[field];
    assert.equal(evaluateShortStrategy(input).allowed, false);
  });
  const input = validInput();
  input.levels.entry = 98;
  assert.equal(evaluateShortStrategy(input).allowed, false);
});

test("Q_USDT reported funding, positioning, depth and remote stop are individually explained", function () {
  const input = validInput();
  input.fundingNormalized = -0.000794 * 2;
  input.stats.lsrAccount = 0.733;
  input.orderBook = Object.assign(input.orderBook, { spreadPercent: 0.056, slippagePercent: 0.06, depthUsd: 3801 });
  input.levels = { entry: 0.12214, stop: 0.22041433, tp1: 0.115456, tp2: 0.11, tp3: 0.10, atr: 0.002 };
  const result = evaluateShortStrategy(input);
  assert.equal(result.allowed, false);
  assert.equal(result.dataReady, true);
  assert.match(result.blockers.join(" "), /depthUsd = 3801.*10000/);
  assert.match(result.blockers.join(" "), /-0.1588%\/8h.*0.733/);
  assert.match(result.blockers.join(" "), /stop\/рівні/);
  input.fundingNormalized = -0.000794;
  assert.equal(evaluateShortStrategy(input).flags.shortSqueezeRisk, false);
});

test("missing optional KDJ never masquerades as missing OI or vetoes the base strategy", function () {
  const input = validInput();
  const strategy = evaluateShortStrategy(input);
  const confirmation = evaluateShortConfirmation(input.candles["15m"], {
    state: { key: "entry" }, strategy: strategy
  }, { kdj: { enabled: true, period: 100, ma1: 3, ma2: 3 } }, input.nowSeconds);
  assert.ok(confirmation.unavailable.includes("KDJ"));
  assert.notEqual(confirmation.state, "confirmed");
  assert.equal(strategy.allowed, true);
  assert.deepEqual(strategy.missing, []);
});

test("cached books cannot outlive their generation timestamp even while receipt time is fresh", function () {
  const input = validInput();
  input.orderBook.generatedAt = input.nowSeconds - 29;
  assert.equal(evaluateShortStrategy(input).allowed, true);
  input.nowSeconds += 10;
  const result = evaluateShortStrategy(input);
  assert.equal(result.allowed, false);
  assert.ok(result.missing.includes("orderBook.generatedAt"));
  assert.ok(!result.missing.includes("orderBook.fetchedAt"));
});
