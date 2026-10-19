import test from "node:test";
import assert from "node:assert/strict";
import {
  clearCache, fetchCandles, fetchContractStats, fetchOrderBook, fetchTickers, fetchVisualizationCandles, normalizeContract,
  normalizeOrderBook, normalizeTicker, normalizeContractStats
} from "../gate-api.mjs";

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

test("order book requests use the futures contract and normalize executable depth", async function (context) {
  clearCache();
  const originalFetch = globalThis.fetch;
  let requested;
  globalThis.fetch = async function (url) {
    requested = new URL(url);
    return {
      ok: true,
      json: async function () {
        return { bids: [{ p: "99.9", s: "100" }], asks: [["100.1", "100"]], update: 1, current: Date.now() / 1000 };
      }
    };
  };
  context.after(function () {
    globalThis.fetch = originalFetch;
    clearCache();
  });
  const beforeRequest = Date.now();
  const rawBook = await fetchOrderBook("BTC_USDT");
  const afterRequest = Date.now();
  const book = normalizeOrderBook(rawBook, 0.01, 12345);
  assert.equal(requested.pathname, "/api/v4/futures/usdt/order_book");
  assert.equal(requested.searchParams.get("contract"), "BTC_USDT");
  assert.equal(requested.searchParams.get("limit"), "20");
  assert.equal(book.quality, "OK");
  assert.ok(book.spreadPercent > 0);
  assert.equal(book.depthUsd, 99.9);
  assert.equal(book.slippagePercent, null);
  assert.ok(book.fetchedAt >= beforeRequest && book.fetchedAt <= afterRequest);
  assert.equal(normalizeOrderBook(rawBook, null, 12345).quality, "INCOMPLETE");
  const deepBook = normalizeOrderBook({
    bids: [{ p: "99.9", s: "10000" }], asks: [{ p: "100.1", s: "10000" }], current: 12.345
  }, 0.01, 12345);
  assert.equal(deepBook.slippagePercent, 0);
  assert.equal(normalizeContract({ name: "BTC_USDT", status: "trading", quanto_multiplier: "0.01" }).quantoMultiplier, 0.01);
});

test("cached snapshots retain their actual receipt time instead of becoming fresh on normalization", async function (context) {
  clearCache();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1710000000000;
  Date.now = function () { return now; };
  let requests = 0;
  globalThis.fetch = async function (url) {
    requests += 1;
    return { ok: true, json: async function () {
      return url.includes("tickers") ?
        [{ contract: "Q_USDT", last: "0.12214", volume_24h_quote: "2000000", funding_rate: "-0.000846" }] :
        { bids: [{ p: "0.1221", s: "1000000" }], asks: [{ p: "0.1222", s: "1000000" }], current: now / 1000 };
    } };
  };
  context.after(function () {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    clearCache();
  });
  const tickers = await fetchTickers();
  await fetchOrderBook("Q_USDT");
  now += 10000;
  const cachedBook = await fetchOrderBook("Q_USDT");
  const cachedTickers = await fetchTickers();
  assert.equal(requests, 2);
  assert.equal(normalizeOrderBook(cachedBook, 1, now).fetchedAt, 1710000000000);
  assert.equal(normalizeTicker(cachedTickers[0], "Q_USDT").fetchedAt, 1710000000000);
  assert.equal(normalizeTicker(tickers[0], "Q_USDT").funding, -0.000846);
});

test("statistics request enough five-minute snapshots for both ends of the last closed 4h interval", async function (context) {
  clearCache();
  const originalFetch = globalThis.fetch;
  let url;
  globalThis.fetch = async function (requested) {
    url = new URL(requested);
    return { ok: true, json: async function () { return []; } };
  };
  context.after(function () { globalThis.fetch = originalFetch; clearCache(); });
  await fetchContractStats("Q_USDT");
  assert.equal(url.searchParams.get("interval"), "5m");
  assert.equal(url.searchParams.get("limit"), "100");
  assert.ok((100 - 1) * 300 >= 2 * 14400);
});

test("malformed and overflowing depth never becomes a trusted order book", function () {
  const book = {
    bids: [{ p: "99.9", s: "10000" }, { p: "NaN", s: "Infinity" }],
    asks: [{ p: "100.1", s: "10000" }]
  };
  assert.equal(normalizeOrderBook(book, 1).quality, "SUSPECT");
  const overflow = normalizeOrderBook({
    bids: [{ p: "99.9", s: "1e308" }], asks: [{ p: "100.1", s: "1e308" }]
  }, 1);
  assert.equal(overflow.quality, "SUSPECT");
  assert.equal(overflow.depthUsd, null);
});

