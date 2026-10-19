import test from "node:test";
import assert from "node:assert/strict";
import { clearCache, fetchCandles, fetchVisualizationCandles } from "../gate-api.mjs";

test("visualization candle requests use the requested USDT contract and interval with 600 bars", async function (context) {
  clearCache();
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async function (url) {
    urls.push(new URL(url));
    return { ok: true, json: async function () { return [{ t: 1700000000, o: "1", h: "2", l: "1", c: "2", v: "3" }]; } };
  };
  context.after(function () {
    globalThis.fetch = originalFetch;
    clearCache();
  });

  await fetchVisualizationCandles("BTC_USDT", "5m");
  await fetchVisualizationCandles("ETH_USDT", "1h");
  assert.equal(urls.length, 2);
  assert.equal(urls[0].pathname, "/api/v4/futures/usdt/candlesticks");
  assert.equal(urls[0].searchParams.get("contract"), "BTC_USDT");
  assert.equal(urls[0].searchParams.get("interval"), "5m");
  assert.equal(urls[0].searchParams.get("limit"), "600");
  assert.equal(urls[1].searchParams.get("contract"), "ETH_USDT");
  assert.equal(urls[1].searchParams.get("interval"), "1h");
  assert.equal(urls[1].searchParams.get("limit"), "600");
});

test("radar candle requests retain their original limit and are not reused as visual history", async function (context) {
  clearCache();
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async function (url) {
    urls.push(new URL(url));
    return { ok: true, json: async function () { return []; } };
  };
  context.after(function () {
    globalThis.fetch = originalFetch;
    clearCache();
  });

  await fetchCandles("BTC_USDT", "15m");
  await fetchVisualizationCandles("BTC_USDT", "15m");
  assert.equal(urls.length, 2);
  assert.equal(urls[0].searchParams.get("limit"), "80");
  assert.equal(urls[1].searchParams.get("limit"), "600");
});

test("visualization candle API failures are surfaced to callers", async function (context) {
  clearCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function () { return { ok: false, status: 503 }; };
  context.after(function () {
    globalThis.fetch = originalFetch;
    clearCache();
  });
  await assert.rejects(fetchVisualizationCandles("SOL_USDT", "4h"), /HTTP 503/);
});
