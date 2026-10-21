import test from "node:test";
import assert from "node:assert/strict";
import { WHALE_COHORT } from "../hyperliquid-cohort.mjs";
import { aggregateWhaleStates, createHyperliquidClient, freshWhaleSnapshot, hyperliquidCoin,
  normalizeWhaleHistory, recordWhaleHistory, whaleHistorySeries } from "../hyperliquid.mjs";

const NOW = 1792582000000;
const A = "0x" + "1".repeat(40);
const B = "0x" + "2".repeat(40);
const C = "0x" + "3".repeat(40);
const state = (address, positions = [], time = NOW) => ({ address,
  data: { time, assetPositions: positions.map(position => ({ position })) } });
const position = (size, entry, notional = 1000000, coin = "BTC") =>
  ({ coin, szi: String(size), entryPx: String(entry), positionValue: String(notional) });
const snapshot = () => aggregateWhaleStates([
  state(A, [position(1, 100)]), state(B, [position(3, 200), position(-2, 300, 1000000, "ETH")])
], [A, B], NOW);

test("fixed public cohort is unique, dated and bounded; mapping never guesses k/1000/HIP-3 aliases", () => {
  assert.equal(WHALE_COHORT.addresses.length, 45);
  assert.equal(new Set(WHALE_COHORT.addresses).size, 45);
  assert.ok(WHALE_COHORT.addresses.every(address => /^0x[0-9a-f]{40}$/.test(address)));
  assert.equal(hyperliquidCoin("BTC_USDT"), "BTC");
  for (const pair of ["AIOT_USDT", "1000PEPE_USDT", "kPEPE_USDT", "xyz:BTC_USDT", "BTC_USDC", "btc_usdt", null]) {
    assert.equal(hyperliquidCoin(pair), null);
  }
});

test("average entry is weighted by base size, not address count or leverage; sides stay separate", () => {
  const value = snapshot();
  assert.equal(value.coins.BTC.long.entry, 175);
  assert.equal(value.coins.BTC.long.count, 2);
  assert.equal(value.coins.BTC.long.quantity, 4);
  assert.equal(value.coins.BTC.short.entry, null);
  assert.equal(value.coins.ETH.short.entry, 300);
  assert.equal(value.checked, 2);
  assert.equal(value.time, NOW / 1000);
});

test("sub-million positions are excluded, equality is included, zero and missing sides are not made into lines", () => {
  const value = aggregateWhaleStates([state(A, [position(2, 200, 999999)]),
    state(B, [position(-3, 300), position(0, 0, 0, "ETH")])], [A, B], NOW);
  assert.equal(value.coins.BTC.long.entry, null);
  assert.equal(value.coins.BTC.short.entry, 300);
  assert.equal(value.coins.ETH, undefined);
  assert.deepEqual(Object.keys(aggregateWhaleStates([state(A)], [A], NOW).coins), []);
});

test("incomplete, duplicate, stale, future or slow cohorts fail closed rather than publish a partial average", () => {
  for (const [states, addresses] of [
    [[state(A)], [A, B]], [[state(A), state(A)], [A, B]], [[state(A), state(C)], [A, B]],
    [[state(A)], [A, A]], [[state(A, [], NOW - 120001)], [A]], [[state(A, [], NOW + 30001)], [A]],
    [[state(A, [], NOW - 70000), state(B)], [A, B]], [[{ address: A, data: {} }], [A]]
  ]) assert.throws(() => aggregateWhaleStates(states, addresses, NOW));
});

test("malformed large positions do not get silently omitted from a misleading mean", () => {
  for (const bad of [{ ...position(1, 100), entryPx: null }, { ...position(1, 100), szi: "" },
    { ...position(1, 100), positionValue: null }, { ...position(1, 100), entryPx: "0x10" }, position(1, -1)]) {
    assert.throws(() => aggregateWhaleStates([state(A, [bad])], [A], NOW));
  }
  assert.throws(() => aggregateWhaleStates([state(A, [position(1, 100), position(2, 100)])], [A], NOW));
});

test("current snapshot expires after 120 seconds; no data is never a zero entry", () => {
  const value = snapshot();
  assert.equal(freshWhaleSnapshot(value, NOW + 120000), true);
  assert.equal(freshWhaleSnapshot(value, NOW + 120001), false);
  assert.equal(freshWhaleSnapshot(null, NOW), false);
});

test("history stores observed USDT equivalents only, requires FX and clears on cohort change", () => {
  const value = snapshot();
  let history = recordWhaleHistory(null, value, ["BTC"], { rate: 1.01 });
  assert.equal(history.coins.BTC[0].long, 176.75);
  assert.equal(history.coins.BTC[0].short, null);
  assert.equal(history.coins.BTC[0].rate, 1.01);
  assert.equal(history.coins.BTC[0].time, value.time);
  history = recordWhaleHistory(history, value, ["BTC"], { rate: 1.01 });
  assert.equal(history.coins.BTC.length, 1);
  assert.throws(() => recordWhaleHistory(history, value, ["BTC"]));
  assert.deepEqual(normalizeWhaleHistory(history, value.time, "different-cohort").coins, {});
  assert.equal(recordWhaleHistory(history, { ...value, time: value.time - 1 }, ["BTC"], { rate: 1 }), history);
});