test("numeric parsing rejects coerced booleans, containers and whitespace without inventing zero", function () {
  [false, true, [], {}, " ", "NaN", "Infinity", null].forEach(function (value) {
    const ticker = normalizeTicker({ contract: "Q_USDT", last: value, funding_rate: value }, "Q_USDT");
    assert.equal(ticker.last, null);
    assert.equal(ticker.funding, null);
    const stats = normalizeContractStats([{ time: 1710000000, long_liq_usd: value }], 1710000000);
    assert.equal(stats.rows[0].longLiquidationUsd, null);
  });
  assert.equal(normalizeContractStats([{ time: 1710000000, long_liq_usd: "0" }], 1710000000).rows[0].longLiquidationUsd, 0);
});

test("Gate top trader long and short OI fields are normalized independently in contracts", function () {
  const stats = normalizeContractStats([{
    time: 1710000000,
    open_interest: "1000",
    top_long_size: "600",
    top_short_size: "400",
    top_lsr_size: "1.5",
    lsr_account: "2"
  }], 1710000000);
  assert.equal(stats.rows[0].topLongOpenInterest, 600);
  assert.equal(stats.rows[0].topShortOpenInterest, 400);
  assert.equal(stats.rows[0].openInterest, 1000);
  assert.equal(stats.rows[0].topLsrSize, 1.5);
  assert.equal(stats.rows[0].lsrAccount, 2);

  const absent = normalizeContractStats([{ time: 1710000000, open_interest: "1000" }], 1710000000);
  assert.equal(absent.rows[0].topLongOpenInterest, null);
  assert.equal(absent.rows[0].topShortOpenInterest, null);
  const malformedVisualizationFields = normalizeContractStats([{
    time: 1710000000,
    open_interest: "1000",
    top_long_size: "-1",
    top_short_size: "NaN"
  }], 1710000000);
  assert.equal(malformedVisualizationFields.quality, "OK");
  assert.equal(malformedVisualizationFields.rows[0].topLongOpenInterest, null);
  assert.equal(malformedVisualizationFields.rows[0].topShortOpenInterest, null);
});

test("book freshness uses response generation time, not last change time or fresh receipt", function () {
  const now = 1710000000000;
  const book = { bids: [{ p: "99.9", s: "10000" }], asks: [{ p: "100.1", s: "10000" }], update: 1 };
  assert.equal(normalizeOrderBook(book, 1, now).quality, "INCOMPLETE");
  book.current = now / 1000 - 31;
  assert.equal(normalizeOrderBook(book, 1, now).quality, "STALE");
  book.current = now / 1000 - 30;
  assert.equal(normalizeOrderBook(book, 1, now).quality, "OK");
  book.current = now / 1000 + 6;
  assert.equal(normalizeOrderBook(book, 1, now).quality, "SUSPECT");
  book.current = now / 1000;
  const normalized = normalizeOrderBook(book, 1, now);
  assert.equal(normalized.quality, "OK");
  assert.equal(normalized.bidDepthUsd, 999000);
  assert.equal(normalized.askDepthUsd, 1001000);
  assert.equal(normalized.depthUsd, 999000);
  assert.equal(normalized.depthWindowPercent, 0.5);
  assert.equal(normalized.executionNotionalUsd, 1000);
});

test("undocumented liquidation aliases never substitute for missing directional data", function () {
  const stats = normalizeContractStats([{
    time: 1710000000, long_liq_usd_new: "0", short_liq_usd_new: "0"
  }], 1710000000);
  assert.equal(stats.rows[0].longLiquidationUsd, null);
  assert.equal(stats.rows[0].shortLiquidationUsd, null);
});

test("HTTP rate limits, malformed JSON and partial schemas fail without successful caching", async function (context) {
  const originalFetch = globalThis.fetch;
  context.after(function () { globalThis.fetch = originalFetch; clearCache(); });
  clearCache();
  globalThis.fetch = async function () { return { ok: false, status: 429 }; };
  await assert.rejects(fetchContractStats("Q_USDT"), /HTTP 429/);
  globalThis.fetch = async function () {
    return { ok: true, json: async function () { throw new SyntaxError("malformed JSON"); } };
  };
  await assert.rejects(fetchContractStats("Q_USDT"), /malformed JSON/);
  globalThis.fetch = async function () { return { ok: true, json: async function () { return { label: "error" }; } }; };
  await assert.rejects(fetchContractStats("Q_USDT"), /Некоректна статистика/);
});
