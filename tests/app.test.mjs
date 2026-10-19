import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { evaluateShortStrategy } from "../short-strategy.mjs";
import { buildMarketData, transitionSignal, validatePairList } from "../core.mjs";
import { normalizeContract, normalizeContractStats, normalizeOrderBook, normalizeTicker } from "../gate-api.mjs";

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

function functionSource(name) {
  const start = source.indexOf("function " + name + "(");
  const end = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, end);
}

test("funding UI shows the exact normalized strategy rate alongside its raw source interval", function () {
  const formatFunding = runInNewContext(functionSource("formatFunding") + "\nformatFunding;", {
    formatNumber: function (number, digits) { return number.toFixed(digits); }
  });
  const data = { funding: {
    raw: -0.000794, normalized: -0.001588, intervalSeconds: 14400, fetchedAt: 1710000000000
  } };
  assert.match(formatFunding(data), /-0.1588%\/8h.*raw -0.0794%\/4.0h/);
  assert.match(formatFunding({ funding: { normalized: null } }), /UNKNOWN/);
});

test("entry alerts require every mandatory gate and state changes, including same-candle recovery", function () {
  const api = runInNewContext(functionSource("notifyChange") + "\n({ notifyChange, getEvents: () => events });", {
    events: [], MAX_EVENTS: 12, window: {}
  });
  const value = { confirmed: true, strategy: { allowed: true, dataReady: true, blockers: [], missing: [] } };
  [
    { allowed: false }, { dataReady: false }, { blockers: ["depth below threshold"] }, { missing: ["oiChanges.15m"] }
  ].forEach(function (patch) {
    api.notifyChange("Q_USDT", "setup", "entry", { confirmed: true, strategy: { ...value.strategy, ...patch } });
  });
  assert.equal(api.getEvents().length, 0);
  const recovered = transitionSignal({
    ...value, state: { key: "entry" }, data: { candles15: [{ time: 1710000000, close: 100 }] }
  }, { state: { key: "setup" } }, 1710000000);
  assert.equal(recovered.unchangedCandle, true);
  api.notifyChange("Q_USDT", "setup", "entry", recovered);
  assert.equal(api.getEvents().length, 1);
  api.notifyChange("Q_USDT", "entry", "entry", recovered);
  assert.equal(api.getEvents().length, 1);
});

test("failed refresh revokes confirmed, readiness and alert eligibility", function () {
  const value = model();
  value.confirmed = true;
  value.strategy.allowed = true;
  value.strategy.dataReady = true;
  const models = { Q_USDT: value };
  const markUnavailable = runInNewContext(functionSource("markPairUnavailable") + "\nmarkPairUnavailable;", {
    models: models, pairErrors: {}, confirmationSettings: {},
    evaluateShortConfirmation: function () { return { state: "unavailable" }; }
  });
  markUnavailable("Q_USDT", "HTTP 429");
  assert.equal(models.Q_USDT.confirmed, false);
  assert.equal(models.Q_USDT.strategy.allowed, false);
  assert.equal(models.Q_USDT.strategy.readiness.ready, false);
  assert.equal(models.Q_USDT.strategy.status, "DATA UNAVAILABLE");
});

