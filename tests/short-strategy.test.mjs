import test from "node:test";
import assert from "node:assert/strict";
import { classifyPriceOi, evaluateShortStrategy } from "../short-strategy.mjs";

function candle(open, high, low, close, volume) {
  return { open: open, high: high, low: low, close: close, volume: volume === undefined ? 100 : volume };
}

function validInput() {
  const candles15 = Array.from({ length: 20 }, function (_, index) {
    return candle(100, 100.2, 99.8, 100, 100);
  });
  candles15[candles15.length - 1] = candle(100, 100.2, 97.1, 97.3, 300);
  return {
    candles: {
      "15m": candles15,
      "1h": [
        candle(100, 101, 99, 100), candle(100, 100.5, 98, 99),
        candle(99, 99.5, 97, 98), candle(98, 98.5, 96, 97)
      ],
      "4h": [
        candle(104, 105, 103, 104), candle(103, 104, 102, 103),
        candle(102, 103, 101, 102), candle(101, 102, 100, 101)
      ]
    },
    changes: { "15m": -1, "1h": -2, "4h": -1 },
    oiChanges: { "15m": 1, "1h": 1.2, "4h": 1.5 },
    qualities: { "15m": "OK", "1h": "OK", "4h": "OK" },
    stats: { quality: "OK", lsrAccount: 1.5, shortLiquidationUsd: 100, longLiquidationUsd: 100 },
    ticker: { quality: "OK", last: 97.3, volume24h: 10000000 },
    orderBook: { quality: "OK", spreadPercent: 0.1, slippagePercent: 0.05, depthUsd: 50000 },
    volumeRatio: 2,
    indicators: { rsi: 45, macd: { histogram: -1 }, obvDivergence: true },
    fundingNormalized: 0.0005,
    levels: { riskReward: 2 },
    minimumRiskReward: 1.5
  };
}

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
  assert.equal(result.dataReady, true);
  assert.equal(result.allowed, true);
  assert.equal(result.matrix["4h"].key, "down_up");
  assert.equal(result.score, 100);
  assert.deepEqual(result.blockers, []);
});

test("recognizes a failed retest after support breaks and gives it priority", function () {
  const input = validInput();
  const candles = Array.from({ length: 20 }, function () { return candle(100, 100.2, 99.8, 100); });
  candles[16] = candle(100, 100.1, 97, 98);
  candles[17] = candle(98, 98.1, 97.3, 97.5);
  candles[18] = candle(97.5, 98, 97.4, 97.7);
  candles[19] = candle(99.9, 100, 98, 98.5, 300);
  input.candles["15m"] = candles;
  assert.equal(evaluateShortStrategy(input).setup.type, "failed_retest");
});

test("recognizes a failed local-high breakout only after price returns below its level", function () {
  const input = validInput();
  const candles = Array.from({ length: 20 }, function () { return candle(100, 100.2, 99.8, 100); });
  candles[16] = candle(100, 103, 99.8, 102.5);
  candles[19] = candle(103, 103.2, 101.8, 102.2, 300);
  input.candles["15m"] = candles;
  assert.equal(evaluateShortStrategy(input).setup.type, "failed_high_break");
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
  assert.match(result.blockers.join(" "), /агрегатів ліквідацій/);
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
  poorReward.levels.riskReward = 1.2;
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
