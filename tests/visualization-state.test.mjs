import test from "node:test";
import assert from "node:assert/strict";
import {
  getOpenInterestInterval, getVisualizationInterval, normalizeOpenInterestSelections,
  normalizeVisualizationSelections, removeVisualizationContract, setOpenInterestInterval, setVisualizationInterval
} from "../visualization-state.mjs";

test("timeframe selection is independent by contract and survives pair reordering", function () {
  let selections = {};
  selections = setVisualizationInterval(selections, "BTC_USDT", "5m");
  selections = setVisualizationInterval(selections, "ETH_USDT", "4h");
  const restored = normalizeVisualizationSelections(JSON.parse(JSON.stringify(selections)));
  assert.equal(getVisualizationInterval(restored, "BTC_USDT"), "5m");
  assert.equal(getVisualizationInterval(restored, "ETH_USDT"), "4h");
  assert.equal(getVisualizationInterval(restored, "SOL_USDT"), "15m");
  assert.deepEqual(Object.keys(restored).reverse().map(function (pair) {
    return [pair, getVisualizationInterval(restored, pair)];
  }).sort(), [["BTC_USDT", "5m"], ["ETH_USDT", "4h"]]);
});

test("invalid saved timeframes are ignored and removed contracts lose only their own state", function () {
  const loaded = normalizeVisualizationSelections({ BTC_USDT: "1m", ETH_USDT: "1h" });
  assert.equal(getVisualizationInterval(loaded, "BTC_USDT"), "15m");
  assert.deepEqual(removeVisualizationContract(loaded, "ETH_USDT"), {});
});

test("OI timeframe selection is stored independently by contract", function () {
  let oiSelections = {};
  oiSelections = setOpenInterestInterval(oiSelections, "BTC_USDT", "15m");
  oiSelections = setOpenInterestInterval(oiSelections, "ETH_USDT", "4h");
  const restored = normalizeOpenInterestSelections(JSON.parse(JSON.stringify(oiSelections)));
  assert.equal(getOpenInterestInterval(restored, "BTC_USDT"), "15m");
  assert.equal(getOpenInterestInterval(restored, "ETH_USDT"), "4h");
  assert.equal(getOpenInterestInterval(restored, "SOL_USDT"), "5m");
  assert.deepEqual(removeVisualizationContract(restored, "ETH_USDT"), { BTC_USDT: "15m" });
  assert.deepEqual(normalizeOpenInterestSelections({ BTC_USDT: "1m" }), {});
});
