import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { evaluateShortStrategy } from "../short-strategy.mjs";
import { buildMarketData, rankPumpCandidates, sortPairsBySignal, transitionSignal, validatePairList } from "../core.mjs";
import { normalizeContract, normalizeContractStats, normalizeOrderBook, normalizeTicker } from "../gate-api.mjs";
import { buildOpenInterestSeries } from "../oi-visualization.mjs";
import { buildIndicatorVisualization } from "../indicator-visualization.mjs";
import {
  OPEN_INTEREST_INTERVALS, VISUALIZATION_INTERVALS, removeVisualizationContract,
  setOpenInterestInterval, setVisualizationInterval
} from "../visualization-state.mjs";

const source = readFileSync(new URL("../app.mjs", import.meta.url), "utf8");
const start = source.indexOf("function renderStrategyPanel(");
const end = source.indexOf("\nfunction ", start + 1);
const renderPanel = runInNewContext(source.slice(start, end) + "\nrenderStrategyPanel;", {
  Date: Date,
  escapeHtml: function (value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  },
  formatNumber: function (value) { return Number.isFinite(value) ? String(value) : "—"; },
  formatPercent: function (value) { return Number.isFinite(value) ? value + "%" : "—"; },
  formatCvdContext: function () { return "CVD Binance: потік не активовано."; }
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
  assert.equal((source.match(/renderStrategyPanel\(model,/g) || []).length, 2);
});

test("market-stage evidence is displayed inside the existing strategy panel", function () {
  const value = model();
  value.stage = {
    label: "Можлива дистрибуція",
    supportingShort: ["нижчі максимуми"],
    againstShort: ["ціна зростає"],
    missing: ["OI недоступний"],
    priceMomentum: "зростання ціни за 45 хв",
    volumeEvidence: "RVOL недоступний",
    continuationRisk: "підвищений"
  };
  const html = renderPanel(value);
  assert.match(html, /Стадія пампу: Можлива дистрибуція/);
  assert.match(html, /Динаміка ціни:<\/strong> зростання ціни за 45 хв/);
  assert.match(html, /Обсяг:<\/strong> RVOL недоступний/);
  assert.match(html, /нижчі максимуми/);
  assert.match(html, /ціна зростає/);
  assert.match(html, /OI недоступний/);
  assert.match(html, /Ризик продовження: підвищений/);
});

test("stage evidence explains incomplete interval quality without contradicting an active pump", function () {
  const value = model();
  value.stage = {
    key: "active",
    label: "Памп триває",
    supportingShort: [],
    againstShort: ["ціна зростає"],
    missing: ["якість свічок 1h: INCOMPLETE; попередній памп для стадій «Можливий розподіл» і «Розворот підтверджено» не перевірений"],
    priceMomentum: "позитивне зростання",
    volumeEvidence: "RVOL підвищений",
    continuationRisk: "підвищений через позитивний імпульс ціни"
  };
  const html = renderPanel(value);
  assert.match(html, /Стадія пампу: Памп триває/);
  assert.match(html, /Не перевірено:<\/strong> якість свічок 1h: INCOMPLETE; попередній памп.*«Можливий розподіл».*«Розворот підтверджено» не перевірений/);
  assert.doesNotMatch(html, /якість свічок 1h не підтверджує памп-стадію/);
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

test("CVD context stays informational and fails closed when the optional stream is unavailable", function () {
  const format = runInNewContext(functionSource("formatCvdContext") + "\nformatCvdContext;", {
    formatNumber: function (value) { return Number.isFinite(value) ? String(value) : "—"; },
    formatPercent: function (value) { return Number.isFinite(value) ? value + "%" : "—"; }
  });
  assert.match(format(null), /відкрийте панель CVD/);
  assert.match(format({ state: "UNAVAILABLE", reason: "STALE_TRADES", frames: {} }), /угоди застаріли/);
  assert.match(format({ state: "UNAVAILABLE", frames: { "15m": {
    state: "UNAVAILABLE", reason: "MINIMUM_BARS"
  } } }), /потрібно щонайменше 9 завершених інтервалів/);
  const context = format({ state: "AVAILABLE", frames: { "15m": {
    state: "AVAILABLE", delta: -1200, priceChange: 0.8,
    divergence: { status: "BEARISH" }
  } } });
  assert.match(context, /ціна зростає при чистих продажах/);
  assert.match(context, /можливе поглинання, не сигнал/);
  assert.match(context, /дивергенція: ведмежа/);
  assert.match(context, /не самостійний SHORT-сигнал/);
  const insufficient = format({ state: "AVAILABLE", frames: { "15m": {
    state: "AVAILABLE", delta: 10, priceChange: -0.4,
    divergence: { status: "INSUFFICIENT_DATA" }
  } } });
  assert.match(insufficient, /дивергенція: недостатньо даних/);
});

test("pilot simulator is explicitly fictional and scenario controls update the unified explanation", function () {
  const html = readFileSync(new URL("../pilot.html", import.meta.url), "utf8");
  assert.match(html, /СИМУЛЯЦІЯ · НЕ LIVE-ДАНІ · НЕ BACKTEST/);
  assert.match(html, /Whale layer — не вигадуємо/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const fields = ["scenario-note", "price", "oi", "funding", "cvd", "book", "liquidations",
    "price-note", "oi-note", "funding-note", "cvd-note", "book-note", "limits", "engine-state", "engine-reason"];
  const nodes = new Map(fields.map(function (key) { return [key, { textContent: "" }]; }));
  const buttons = ["pump", "distribution", "blocked"].map(function (scenario) {
    return { dataset: { scenario }, attributes: {}, listeners: {}, setAttribute(key, value) {
      this.attributes[key] = value;
    }, addEventListener(key, callback) { this.listeners[key] = callback; } };
  });
  const document = {
    querySelectorAll: function () { return buttons; },
    getElementById: function (key) { return nodes.get(key); }
  };
  runInNewContext(script, { document });
  assert.match(nodes.get("engine-state").textContent, /СПОСТЕРЕЖЕННЯ/);
  buttons[1].listeners.click();
  assert.match(nodes.get("cvd-note").textContent, /можливе поглинання/);
  assert.match(nodes.get("engine-state").textContent, /WATCH/);
  buttons[2].listeners.click();
  assert.match(nodes.get("book").textContent, /ЗАСТАРІЛА/);
  assert.match(nodes.get("engine-state").textContent, /NO TRADE/);
});

test("entry alerts require every mandatory gate and state changes, including same-candle recovery", function () {
  const api = runInNewContext(functionSource("signalStateLabel") + "\n" +
    functionSource("notifyChange") + "\n({ notifyChange, getEvents: () => events });", {
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
  assert.match(api.getEvents()[0], /очікування підтвердження → SHORT підтверджено/);
  api.notifyChange("Q_USDT", "entry", "entry", recovered);
  assert.equal(api.getEvents().length, 1);
});

test("failed refresh revokes confirmed, readiness and alert eligibility", function () {
  const value = model();
  value.confirmed = true;
  value.strategy.allowed = true;
  value.strategy.dataReady = true;
  value.data.visibleWalls = { status: "AVAILABLE", bid: { notionalUsd: 50000 } };
  const removed = [];
  const models = { Q_USDT: value };
  const markUnavailable = runInNewContext(functionSource("markPairUnavailable") + "\nmarkPairUnavailable;", {
    models: models, pairErrors: {}, confirmationSettings: {},
    visibleWallTracker: { remove: function (pair) { removed.push(pair); } },
    evaluateShortConfirmation: function () { return { state: "unavailable" }; }
  });
  markUnavailable("Q_USDT", "HTTP 429");
  assert.equal(models.Q_USDT.confirmed, false);
  assert.equal(models.Q_USDT.strategy.allowed, false);
  assert.equal(models.Q_USDT.strategy.readiness.ready, false);
  assert.equal(models.Q_USDT.strategy.status, "DATA UNAVAILABLE");
  assert.equal(models.Q_USDT.stage.key, "insufficient");
  assert.equal(models.Q_USDT.stage.continuationRisk, "неможливо оцінити");
  assert.equal(models.Q_USDT.data.visibleWalls.status, "UNAVAILABLE");
  assert.deepEqual(removed, ["Q_USDT"]);
});

test("stale order books cannot display retained wall amounts or repetition counts", function () {
  const format = runInNewContext(functionSource("formatVisibleWalls") + "\nformatVisibleWalls;", {
    formatNumber: function (value) { return String(value); }
  });
  const summary = { status: "AVAILABLE", bid: {
    notionalUsd: 50000, price: 99.9, observedSnapshots: 5, sampleCount: 6, persistent: true
  }, ask: null };
  assert.match(format(summary, { quality: "OK" }), /50000/);
  const stale = format(summary, { quality: "STALE" });
  assert.match(stale, /рівні приховано/);
  assert.doesNotMatch(stale, /50000|5\/6/);
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

test("OI chart timeframe is independent and optional LONG/SHORT fields are described conditionally", function () {
  assert.match(source, /gate-short-radar-oi-visualization-state/);
  assert.match(source, /data-oi-visualization-timeframe=/);
  assert.match(source, /setOpenInterestInterval\(openInterestSelections, pair, select\.value\)/);
  assert.match(source, /buildOpenInterestSeries\(data && data\.oiVisualizationHistory \|\| \[\], openInterestInterval/);
  assert.match(source, /label: "TOP LONG OI · contracts"/);
  assert.match(source, /label: "TOP SHORT OI · contracts"/);
  assert.match(source, /Якщо Gate повертає top_long_size і top_short_size/);
  assert.match(source, /документовані поля окремими серіями TOP LONG\/SHORT OI у контрактах/);
  assert.doesNotMatch(source, /За Gate, top_long_size/);
  assert.match(source, /times: oiTimes, domainTimes: oiTimes/);
  assert.match(readFileSync(new URL("../styles.css", import.meta.url), "utf8"), /\.oi-legend \.oi-long::before[^}]*#49d4a5/);
  assert.match(readFileSync(new URL("../styles.css", import.meta.url), "utf8"), /\.oi-legend \.oi-short::before[^}]*#f18c8c/);
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
  const currentTickerPrice = runInNewContext(functionSource("currentTickerPrice") + "\ncurrentTickerPrice;");
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
  assert.equal(currentTickerPrice({ data: { ticker: { quality: "OK", last: 12 } } }), 12);
  assert.equal(currentTickerPrice({ data: { ticker: { quality: "STALE", last: 12 } } }), null);
  assert.equal(currentTickerPrice({ data: { ticker: { quality: "OK", last: 0 } } }), null);
  assert.equal(currentTickerPrice({ data: { ticker: { quality: "OK", last: Infinity } } }), null);
  assert.match(source, /const currentPrice = currentTickerPrice\(model\)/);
  assert.match(source, /const model = models\[pair\]/);
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
    busy: false, pairs: pairs, manualPairs: pairs, automaticPairs: [], dismissedAutomaticPairs: new Set(),
    MAX_AUTOMATIC_PAIRS: 12, MIN_AUTOMATIC_CHANGE_PERCENT: 5, MIN_AUTOMATIC_VOLUME_USDT: 250000,
    rankPumpCandidates: rankPumpCandidates, sortPairsBySignal: sortPairsBySignal,
    contracts: [], models: models, pairErrors: {},
    pairVersions: {}, statsRequests: {}, AbortController,
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
    fetchContractStats: async function () { return [{
      time: Math.floor(now / 300) * 300 - 300,
      open_interest: "1000", top_long_size: "600", top_short_size: "400"
    }]; },
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
  assert.equal(models.Q_USDT.data.oiVisualizationHistory[0].topLongOpenInterest, 600);
  assert.equal(models.Q_USDT.data.oiVisualizationHistory[0].topShortOpenInterest, 400);
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

  function visualizationHarness(overrides = {}) {
    const globals = {
      pairs: ["Q_USDT"], visualizationData: {}, visualizationRequests: {}, POLL_MS: 60000,
      VISUALIZATION_INTERVALS, OPEN_INTEREST_INTERVALS, AbortController, normalizeCandles: null,
      models: {}, buildOpenInterestSeries, buildIndicatorVisualization,
      selectedVisualizationInterval: function () { return "15m"; },
      selectedOpenInterestInterval: function () { return "5m"; },
      escapeHtml: function (value) { return String(value); },
      chartSvg: function () { return "<svg></svg>"; },
      directionLabel: String,
      currentChartSettings: function () {
        return { rci: { periods: [6] }, ema: { periods: [22] }, obv: { lookback: 10 },
          kdj: { period: 9, ma1: 3, ma2: 3 } };
      },
      render: function () {}, fetchVisualizationCandles: async function () { return []; },
      ...overrides
    };
    const start = source.indexOf("async function ensureVisualizationData(");
    const end = source.indexOf("\nfunction refreshOpenVisualizations(", start);
    const api = runInNewContext(
      source.slice(start, end) + "\n" + functionSource("renderOpenInterestVisualization") + "\n" +
      functionSource("renderIndicatorVisualization") +
      "\n({ ensureVisualizationData, cancelVisualizationRequest, renderIndicatorVisualization, renderOpenInterestVisualization });",
      globals
    );
    return { globals, ...api };
  }

  test("OI selector and data render independently during candle loading, errors and gaps", function () {
    const now = Math.floor(Date.now() / 1000 / 300) * 300;
    const history = [{ time: now - 300, topLongOpenInterest: null, topShortOpenInterest: 200 }];
    const harness = visualizationHarness({
      models: { Q_USDT: { data: { oiVisualizationHistory: history, stats: { quality: "OK" } } } }
    });
    const gaps = [3600, 1800].map(function (offset) {
      return { time: Math.floor(now / 900) * 900 - offset, open: 100, high: 102, low: 99, close: 101, volume: 10 };
    });
    for (const data of [undefined, { loading: true }, { error: "HTTP 503" }, { candles: [] }, { candles: gaps }]) {
      harness.globals.visualizationData.Q_USDT = { "15m": data };
      const html = harness.renderIndicatorVisualization("Q_USDT");
      assert.match(html, /data-oi-visualization-timeframe="Q_USDT"/);
      assert.match(html, /LONG: UNAVAILABLE/);
      assert.match(html, /SHORT: OK/);
      assert.match(html, /останній фактичний 5m знімок/);
    }
  });

  test("OI rendering warns about missing/stale top fields even when statistics remain OK", function () {
    const now = Math.floor(Date.now() / 1000 / 300) * 300;
    const harness = visualizationHarness({
      models: { Q_USDT: { data: {
        oiVisualizationHistory: [
          { time: now - 1800, topLongOpenInterest: 100, topShortOpenInterest: 200 },
          { time: now - 300, topLongOpenInterest: null, topShortOpenInterest: 201 }
        ], stats: { quality: "OK" }
      } } }
    });
    const html = harness.renderOpenInterestVisualization("Q_USDT");
    assert.match(html, /LONG: MISSING \/ STALE/);
    assert.match(html, /SHORT: OK/);
    assert.match(html, new RegExp(new Date((now - 1800) * 1000).toLocaleString("uk-UA")));
    assert.doesNotMatch(html, /Стан джерела OI: STALE/);
  });

  test("stale candle history gets an explicit freshness warning without hiding OI", function () {
    const now = Math.floor(Date.now() / 1000 / 900) * 900;
    const candles = Array.from({ length: 40 }, function (_, index) {
      return { time: now - (80 - index) * 900, open: 100, high: 102, low: 99, close: 101, volume: 10 };
    });
    const harness = visualizationHarness({
      visualizationData: { Q_USDT: { "15m": { candles, quality: "OK", updatedAt: Date.now() } } },
      currentChartSettings: function () {
        return { rci: { periods: [6] }, ema: { periods: [22] }, obv: { lookback: 10 },
          kdj: { period: 9, ma1: 3, ma2: 3 } };
      },
      currentTickerPrice: function () { return null; }, formatNumber: String,
      hasBullishFourHourTrend: function () { return false; }, formatCrosshairTime: String
    });
    const html = harness.renderIndicatorVisualization("Q_USDT");
    assert.match(html, /Стан свічок: STALE/);
    assert.match(html, /data-oi-visualization-timeframe/);
  });

  test("obsolete candle responses cannot overwrite a newer request or resurrect removed data", async function () {
    const requests = [];
    const harness = visualizationHarness({
      normalizeCandles: function (rows) { return { candles: rows, quality: "OK" }; },
      fetchVisualizationCandles: function (pair, interval, signal) {
        return new Promise(function (resolve) { requests.push({ pair, interval, signal, resolve }); });
      }
    });
    const first = harness.ensureVisualizationData("Q_USDT", "15m");
    const second = harness.ensureVisualizationData("Q_USDT", "5m");
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(harness.globals.visualizationData.Q_USDT["15m"].loading, false);
    requests[1].resolve([{ time: 200 }]);
    await second;
    requests[0].resolve([{ time: 100 }]);
    await first;
    assert.equal(harness.globals.visualizationData.Q_USDT["5m"].candles[0].time, 200);
    assert.equal(harness.globals.visualizationData.Q_USDT["15m"].candles, undefined);
    const third = harness.ensureVisualizationData("Q_USDT", "1h");
    harness.cancelVisualizationRequest("Q_USDT");
    harness.globals.pairs.length = 0;
    delete harness.globals.visualizationData.Q_USDT;
    requests[2].resolve([{ time: 300 }]);
    await third;
    assert.equal(requests[2].signal.aborted, true);
    assert.equal(harness.globals.visualizationData.Q_USDT, undefined);
  });

  test("returning to a cached timeframe cancels obsolete work and late errors stay discarded", async function () {
    let reject;
    let signal;
    const harness = visualizationHarness({
      visualizationData: { Q_USDT: { "5m": { candles: [{ time: 123 }], updatedAt: Date.now() } } },
      fetchVisualizationCandles: function (_, interval, value) {
        signal = value;
        return new Promise(function (_, fail) { reject = fail; });
      }
    });
    const pending = harness.ensureVisualizationData("Q_USDT", "15m");
    await harness.ensureVisualizationData("Q_USDT", "5m");
    reject(new Error("HTTP 503"));
    await pending;
    assert.equal(signal.aborted, true);
    assert.equal(harness.globals.visualizationData.Q_USDT["15m"].error, undefined);
    assert.equal(harness.globals.visualizationData.Q_USDT["5m"].candles[0].time, 123);
  });

  test("candle HTTP and timeout failures retain history, clear loading and can recover", async function () {
    let failure = new Error("HTTP 503");
    const harness = visualizationHarness({
      visualizationData: { Q_USDT: { "15m": { candles: [{ time: 1 }], updatedAt: 1 } } },
      normalizeCandles: function (rows) { return { candles: rows, quality: "OK" }; },
      fetchVisualizationCandles: async function () {
        if (failure) throw failure;
        return [{ time: 2 }];
      }
    });

    for (const message of ["HTTP 503", "The operation was aborted due to timeout"]) {
      failure = new Error(message);
      await harness.ensureVisualizationData("Q_USDT", "15m");
      const data = harness.globals.visualizationData.Q_USDT["15m"];
      assert.equal(data.error, message);
      assert.equal(data.loading, false);
      assert.equal(data.candles[0].time, 1);
      assert.equal(data.updatedAt, 1);
    }
    failure = null;
    await harness.ensureVisualizationData("Q_USDT", "15m");
    assert.equal(harness.globals.visualizationData.Q_USDT["15m"].candles[0].time, 2);
    assert.equal(harness.globals.visualizationData.Q_USDT["15m"].error, undefined);
  });

    function scanHarness(overrides = {}) {
      const now = Math.floor(Date.now() / 1000);
      const globals = {
        busy: false, pairs: ["Q_USDT"], manualPairs: ["Q_USDT"], automaticPairs: [],
        dismissedAutomaticPairs: new Set(),
        MAX_AUTOMATIC_PAIRS: 12, MIN_AUTOMATIC_CHANGE_PERCENT: 5, MIN_AUTOMATIC_VOLUME_USDT: 250000,
        rankPumpCandidates: rankPumpCandidates, sortPairsBySignal: sortPairsBySignal,
        contracts: [], models: {}, pairErrors: {},
        pairVersions: {}, statsRequests: {}, AbortController,
        lastSuccessfulUpdate: null, minimumRiskReward: 1.5, confirmationSettings: {},
        noticeNode: {}, connectionNode: {}, document: { getElementById: function () { return {}; } },
        fetchContracts: async function () {
          return [{ name: "Q_USDT", status: "trading", funding_interval: 14400, quanto_multiplier: "1" }];
        },
        fetchTickers: async function () {
          return [{ contract: "Q_USDT", last: "100", funding_rate: "0", volume_24h_quote: "2000000" }];
        },
        fetchCandles: async function (_, interval) {
          const seconds = VISUALIZATION_INTERVALS[interval];
          return Array.from({ length: 4 }, function (_, index) {
            return { t: Math.floor(now / seconds) * seconds - (4 - index) * seconds,
              o: "100", h: "101", l: "99", c: "100", v: "10" };
          });
        },
        fetchContractStats: async function () {
          return [{ time: Math.floor(now / 300) * 300 - 300,
            open_interest: "1000", top_long_size: "600", top_short_size: "400" }];
        },
        fetchOrderBook: async function () {
          return { bids: [{ p: "99.9", s: "100" }], asks: [{ p: "100.1", s: "100" }], current: now };
        },
        mapLimited: async function (items, _, worker) { await Promise.all(items.map(worker)); },
        normalizeContract, normalizeContractStats, normalizeOrderBook, normalizeTicker, buildMarketData, transitionSignal,
        evaluateShortConfirmation: function () { return {}; },
        notifyChange: function () {}, render: function () {}, refreshOpenVisualizations: function () {},
        lastSuccessLabel: function () { return ""; }, ...overrides
      };
      const start = source.indexOf("async function scan(");
      const end = source.indexOf('\ndocument.getElementById("pair-form")', start);
      const scan = runInNewContext(functionSource("markPairUnavailable") + "\n" +
        source.slice(start, end) + "\nscan;", globals);
      return { globals, scan };
    }

    test("scan discovers active liquid pump candidates and runs them through strict SHORT gates", async function () {
      const harness = scanHarness({
        fetchContracts: async function () {
          return ["Q_USDT", "PUMP_USDT"].map(function (name) {
            return { name: name, status: "trading", funding_interval: 14400, quanto_multiplier: "1" };
          });
        },
        fetchTickers: async function () {
          return [
            { contract: "Q_USDT", last: "100", funding_rate: "0", volume_24h_quote: "2000000" },
            { contract: "PUMP_USDT", last: "3", funding_rate: "0", volume_24h_quote: "400000", change_percentage: "12" }
          ];
        }
      });
      await harness.scan();
      assert.deepEqual(harness.globals.manualPairs, ["Q_USDT"]);
      assert.deepEqual(harness.globals.automaticPairs, ["PUMP_USDT"]);
      assert.deepEqual(harness.globals.pairs, ["Q_USDT", "PUMP_USDT"]);
      assert.equal(harness.globals.models.PUMP_USDT.data.ticker.last, 3);
      assert.equal(harness.globals.models.PUMP_USDT.confirmed, false);
      assert.equal(harness.globals.models.PUMP_USDT.strategy.allowed, false);
    });

    test("automatic candidates keep active reversal scenarios under observation after ticker filter changes", async function () {
      const harness = scanHarness({
        pairs: ["Q_USDT", "PUMP_USDT"],
        manualPairs: ["Q_USDT"],
        automaticPairs: ["PUMP_USDT"],
        models: { PUMP_USDT: { state: { key: "setup" } } },
        fetchContracts: async function () {
          return ["Q_USDT", "PUMP_USDT"].map(function (name) {
            return { name: name, status: "trading", funding_interval: 14400, quanto_multiplier: "1" };
          });
        }
      });
      await harness.scan();
      assert.deepEqual(harness.globals.automaticPairs, ["PUMP_USDT"]);
      assert.deepEqual(harness.globals.pairs, ["Q_USDT", "PUMP_USDT"]);
    });

    test("multiple scans expose missing OI on partial failures, recover, and mark retained data stale on global failure", async function () {
      const harness = scanHarness();
      const goodStats = harness.globals.fetchContractStats;
      const goodTickers = harness.globals.fetchTickers;
      await harness.scan();
      assert.equal(harness.globals.models.Q_USDT.data.oiVisualizationHistory[0].topLongOpenInterest, 600);
      harness.globals.fetchContractStats = async function () { throw new Error("HTTP 503"); };
      await harness.scan();
      assert.equal(harness.globals.models.Q_USDT.data.oiVisualizationHistory.length, 0);
      assert.equal(harness.globals.models.Q_USDT.data.stats.quality, "NO DATA");
      assert.equal(harness.globals.models.Q_USDT.data.qualities["15m"], "OK");
      assert.match(harness.globals.noticeNode.textContent, /stats: HTTP 503/);
      harness.globals.fetchContractStats = goodStats;
      await harness.scan();
      assert.equal(harness.globals.models.Q_USDT.data.oiVisualizationHistory[0].topLongOpenInterest, 600);
      assert.equal(harness.globals.noticeNode.hidden, true);
      harness.globals.fetchTickers = async function () { throw new Error("network unavailable"); };
      await harness.scan();
      assert.equal(harness.globals.models.Q_USDT.data.stats.quality, "STALE");
      assert.equal(harness.globals.models.Q_USDT.data.oiVisualizationHistory[0].topLongOpenInterest, 600);
      harness.globals.fetchTickers = goodTickers;
      await harness.scan();
      assert.equal(harness.globals.models.Q_USDT.data.stats.quality, "OK");
      assert.equal(harness.globals.models.Q_USDT.quality === "STALE", false);
    });

    test("scan results for a removed and re-added pair cannot restore the old model or report obsolete failures", async function () {
      let finish;
      let signal;
      const harness = scanHarness({
        fetchContractStats: function (_, value) {
          signal = value;
          return new Promise(function (resolve) { finish = resolve; });
        }
      });
      const pending = harness.scan();
      while (!finish) await Promise.resolve();
      harness.globals.pairVersions.Q_USDT = 1;
      harness.globals.pairs.length = 0;
      harness.globals.statsRequests.Q_USDT.abort();
      delete harness.globals.statsRequests.Q_USDT;
      harness.globals.pairs.push("Q_USDT");
      finish([{ time: 1710000000, top_long_size: "1", top_short_size: "2" }]);
      await pending;
      assert.equal(signal.aborted, true);
      assert.equal(harness.globals.models.Q_USDT, undefined);
      assert.equal(harness.globals.pairErrors.Q_USDT, undefined);
      assert.equal(harness.globals.noticeNode.hidden, true);
      assert.deepEqual(Object.keys(harness.globals.statsRequests), []);
    });

test("OI timeframe changes are local-only and the remove control aborts both relevant requests", function () {
  const handlers = {};
  const selectors = ["data-remove", "data-oi-visualization-timeframe"];
  const candles = new AbortController();
  const stats = new AbortController();
  const globals = {
    document: { getElementById: function () { return {}; } }, signalSummaryNode: {}, eventList: {},
    pairs: ["Q_USDT"], manualPairs: ["Q_USDT"], automaticPairs: [], dismissedAutomaticPairs: new Set(),
    models: { Q_USDT: { state: { key: "none" } } }, events: [], pairErrors: {},
    pairVersions: {}, visualizationData: { Q_USDT: { "5m": { loading: true } } },
    visualizationRequests: { Q_USDT: { interval: "5m", controller: candles } },
    statsRequests: { Q_USDT: stats }, visualizationSelections: { Q_USDT: "15m" },
    openInterestSelections: {}, visualizationCrosshairTimes: { Q_USDT: 123 },
    openVisualizations: new Set(["Q_USDT"]), setOpenInterestInterval, setVisualizationInterval,
    removeVisualizationContract, removePair: function (pairs, pair) { return pairs.filter(function (value) { return value !== pair; }); },
    sortPairsBySignal: function (pairs) { return pairs; }, renderCard: function () { return ""; },
    cvdAnalysis: { mount: function () {} },
    savePairs: function () {}, saveVisualizationSelections: function () {}, saveOpenInterestSelections: function () {},
    ensureVisualizationData: function () { assert.fail("OI timeframe change must not fetch candles"); },
    cardsNode: { querySelectorAll: function (selector) {
      const name = selector.slice(1, -1);
      return selectors.includes(name) ? [{
        value: "4h", getAttribute: function () { return "Q_USDT"; },
        addEventListener: function (_, handler) { handlers[name] = handler; }
      }] : [];
    } }
  };
  const render = runInNewContext(functionSource("cancelVisualizationRequest") + "\n" +
    functionSource("render") + "\nrender;", globals);
  render();
  handlers["data-oi-visualization-timeframe"]();
  assert.equal(globals.openInterestSelections.Q_USDT, "4h");
  assert.equal(globals.visualizationSelections.Q_USDT, "15m");
  assert.equal(candles.signal.aborted, false);
  assert.equal(stats.signal.aborted, false);
  handlers["data-remove"]();
  assert.equal(candles.signal.aborted, true);
  assert.equal(stats.signal.aborted, true);
  assert.equal(globals.pairVersions.Q_USDT, 1);
  assert.equal(globals.visualizationData.Q_USDT, undefined);
  assert.equal(globals.models.Q_USDT, undefined);
  assert.equal(globals.pairs.length, 0);
});

test("absent optional top fields are named unavailable instead of inferred from total OI or ratios", function () {
  const now = Math.floor(Date.now() / 1000 / 300) * 300;
  const stats = normalizeContractStats([{
    time: now - 300, open_interest: "1000", open_interest_usd: "100000",
    lsr_account: "2", lsr_taker: "3", top_lsr_account: "4", top_lsr_size: "5"
  }], now);
  assert.equal(stats.quality, "OK");
  const harness = visualizationHarness({
    models: { Q_USDT: { data: { oiVisualizationHistory: stats.rows, stats } } },
    chartSvg: function () { assert.fail("Missing fields must not produce derived series"); }
  });
  const html = harness.renderOpenInterestVisualization("Q_USDT");
  assert.match(html, /LONG: UNAVAILABLE · немає даних поля top_long_size/);
  assert.match(html, /SHORT: UNAVAILABLE · немає даних поля top_short_size/);
  assert.match(html, /Якщо Gate повертає top_long_size і top_short_size/);
  assert.match(html, /фактична наявність полів у live-відповіді не перевірена/);
  assert.match(html, /TOP LONG OI · contracts/);
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /gate\/gateapi-python\/blob\/master\/docs\/ContractStat\.md/);
  assert.doesNotMatch(readme, /github\.com\/gateio\/gateapi[^/\s]*\/(?:blob|tree)\//);
  assert.match(readme, /Чинна схема документує `top_long_size` \/ `top_short_size`/);
});

test("a fresh 100-snapshot response explicitly reports insufficient complete four-hour history", function () {
  const now = 1710000000 + 8 * 300;
  const history = Array.from({ length: 100 }, function (_, index) {
    return { time: now - (100 - index) * 300, topLongOpenInterest: 100 + index, topShortOpenInterest: 200 + index };
  });
  const harness = visualizationHarness({
    Date: class extends Date { static now() { return now * 1000; } },
    selectedOpenInterestInterval: function () { return "4h"; },
    models: { Q_USDT: { data: { oiVisualizationHistory: history, stats: { quality: "OK" } } } },
    chartSvg: function () { assert.fail("One snapshot per series cannot form a line"); }
  });
  const html = harness.renderOpenInterestVisualization("Q_USDT");
  assert.match(html, /Недостатньо завершеної 4h історії/);
  assert.match(html, /100 знімків 5m не гарантує двох повних UTC-вікон 4h/);
  assert.match(html, /LONG: OK/);
  assert.match(html, /SHORT: OK/);
  assert.match(html, /LONG: 1 · SHORT: 1/);
  assert.doesNotMatch(html, /STALE|<svg/);
});

test("96 aligned five-minute snapshots produce two complete four-hour points and both actual lines", function () {
  const start = 1710000000;
  const now = start + 96 * 300;
  const history = Array.from({ length: 96 }, function (_, index) {
    return { time: start + index * 300, topLongOpenInterest: 100 + index, topShortOpenInterest: 200 + index };
  });
  const chartSvg = runInNewContext(functionSource("chartSvg") + "\nchartSvg;", { escapeHtml: String });
  const harness = visualizationHarness({
    Date: class extends Date { static now() { return now * 1000; } },
    selectedOpenInterestInterval: function () { return "4h"; },
    models: { Q_USDT: { data: { oiVisualizationHistory: history, stats: { quality: "OK" } } } },
    chartSvg
  });
  const view = buildOpenInterestSeries(history, "4h", now);
  assert.equal(view.rows.length, 2);
  const html = harness.renderOpenInterestVisualization("Q_USDT");
  assert.equal((html.match(/<polyline /g) || []).length, 2);
  assert.doesNotMatch(html, /Недостатньо завершеної 4h історії/);
});
test("per-field disappearance stays explicitly missing across scans and ages independently of fresh statistics", async function () {
  const start = Math.floor(Date.now() / 1000 / 300) * 300;
  let clock = start;
  let missingLong = false;
  const Clock = class extends Date { static now() { return clock * 1000; } };
  const harness = scanHarness({
    Date: Clock,
    fetchContractStats: async function () {
      return [start - 900, start - 600, clock - 300].map(function (time, index) {
        const row = { time, open_interest: "1000", top_short_size: "400" };
        if (!missingLong || index < 2) row.top_long_size = "600";
        return row;
      });
    }
  });
  await harness.scan();
  assert.equal(buildOpenInterestSeries(harness.globals.models.Q_USDT.data.oiVisualizationHistory, "5m", clock)
    .source.long.status, "ok");
  missingLong = true;
  await harness.scan();
  let data = harness.globals.models.Q_USDT.data;
  let view = buildOpenInterestSeries(data.oiVisualizationHistory, "5m", clock);
  assert.equal(data.stats.quality, "OK");
  assert.equal(data.oiVisualizationHistory.at(-1).topLongOpenInterest, null);
  assert.equal(view.source.long.status, "missing");
  assert.equal(view.source.long.lastTime, start - 600);
  assert.equal(view.source.long.stale, false);
  assert.equal(view.source.short.status, "ok");
  clock += 900;
  await harness.scan();
  data = harness.globals.models.Q_USDT.data;
  view = buildOpenInterestSeries(data.oiVisualizationHistory, "5m", clock);
  assert.equal(data.stats.quality, "OK");
  assert.equal(view.source.long.status, "missing");
  assert.equal(view.source.long.lastTime, start - 600);
  assert.equal(view.source.long.stale, true);
  assert.equal(view.source.short.status, "ok");
  assert.equal(view.source.short.lastTime, clock - 300);
  const renderer = visualizationHarness({ Date: Clock, models: harness.globals.models });
  const html = renderer.renderOpenInterestVisualization("Q_USDT");
  assert.match(html, /LONG: MISSING \/ STALE · немає даних поля top_long_size/);
  assert.match(html, /SHORT: OK/);
  assert.ok(html.includes(new Date((start - 600) * 1000).toLocaleString("uk-UA")));
});
