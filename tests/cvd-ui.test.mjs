import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createCvdAnalysis, renderCvdSnapshot } from "../cvd-ui.mjs";
import { buildMarketData, transitionSignal } from "../core.mjs";
import { createCvdStore } from "../cvd.mjs";

test("unusable CVD never displays fabricated zeroes, directions, or charts", function () {
  for (const state of ["LOADING", "DELAYED", "INSUFFICIENT_DATA", "UNAVAILABLE", "ERROR"]) {
    const html = renderCvdSnapshot({ state, reason: "Немає перевіреного напрямку <script>", frames: {
      "15m": { state: "AVAILABLE", delta: -100, cvdChange: -100, buyVolume: 1, sellVolume: 101,
        divergence: { status: "BEARISH" } }
    } }, "15m", function () { assert.fail("Unusable data must not be charted"); });
    assert.match(html, /Не визначено/);
    assert.doesNotMatch(html, /Продавці переважають|Покупці переважають|Підтверджена ведмежа|<script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /Агресивні BUY \/ SELL · USDT<\/dt><dd>— \/ —/);
  }
});

test("CVD uses separate price and CVD chart calls with the same closed time domain", function () {
  const draws = [];
  const bars = [
    { time: 900000, end: 1800000, closed: true, coverage: 1, close: 100, cvd: 10 },
    { time: 1800000, end: 2700000, closed: true, coverage: 1, close: 110, cvd: 8 },
    { time: 2700000, end: 3600000, closed: false, coverage: 1, close: 120, cvd: 6 },
    { time: 0, end: 900000, closed: true, coverage: 0.5, close: 99, cvd: 4 }
  ];
  const html = renderCvdSnapshot({
    contract: "A_USDT", state: "AVAILABLE", lastTradeAt: 2700000,
    frames: { "15m": { state: "AVAILABLE", cvd: 8, delta: -2, cvdChange: -2, imbalance: -0.1,
      sampleCount: 12, coverage: 1, bars, divergence: { status: "NONE" } } }
  }, "15m", function (series, options) { draws.push({ series, options }); return "<svg></svg>"; });
  assert.equal(draws.length, 2);
  assert.deepEqual(draws[0].options.domainTimes, draws[1].options.domainTimes);
  assert.deepEqual(draws[0].series[0].values, [100, 110]);
  assert.deepEqual(draws[1].series[0].values, [10, 8]);
  assert.match(html, /окрема шкала/);
  assert.match(html, /Продавці переважають/);
  assert.match(html, /Підтвердженої дивергенції немає/);
  assert.match(html, /UTC/);
});

test("CVD charts break lines across missing intervals instead of interpolating unknown activity", function () {
  const draws = [];
  renderCvdSnapshot({ state: "AVAILABLE", frames: { "15m": { state: "AVAILABLE", bars: [
    { time: 900000, end: 1800000, closed: true, coverage: 1, close: 100, cvd: 20 },
    { time: 2700000, end: 3600000, closed: true, coverage: 1, close: 120, cvd: 10 }
  ] } } }, "15m", function (series) { draws.push(series); return ""; });
  assert.deepEqual(draws[0][0].values, [100, null, 120]);
  assert.deepEqual(draws[1][0].values, [20, null, 10]);
});

function harness(failure = false) {
  const calls = [];
  const subscriptions = new Set();
  const listeners = new Map();
  let timer = null;
  let activePairs = ["A_USDT", "B_USDT"];
  const hosts = new Map();
  const cards = new Map();
  const root = {
    ownerDocument: { createElement: function () {
      const content = { hidden: true, innerHTML: "" };
      const attrs = {};
      return { content, innerHTML: "", className: "", setAttribute: function (key, value) { attrs[key] = value; },
        getAttribute: function (key) { return attrs[key]; }, querySelector: function () { return content; } };
    } },
    contains: function () { return true; },
    addEventListener: function (type, callback) { assert.equal(listeners.has(type), false); listeners.set(type, callback); },
    removeEventListener: function (type) { listeners.delete(type); },
    querySelectorAll: function () {
      return activePairs.map(function (contract) {
        if (!cards.has(contract)) cards.set(contract, {
          querySelector: function () { return hosts.get(contract); },
          append: function (host) { hosts.set(contract, host); }
        });
        return { getAttribute: function () { return contract; }, closest: function () { return cards.get(contract); } };
      });
    }
  };
  const controller = createCvdAnalysis({
    createStore: function () { return { snapshot: function (contract) { return {
      state: "UNAVAILABLE", reason: contract + " · напрямок не підтверджено"
    }; } }; },
    createFeed: function () { return {
      subscribe: function (contract, multiplier) {
        if (subscriptions.has(contract)) return false;
        calls.push(["subscribe", contract, multiplier]);
        if (failure) throw Error("offline");
        subscriptions.add(contract);
        return true;
      },
      unsubscribe: function (contract) { subscriptions.delete(contract); calls.push(["unsubscribe", contract]); },
      dispose: function () { calls.push(["dispose"]); }
    }; },
    getMultiplier: function () { return 0.001; },
    setEvery: function (callback) { timer = callback; return 1; },
    clearEvery: function () { timer = null; }
  });
  function click(contract) {
    const button = { getAttribute: function () { return contract; }, setAttribute: function () {} };
    listeners.get("click")({ target: { closest: function () { return button; } } });
  }
  return { root, controller, calls, hosts, listeners, click, tick: function () { timer?.(); },
    timer: function () { return timer; }, pairs: function (value) { activePairs = value; } };
}

