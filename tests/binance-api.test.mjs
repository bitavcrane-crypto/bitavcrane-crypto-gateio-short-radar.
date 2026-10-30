import test from "node:test";
import assert from "node:assert/strict";
import {
  clearBinanceExchangeInfoCache,
  createBinanceTradeFeed,
  gateContractToBinanceSymbol,
  normalizeBinanceAggregateTrade,
  resolveBinanceUsdMPerpetualSymbol
} from "../binance-api.mjs";
import { createCvdStore } from "../cvd.mjs";

const NOW = 1800000000000;

function info(symbols = ["BTCUSDT", "ETHUSDT"]) {
  return {
    symbols: symbols.map(function (symbol) {
      return { symbol, status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT", marginAsset: "USDT" };
    })
  };
}

function raw(fields = {}) {
  return { e: "aggTrade", s: "BTCUSDT", a: 123, p: "100", q: "2", T: NOW, m: false, ...fields };
}

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }

  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }

  emit(type, event = {}) {
    for (const callback of this.listeners.get(type) || []) callback(event);
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  message(value) {
    this.emit("message", { data: JSON.stringify(value) });
  }

  close() {
    this.readyState = 3;
  }
}

function timers() {
  let next = 0;
  const pending = new Map();
  return {
    setTimer(callback, delay) {
      const id = ++next;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) { pending.delete(id); },
    pending
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

test("Gate USDT pairs map only to exact uppercase Binance symbol candidates", () => {
  assert.equal(gateContractToBinanceSymbol("BTC_USDT"), "BTCUSDT");
  assert.equal(gateContractToBinanceSymbol("1000PEPE_USDT"), "1000PEPEUSDT");
  for (const contract of ["btc_USDT", "BTC_USD", "BTCUSDT", "BTC_USDT_PERP", "../BTC_USDT", null]) {
    assert.equal(gateContractToBinanceSymbol(contract), null);
  }
});

test("only active USDⓈ-M USDT perpetual metadata validates a symbol mapping", () => {
  const base = info(["BTCUSDT"]);
  assert.equal(resolveBinanceUsdMPerpetualSymbol("BTC_USDT", base), "BTCUSDT");
  for (const changes of [
    { status: "BREAK" }, { contractType: "CURRENT_QUARTER" },
    { quoteAsset: "BUSD" }, { marginAsset: "BTC" }
  ]) {
    assert.equal(resolveBinanceUsdMPerpetualSymbol("BTC_USDT", {
      symbols: [{ ...base.symbols[0], ...changes }]
    }), null);
  }
  assert.equal(resolveBinanceUsdMPerpetualSymbol("ETH_USDT", base), null);
});

test("Binance aggTrade buyer-maker flag yields documented aggressor direction and USDT notional", () => {
  const buy = normalizeBinanceAggregateTrade(raw(), "BTC_USDT", "BTCUSDT", NOW);
  const sell = normalizeBinanceAggregateTrade(raw({ a: "124", m: true }), "BTC_USDT", "BTCUSDT", NOW);
  assert.deepEqual(
    [buy.trade.direction, buy.trade.quoteVolume, buy.trade.id, buy.trade.source, buy.trade.quality],
    ["BUY", 200, "BTCUSDT:123", "BINANCE_USDM_AGGTRADE", "VERIFIED"]
  );
  assert.deepEqual([sell.trade.direction, sell.trade.quoteVolume], ["SELL", 200]);
});

test("invalid, mismatched, coin-margined, future, or unlabelled trades fail closed", () => {
  const cases = [
    [{ s: "ETHUSDT" }, "wrong symbol"],
    [{ e: "trade" }, "wrong event"],
    [{ st: 2 }, "coin margined"],
    [{ a: "bad" }, "bad id"],
    [{ p: "0" }, "bad price"],
    [{ q: "-1" }, "bad quantity"],
    [{ T: NOW + 5001 }, "future"],
    [{ m: "false" }, "unlabelled"],
    [{ m: undefined }, "missing side"]
  ];
  for (const [fields, label] of cases) {
    const result = normalizeBinanceAggregateTrade(raw(fields), "BTC_USDT", "BTCUSDT", NOW);
    assert.equal(result.trade, null, label);
    assert.ok(result.reason, label);
  }
});

test("one read-only public socket multiplexes validated symbols and ingests independent CVD histories", async () => {
  clearBinanceExchangeInfoCache();
  FakeWebSocket.instances = [];
  let clock = NOW;
  let fetches = 0;
  const store = createCvdStore();
  const timeouts = timers();
  const feed = createBinanceTradeFeed({
    store,
    WebSocketImpl: FakeWebSocket,
    fetchImpl: async function (url) {
      fetches += 1;
      assert.match(url, /\/fapi\/v1\/exchangeInfo$/);
      return { ok: true, json: async () => info() };
    },
    now: () => clock,
    setTimer: timeouts.setTimer,
    clearTimer: timeouts.clearTimer
  });

  assert.equal(feed.subscribe("BTC_USDT", "BTCUSDT"), true);
  assert.equal(feed.subscribe("ETH_USDT", "ETHUSDT"), true);
  assert.equal(feed.subscribe("NOTLISTED_USDT", "NOTLISTEDUSDT"), true);
  await flush();
  assert.equal(fetches, 1);
  assert.equal(FakeWebSocket.instances.length, 1);
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, "wss://fstream.binance.com/market/stream");
  socket.open();
  assert.deepEqual(socket.sent[0], {
    method: "SUBSCRIBE", params: ["btcusdt@aggTrade", "ethusdt@aggTrade"], id: 1
  });
  socket.message({ id: 1, result: null });

  clock += 1000;
  socket.message(raw({ T: clock }));
  socket.message(raw({ a: 124, T: clock, m: true }));
  socket.message(raw({ s: "ETHUSDT", a: 7, T: clock, p: "50", q: "4", m: false }));
  const btc = store.snapshot("BTC_USDT", clock);
  const eth = store.snapshot("ETH_USDT", clock);
  assert.equal(btc.state, "AVAILABLE");
  assert.equal(btc.frames["15m"].provisional.bar.buyVolume, 200);
  assert.equal(btc.frames["15m"].provisional.bar.sellVolume, 200);
  assert.equal(btc.frames["15m"].provisional.bar.sampleCount, 2);
  assert.equal(eth.frames["15m"].provisional.bar.buyVolume, 200);
  assert.equal(eth.frames["15m"].provisional.bar.sampleCount, 1);
  assert.equal(store.snapshot("NOTLISTED_USDT", clock).state, "UNAVAILABLE");

  clock += 1000;
  socket.emit("close");
  assert.equal(store.snapshot("BTC_USDT", clock).state, "DELAYED");
  assert.equal(store.snapshot("BTC_USDT", clock).frames["15m"].provisional, null);
  assert.equal(store.snapshot("NOTLISTED_USDT", clock).state, "UNAVAILABLE");
  assert.equal(feed.status().activeContracts, 3);
  feed.dispose();
  assert.equal(feed.status().activeContracts, 0);
  assert.equal(FakeWebSocket.instances[0].readyState, 3);
  clearBinanceExchangeInfoCache();
});

test("unsupported contracts and failed Binance metadata never open a trade stream", async () => {
  clearBinanceExchangeInfoCache();
  FakeWebSocket.instances = [];
  let clock = NOW;
  const store = createCvdStore();
  const failed = createBinanceTradeFeed({
    store,
    WebSocketImpl: FakeWebSocket,
    fetchImpl: async () => ({ ok: false, status: 503 }),
    now: () => clock,
    ...timers()
  });
  failed.subscribe("BTC_USDT");
  await flush();
  assert.equal(store.snapshot("BTC_USDT", clock).state, "UNAVAILABLE");
  assert.equal(FakeWebSocket.instances.length, 0);
  failed.dispose();

  clearBinanceExchangeInfoCache();
  clock += 1;
  const unsupportedStore = createCvdStore();
  const unsupported = createBinanceTradeFeed({
    store: unsupportedStore,
    WebSocketImpl: FakeWebSocket,
    fetchImpl: async () => ({ ok: true, json: async () => info(["BTCUSDT"]) }),
    now: () => clock,
    ...timers()
  });
  unsupported.subscribe("NOTLISTED_USDT");
  await flush();
  const snapshot = unsupportedStore.snapshot("NOTLISTED_USDT", clock);
  assert.equal(snapshot.state, "UNAVAILABLE");
  assert.match(snapshot.reason, /немає активного/);
  assert.equal(FakeWebSocket.instances.length, 0);
  unsupported.dispose();
  clearBinanceExchangeInfoCache();
});
