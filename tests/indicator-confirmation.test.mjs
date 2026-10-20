import test from "node:test";
import assert from "node:assert/strict";
import { buildMarketData } from "../core.mjs";
import {
  DEFAULT_CONFIRMATION_SETTINGS,
  evaluateShortConfirmation,
  normalizeConfirmationSettings
} from "../indicator-confirmation.mjs";
import { fetchCandles } from "../gate-api.mjs";

function candles(count, nowSeconds, direction) {
  const rows = [];
  let close = 100;
  for (let i = 0; i < count; i += 1) {
    const open = close;
    close *= 1 + (direction === "down" ? -0.008 : direction === "up" ? 0.008 : Math.sin(i) * 0.001);
    rows.push({
      time: nowSeconds - (count - i) * 900,
      open: open,
      high: Math.max(open, close) * 1.004,
      low: Math.min(open, close) * 0.996,
      close: close,
      volume: 10 + i
    });
  }
  return rows;
}

function disabledSettings() {
  return {
    rci: { enabled: false, period: 9 },
    obv: { enabled: false, lookback: 10 },
    ema: { enabled: false, fast: 9, slow: 21 },
    kdj: { enabled: false, period: 9 }
  };
}

test("optional confirmation cannot confirm stale or discontinuous history despite an entry model", function () {
  const now = 1710000000;
  const rows = candles(60, now, "down");
  const model = { state: { key: "entry" } };
  const previous = evaluateShortConfirmation(rows, model, DEFAULT_CONFIRMATION_SETTINGS, now);
  assert.equal(previous.state, "confirmed");
  const stale = evaluateShortConfirmation(rows, model, DEFAULT_CONFIRMATION_SETTINGS, now + 900, previous);
  assert.equal(stale.state, "unavailable");
  const gap = rows.filter(function (_, index) { return index !== 30; });
  assert.equal(evaluateShortConfirmation(gap, model, DEFAULT_CONFIRMATION_SETTINGS, now).state, "unavailable");
});

test("same-timestamp corrected history invalidates cached optional indicator results", function () {
  const now = 1710000000;
  const rows = candles(60, now, "down");
  const model = { state: { key: "entry" } };
  const previous = evaluateShortConfirmation(rows, model, DEFAULT_CONFIRMATION_SETTINGS, now);
  rows.at(-1).close = rows.at(-1).open * 1.05;
  rows.at(-1).high = rows.at(-1).close * 1.01;
  const corrected = evaluateShortConfirmation(rows, model, DEFAULT_CONFIRMATION_SETTINGS, now, previous);
  assert.notEqual(corrected.historySignature, previous.historySignature);
  assert.notEqual(corrected.indicators[0], previous.indicators[0]);
});

test("indicator settings do not alter primary pump or SHORT model output", function () {
  const nowSeconds = 1701000000;
  const rows15 = candles(60, nowSeconds, "up").map(function (candle) {
    return {
      t: candle.time, o: String(candle.open), h: String(candle.high), l: String(candle.low),
      c: String(candle.close), v: String(candle.volume)
    };
  });
  const input = {
    candles: { "5m": [], "15m": rows15, "1h": [], "4h": [] },
    ticker: { quality: "OK", last: Number(rows15[59].c) },
    nowSeconds: nowSeconds
  };
  const before = buildMarketData(input);
  const primarySnapshot = {
    pumpScore: before.pumpScore,
    exhaustionScore: before.exhaustionScore,
    shortScore: before.shortScore,
    state: before.state,
    breakdown: before.breakdown,
    confirmed: before.confirmed,
    levels: before.levels,
    why: before.why
  };
  const closed = before.data.candles15;
  evaluateShortConfirmation(closed, before, DEFAULT_CONFIRMATION_SETTINGS, nowSeconds);
  evaluateShortConfirmation(closed, before, {
    rci: { enabled: true, period: 20 },
    obv: { enabled: false, lookback: 20 },
    ema: { enabled: true, fast: 7, slow: 30 },
    kdj: { enabled: false, period: 20 }
  }, nowSeconds);
  evaluateShortConfirmation(closed, before, disabledSettings(), nowSeconds);
  const after = buildMarketData(input);
  assert.deepEqual({
    pumpScore: after.pumpScore,
    exhaustionScore: after.exhaustionScore,
    shortScore: after.shortScore,
    state: after.state,
    breakdown: after.breakdown,
    confirmed: after.confirmed,
    levels: after.levels,
    why: after.why
  }, primarySnapshot);
});

test("turning off all optional indicators restores baseline-only confirmation behavior", function () {
  const nowSeconds = 1701000000;
  const model = { state: { key: "entry" } };
  const result = evaluateShortConfirmation(candles(40, nowSeconds, "down"), model,
    disabledSettings(), nowSeconds);
  assert.equal(result.state, "disabled");
  assert.equal(result.enabled, 0);
  assert.equal(result.quality, "Вимкнено · базова поведінка радара");
  assert.equal(result.bearish, 0);
});