test("history gaps, missing sides and pre-observation history remain missing, not forward/back filled", () => {
  const time = NOW / 1000;
  const history = { cohortId: WHALE_COHORT.id, coins: { BTC: [
    { time: time - 500, long: 100, short: null, rate: 1 },
    { time: time - 400, long: null, short: 110, rate: 1 },
    { time, long: 120, short: 130, rate: 1 }
  ] } };
  assert.deepEqual(whaleHistorySeries(history, "BTC", "long", [time - 1000, time]), {
    times: [time - 500, time - 400, time - 399, time], values: [100, null, null, 120]
  });
  assert.deepEqual(whaleHistorySeries(history, "BTC", "short", [time - 1000, time - 600]),
    { times: [], values: [] });
  const malformed = { cohortId: WHALE_COHORT.id, coins: { BTC: [
    { time: time + 1, long: 1, short: 2, rate: 1 }, { time: time - 86401, long: 1, short: 2, rate: 1 },
    { time, long: "100", short: 2, rate: 1 }, { time, long: 100, short: 2 }
  ] } };
  assert.deepEqual(normalizeWhaleHistory(malformed, time).coins, {});
});

test("history is bounded at 1440 observations per coin and never invents a period before the first sample", () => {
  const now = NOW / 1000;
  const history = { cohortId: WHALE_COHORT.id, coins: { BTC: Array.from({ length: 2000 }, (_, index) =>
    ({ time: now - 2000 + index, long: 100, short: null, rate: 1 })) } };
  const normalized = normalizeWhaleHistory(history, now);
  assert.equal(normalized.coins.BTC.length, 1440);
  assert.equal(normalized.coins.BTC[0].time, now - 1440);
});

test("client queries official public info, limits concurrency, caches metadata, and requests no credentials", async () => {
  const addresses = Array.from({ length: 9 }, (_, index) => "0x" + String(index + 1).repeat(40));
  let inFlight = 0, maxInFlight = 0, metaCalls = 0, positionCalls = 0;
  const client = createHyperliquidClient({ now: () => NOW, cohort: { id: "test", addresses },
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.hyperliquid.xyz/info");
      assert.deepEqual(Object.keys(options.headers), ["Content-Type"]);
      assert.equal(options.credentials, undefined);
      const request = JSON.parse(options.body);
      if (request.type === "meta") {
        metaCalls++;
        return { ok: true, json: async () => ({ universe: [{ name: "BTC" }, { name: "OLD", isDelisted: true }] }) };
      }
      assert.equal(request.type, "clearinghouseState");
      assert.ok(addresses.includes(request.user));
      positionCalls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setImmediate(resolve));
      inFlight--;
      return { ok: true, json: async () => state(request.user, [position(1, 100)]).data };
    }
  });
  const value = await client.snapshot();
  assert.equal(value.coins.BTC.long.count, 9);
  assert.deepEqual(value.activeCoins, ["BTC"]);
  assert.ok(maxInFlight <= 4);
  await client.snapshot();
  assert.equal(metaCalls, 1);
  assert.equal(positionCalls, 18);
});

test("client isolates HTTP failures, malformed metadata and an aborted request; no partial result escapes", async () => {
  for (const behavior of ["http", "metadata", "partial"]) {
    const client = createHyperliquidClient({ now: () => NOW, cohort: { id: "test", addresses: [A, B] },
      fetchImpl: async (_, options) => {
        const body = JSON.parse(options.body);
        if (behavior === "http" || (behavior === "partial" && body.user === A)) return { ok: false, status: 451 };
        return { ok: true, json: async () => body.type === "meta" ?
          (behavior === "metadata" ? {} : { universe: [{ name: "BTC" }] }) : state(body.user).data };
      }
    });
    await assert.rejects(client.snapshot(), /HTTP 451|перевірити ринки/);
  }
  const controller = new AbortController();
  controller.abort();
  const client = createHyperliquidClient({ fetchImpl: () => assert.fail("Must not fetch after abort") });
  await assert.rejects(client.snapshot({ signal: controller.signal }), { name: "AbortError" });
});

test("client aborts timed-out transport and removes its timer instead of hanging on a missing address", async () => {
  let expire, cleaned = 0;
  const client = createHyperliquidClient({
    setTimer: callback => { expire = callback; return 1; },
    clearTimer: () => { cleaned++; },
    fetchImpl: async (_, options) => new Promise((_, reject) =>
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }))
  });
  const pending = client.snapshot();
  expire();
  await assert.rejects(pending, /12 секунд/);
  assert.equal(cleaned, 1);
});

test("unavailable CORS/network and malformed JSON have Ukrainian explanations", async () => {
  const network = createHyperliquidClient({ fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(network.snapshot(), /Мережевий доступ до Hyperliquid недоступний/);
  const malformed = createHyperliquidClient({ fetchImpl: async () =>
    ({ ok: true, json: async () => { throw new SyntaxError("Unexpected token"); } }) });
  await assert.rejects(malformed.snapshot(), /некоректну JSON-відповідь/);
});
