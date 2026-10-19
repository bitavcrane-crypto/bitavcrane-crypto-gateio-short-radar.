import test from "node:test";
import assert from "node:assert/strict";
import {
  getVisualizationInterval, normalizeVisualizationSelections, removeVisualizationContract,
  setVisualizationInterval
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