test("per-pair open, rerender, collapse, automatic removal and teardown release CVD resources", function () {
  const h = harness();
  h.controller.mount(h.root, ["A_USDT", "B_USDT"]);
  assert.equal(h.calls.length, 0);
  h.click("B_USDT");
  assert.match(h.hosts.get("B_USDT").content.innerHTML, /B_USDT/);
  assert.equal(h.hosts.get("A_USDT").content.innerHTML, "");
  h.controller.mount(h.root, ["A_USDT", "B_USDT"]);
  h.tick();
  assert.equal(h.calls.filter(function (call) { return call[0] === "subscribe"; }).length, 1);
  h.listeners.get("change")({ target: {
    value: "4h", matches: function () { return true; },
    closest: function () { return { getAttribute: function () { return "B_USDT"; } }; }
  } });
  assert.match(h.hosts.get("B_USDT").content.innerHTML, /value="4h" selected/);
  assert.doesNotMatch(h.hosts.get("A_USDT").content.innerHTML, /value="4h" selected/);
  h.click("B_USDT");
  assert.equal(h.hosts.get("B_USDT").content.innerHTML, "");
  assert.equal(h.timer(), null);
  h.click("A_USDT");
  h.pairs(["B_USDT"]);
  h.controller.mount(h.root, ["B_USDT"]);
  assert.ok(h.calls.some(function (call) { return call[0] === "unsubscribe" && call[1] === "A_USDT"; }));
  h.controller.dispose();
  assert.equal(h.listeners.size, 0);
  assert.equal(h.timer(), null);
  assert.equal(h.calls.at(-1)[0], "dispose");
  h.controller.dispose();
});

test("CVD transport failure is isolated from radar rendering and pair lifecycle", function () {
  const h = harness(true);
  assert.doesNotThrow(function () {
    h.controller.mount(h.root, ["A_USDT", "B_USDT"]);
    h.click("A_USDT");
    h.controller.mount(h.root, ["A_USDT", "B_USDT"]);
    h.click("A_USDT");
    h.controller.dispose();
  });
  assert.match(h.hosts.get("B_USDT").innerHTML, /CVD \/ Графік/);
});

test("PUMP, EXHAUSTION, SHORT and trade levels are invariant with CVD enabled, disabled and unavailable", function () {
  const now = 1710201600;
  const candles = {};
  for (const [interval, seconds] of Object.entries({ "5m": 300, "15m": 900, "1h": 3600, "4h": 14400 })) {
    candles[interval] = Array.from({ length: 80 }, function (_, index) {
      const close = 100 + index * 0.2 + (index > 75 ? (80 - index) * 0.7 : 0);
      return { t: Math.floor(now / seconds) * seconds - (80 - index) * seconds,
        o: String(close - 0.1), h: String(close + 1), l: String(close - 1), c: String(close), v: String(index > 74 ? 400 : 100) };
    });
  }
  const input = { candles, nowSeconds: now, ticker: { quality: "OK", last: 116, funding: 0.001 },
    fundingIntervalSeconds: 28800 };
  const before = structuredClone(input);
  const baseline = buildMarketData(input);
  const initialState = transitionSignal(null, baseline);
  const store = createCvdStore();
  store.addContract("A_USDT", { startedAt: now * 1000 - 10000 });
  store.status("A_USDT", "AVAILABLE", "Перевірений тестовий адаптер");
  store.ingest({ contract: "A_USDT", id: "1", timestamp: now * 1000 - 5000,
    price: 116, quantity: 1, quoteVolume: 116, direction: "SELL", source: "fixture", quality: "VERIFIED" }, now * 1000);
  for (const state of ["enabled", "disabled", "unavailable"]) {
    if (state === "disabled") store.removeContract("A_USDT");
    if (state === "unavailable") {
      store.addContract("A_USDT", { startedAt: now * 1000 });
      store.status("A_USDT", "UNAVAILABLE", "Немає перевіреного напрямку");
    }
    renderCvdSnapshot(store.snapshot("A_USDT", now * 1000));
    assert.deepEqual(buildMarketData(input), baseline);
    assert.deepEqual(transitionSignal(null, buildMarketData(input)), initialState);
    assert.deepEqual(input, before);
  }
  const app = readFileSync(new URL("../app.mjs", import.meta.url), "utf8");
  const scan = app.slice(app.indexOf("async function scan("), app.indexOf('\ndocument.getElementById("pair-form")'));
  assert.doesNotMatch(scan, /cvd/i);
  for (const file of ["core.mjs", "short-strategy.mjs", "indicator-confirmation.mjs"]) {
    assert.doesNotMatch(readFileSync(new URL("../" + file, import.meta.url), "utf8"), /cvd/i);
  }
});