test("visualization crosshair shares pointer interaction across charts and resets on timeframe changes", function () {
  const stylesheet = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(source, /panel\.addEventListener\("pointerdown"/);
  assert.match(source, /panel\.addEventListener\("pointermove"/);
  assert.match(source, /controller\.selectAt\(chartIndex/);
  assert.match(source, /positionAtClientX\(event\.clientX/);
  assert.match(source, /data-crosshair-horizontal/);
  assert.match(source, /valueAtPosition\(price,/);
  assert.match(source, /delete visualizationCrosshairTimes\[pair\]/);
  assert.match(source, /data-chart-time/);
  assert.match(source, /data-crosshair-price-label/);
  assert.match(source, /data-chart-role="/);
  assert.doesNotMatch(source, /data-crosshair-value/);
  assert.match(stylesheet, /touch-action:\s*none/);
  assert.match(stylesheet, /\.visualization-crosshair-time[^}]*color:\s*#8cecff/);
  assert.match(stylesheet, /\.score-short[^}]*#79404a/);
});

test("SVG charts render both crosshair axes inside their plotted data bounds", function () {
  const chartSvg = runInNewContext(functionSource("chartSvg") + "\nchartSvg;", {
    escapeHtml: function (value) { return String(value); }
  });
  const svg = chartSvg([
    { values: [10, 20], color: "#fff", label: "close", digits: 2, times: [100, 200] }
  ], { label: "Close", times: [100, 200], domainTimes: [100, 200] });
  assert.match(svg, /data-crosshair-horizontal/);
  assert.match(svg, /data-crosshair-line/);
  assert.match(svg, /data-chart-viewbox-width="440"/);
  assert.match(svg, /data-chart-plot-start="5" data-chart-plot-end="325"/);
  assert.match(svg, /data-chart-min="9\.2" data-chart-max="20\.8"/);
});

test("only the primary close chart renders a right-side historical price label", function () {
  const chartSvg = runInNewContext(functionSource("chartSvg") + "\nchartSvg;", {
    escapeHtml: function (value) { return String(value); }
  });
  const series = [{ values: [10, 20], color: "#fff", label: "Close", digits: 8, times: [100, 200] }];
  const indicator = chartSvg(series, { label: "RSI", times: [100, 200], domainTimes: [100, 200] });
  const price = chartSvg(series, {
    label: "Price close", times: [100, 200], domainTimes: [100, 200], priceChart: true
  });

  assert.doesNotMatch(indicator, /data-crosshair-price-label/);
  assert.doesNotMatch(indicator, /data-crosshair-value/);
  assert.match(price, /data-chart-role="price"/);
  assert.match(price, /data-crosshair-price-label/);
  assert.match(price, /data-crosshair-price/);
  assert.match(price, /x="435" y="12" text-anchor="end"/);
  assert.doesNotMatch(price, /data-crosshair-value/);
});

test("primary price chart overlays a valid current ticker price without replacing candle history", function () {
  const chartSvg = runInNewContext(functionSource("chartSvg") + "\nchartSvg;", {
    escapeHtml: function (value) { return String(value); },
    formatNumber: function (value) { return String(value); }
  });
  const history = [{ values: [10, 11], color: "#fff", label: "Close", digits: 8, times: [100, 200] }];
  const svg = chartSvg(history, {
    label: "Price close", times: [100, 200], domainTimes: [100, 200], priceChart: true, currentPrice: 12
  });
  const withoutCurrentPrice = chartSvg(history, {
    label: "Price close", times: [100, 200], domainTimes: [100, 200], priceChart: true, currentPrice: null
  });

  assert.match(svg, /data-live-price-line/);
  assert.match(svg, /data-live-price-label[^>]*>LIVE 12<\/text>/);
  assert.match(svg, /"values":\[10,11\]/);
  assert.doesNotMatch(withoutCurrentPrice, /data-live-price/);
  assert.doesNotMatch(chartSvg(history, {
    label: "Price close", times: [100, 200], domainTimes: [100, 200], priceChart: true, currentPrice: Infinity
  }), /data-live-price/);
  assert.match(source, /ticker\.quality === "OK" && Number\.isFinite\(ticker\.last\)/);
  assert.match(source, /priceChart: true, currentPrice: currentPrice/);
  assert.match(source, /window\.setInterval\(scan, POLL_MS\)/);
});

test("partial API failures preserve other timeframes and missing contracts never delete saved pairs", async function () {
  const now = Math.floor(Date.now() / 1000);
  const models = {};
  const pairs = ["Q_USDT", "MISSING_USDT"];
  const start = source.indexOf("async function scan(");
  const end = source.indexOf('\ndocument.getElementById("pair-form")', start);
  const errors = {};
  const globals = {
    busy: false, pairs: pairs, contracts: [], models: models, pairErrors: {},
    lastSuccessfulUpdate: null, minimumRiskReward: 1.5, confirmationSettings: {},
    noticeNode: {}, connectionNode: {}, document: { getElementById: function () { return {}; } },
    fetchContracts: async function () { return [{ name: "Q_USDT", status: "trading", funding_interval: 14400, quanto_multiplier: "1" }]; },
    fetchTickers: async function () { return [{ contract: "Q_USDT", last: "100", funding_rate: "-0.000794", volume_24h_quote: "2000000" }]; },
    fetchCandles: async function (_, interval) {
      if (interval === "4h") throw new Error("HTTP 429");
      const seconds = { "5m": 300, "15m": 900, "1h": 3600 }[interval];
      return Array.from({ length: 4 }, function (_, index) {
        return { t: now - (4 - index) * seconds, o: "100", h: "101", l: "99", c: "100", v: "10" };
      });
    },
    fetchContractStats: async function () { return []; },
    fetchOrderBook: async function () { throw new Error("HTTP 503"); },
    mapLimited: async function (items, _, worker) { await Promise.all(items.map(worker)); },
    normalizeContract, normalizeContractStats, normalizeOrderBook, normalizeTicker, buildMarketData, transitionSignal,
    evaluateShortConfirmation: function () { return {}; },
    markPairUnavailable: function (pair, reason) { errors[pair] = reason; },
    notifyChange: function () { assert.fail("First unavailable scan must not announce a signal"); },
    render: function () {}, refreshOpenVisualizations: function () {}, lastSuccessLabel: function () { return ""; }
  };
  const scan = runInNewContext(source.slice(start, end) + "\nscan;", globals);
  await scan();
  assert.equal(models.Q_USDT.data.qualities["15m"], "OK");
  assert.equal(models.Q_USDT.data.qualities["1h"], "OK");
  assert.equal(models.Q_USDT.strategy.readiness.timeframes["4h"].ready, false);
  assert.ok(models.Q_USDT.strategy.missing.includes("candles.4h"));
  assert.equal(models.Q_USDT.strategy.allowed, false);
  assert.match(errors.MISSING_USDT, /пару збережено/);
  assert.deepEqual(pairs, ["Q_USDT", "MISSING_USDT"]);
});

test("saved pairs are sanitized without deleting pairs absent from a partial contract response", function () {
  const loadPairs = runInNewContext(functionSource("loadPairs") + "\nloadPairs;", {
    PAIR_KEY: "pairs", DEFAULT_PAIRS: ["BTC_USDT"], validatePairList,
    localStorage: { getItem: function () { return JSON.stringify(["q_usdt", "Q_USDT", "BAD!", null]); } }
  });
  assert.deepEqual(loadPairs(), ["Q_USDT"]);
});