test("confirmation uses closed candles only", function () {
  const nowSeconds = 1701000000;
  const closed = candles(40, nowSeconds, "down");
  const open = Object.assign({}, closed[closed.length - 1], {
    time: nowSeconds,
    high: closed[closed.length - 1].high * 100,
    close: closed[closed.length - 1].close * 100,
    volume: 1000000
  });
  const baseline = evaluateShortConfirmation(closed, { state: { key: "pump" } },
    DEFAULT_CONFIRMATION_SETTINGS, nowSeconds);
  const withOpen = evaluateShortConfirmation(closed.concat([open]), { state: { key: "pump" } },
    DEFAULT_CONFIRMATION_SETTINGS, nowSeconds);
  assert.deepEqual(withOpen, baseline);
  assert.equal(withOpen.closedCandleTime, closed[closed.length - 1].time);
});

test("changing one setting recalculates that indicator and reuses the other results", function () {
  const nowSeconds = 1701000000;
  const rows = candles(50, nowSeconds, "down");
  const original = evaluateShortConfirmation(rows, { state: { key: "pump" } },
    DEFAULT_CONFIRMATION_SETTINGS, nowSeconds);
  const changed = evaluateShortConfirmation(rows, { state: { key: "pump" } }, {
    rci: { enabled: true, period: 12 },
    obv: DEFAULT_CONFIRMATION_SETTINGS.obv,
    ema: DEFAULT_CONFIRMATION_SETTINGS.ema,
    kdj: DEFAULT_CONFIRMATION_SETTINGS.kdj
  }, nowSeconds, original);
  ["OBV", "EMA", "KDJ"].forEach(function (name) {
    assert.equal(changed.indicators.find(function (item) { return item.key === name; }),
      original.indicators.find(function (item) { return item.key === name; }));
  });
  assert.notEqual(changed.indicators.find(function (item) { return item.key === "RCI"; }),
    original.indicators.find(function (item) { return item.key === "RCI"; }));
});

test("insufficient history and missing OBV volume are reported without throwing", function () {
  const nowSeconds = 1701000000;
  const shortHistory = evaluateShortConfirmation(candles(2, nowSeconds, "up"),
    { state: { key: "pump" } }, DEFAULT_CONFIRMATION_SETTINGS, nowSeconds);
  assert.equal(shortHistory.unavailable.length, 4);
  assert.equal(shortHistory.state, "unavailable");

  const noVolume = candles(40, nowSeconds, "down").map(function (candle) {
    return Object.assign({}, candle, { volume: null });
  });
  const missingObv = evaluateShortConfirmation(noVolume, { state: { key: "pump" } },
    DEFAULT_CONFIRMATION_SETTINGS, nowSeconds);
  assert.deepEqual(missingObv.unavailable, ["OBV"]);
  assert.equal(missingObv.indicators.find(function (item) { return item.key === "OBV"; }).status, "unavailable");
});

test("invalid settings fall back safely and calculation exceptions remain isolated", function () {
  const nowSeconds = 1701000000;
  const normalized = normalizeConfirmationSettings({
    rci: { enabled: true, period: 1000 },
    ema: { enabled: true, fast: 21, slow: 9 }
  });

  assert.equal(normalized.settings.rci.period, DEFAULT_CONFIRMATION_SETTINGS.rci.period);
  assert.ok(normalized.issues.length > 0);
  const result = evaluateShortConfirmation(candles(40, nowSeconds, "down"),
    { state: { key: "pump" } }, normalized.settings, nowSeconds);
  assert.notEqual(result.state, "unavailable");

  const throwingSettings = new Proxy({}, {
    get: function () { throw new Error("settings unavailable"); }
  });
  const failed = evaluateShortConfirmation(candles(40, nowSeconds, "down"),
    { state: { key: "pump" } }, throwingSettings, nowSeconds);
  assert.equal(failed.state, "unavailable");
  assert.match(failed.quality, /базовий радар працює окремо/);
});

test("KDJ configuration supports a 99-candle lookback", function () {
  const normalized = normalizeConfirmationSettings({
    kdj: { period: 99, ma1: 1, ma2: 1 }
  });
  assert.equal(normalized.settings.kdj.period, 99);
  assert.deepEqual(normalized.issues, []);
});

test("an API error rejects only its request and leaves supplemental analysis non-fatal", async function () {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function () { return { ok: false, status: 503 }; };
  try {
    await assert.rejects(fetchCandles("CONFIRMATION_ERROR_TEST_USDT", "15m"), /HTTP 503/);
    const result = evaluateShortConfirmation([], { state: { key: "incomplete" } },
      DEFAULT_CONFIRMATION_SETTINGS, 1701000000);
    assert.equal(result.state, "unavailable");
    assert.equal(result.enabled, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bearish overbought readings cannot confirm SHORT without the base entry", function () {
  const nowSeconds = 1701000000;
  const result = evaluateShortConfirmation(candles(60, nowSeconds, "down"),
    { state: { key: "pump" } }, DEFAULT_CONFIRMATION_SETTINGS, nowSeconds);
  assert.notEqual(result.state, "confirmed");
  assert.ok(result.reasons.some(function (reason) { return reason.includes("Базовий радар"); }));
});
