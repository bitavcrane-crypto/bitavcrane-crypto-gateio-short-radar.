import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { evaluateShortStrategy } from "../short-strategy.mjs";

const source = readFileSync(new URL("../app.mjs", import.meta.url), "utf8");
const start = source.indexOf("function renderStrategyPanel(");
const end = source.indexOf("\nfunction ", start + 1);
const renderPanel = runInNewContext(source.slice(start, end) + "\nrenderStrategyPanel;", {
  Date: Date,
  escapeHtml: function (value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  },
  formatNumber: function (value) { return Number.isFinite(value) ? String(value) : "—"; },
  formatPercent: function (value) { return Number.isFinite(value) ? value + "%" : "—"; }
});

function model() {
  const strategy = evaluateShortStrategy({
    changes: { "15m": -1, "1h": -1, "4h": -1 },
    oiChanges: { "15m": 1, "1h": 1, "4h": null }
  });
  return { strategy: strategy, levels: null, data: {
    changes: { "15m": -1, "1h": -1, "4h": -1 },
    oiChanges: { "15m": 1, "1h": 1, "4h": null }, candles15: [], orderBook: {}
  } };
}

test("DATA UNAVAILABLE UI lists specific OI and liquidation fields and never says missing data is none", function () {
  const value = model();
  const html = renderPanel(value);
  assert.equal(value.strategy.dataReady, false);
  assert.match(html, /OI.*4h|4h.*OI/);
  assert.match(html, /longLiquidationUsd|LONG/);
  assert.match(html, /shortLiquidationUsd|SHORT/);
  assert.doesNotMatch(html, /Відсутні дані:<\/strong> Немає/);
  assert.equal((html.match(/NO TRADE — DATA UNAVAILABLE/g) || []).length, 1);
});

test("detected failed-high formation is not labelled a confirmed entry and repeated blockers render once", function () {
  const value = model();
  value.strategy.setup = { type: "failed_high_break", level: 0.13 };
  value.strategy.setupStatus = "SETUP DETECTED";
  value.strategy.blockers = ["унікальна причина"];
  const html = renderPanel(value);
  assert.match(html, /SETUP DETECTED/);
  assert.doesNotMatch(html, /SHORT ENTRY дозволено|SETUP CONFIRMED/);
  assert.equal((html.match(/унікальна причина/g) || []).length, 1);
  assert.equal((source.match(/renderStrategyPanel\(model\)/g) || []).length, 2);
});
