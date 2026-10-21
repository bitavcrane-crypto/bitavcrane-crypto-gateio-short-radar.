import test from "node:test";
import assert from "node:assert/strict";
import { GATE_CVD_SEMANTICS, normalizeGateTrade, normalizeGateTradeFields, createGateTradeFeed } from "../gate-api.mjs";
import { createCvdStore } from "../cvd.mjs";

const START = 1800000000000;
const raw = (contract = "BTC_USDT", id = "1", timestamp = START) => ({
  contract, id, create_time_ms: String(timestamp), create_time: String(Math.floor(timestamp / 1000)),
  size: "-2", price: "10"
});
const adapter = (row, contract, multiplier, source, now) => {
  const result = normalizeGateTradeFields(row, contract, multiplier, source, now);
  return { trade: result.fields ? {
    ...result.fields, direction: "SELL", quality: "VERIFIED",
    quantity: Math.abs(result.fields.signedSize) * result.fields.multiplier
  } : null, reason: result.reason };
};
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

function harness(options = {}) {
  let clock = START;
  let timerId = 0;
  const timers = new Map();
  const intervals = new Map();
  const sockets = [];
  const requests = [];
  const calls = [];
  const contracts = new Set();
  const store = options.store || {
    addContract(contract, data) { contracts.add(contract); calls.push(["add", contract, data]); },
    removeContract(contract) { contracts.delete(contract); calls.push(["remove", contract]); },
    status(...args) { calls.push(["status", ...args]); },
    resetCoverage(...args) { calls.push(["reset", ...args]); },
    ingest(...args) { calls.push(["ingest", ...args]); }
  };
  class Socket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.handlers = new Map();
      this.sent = [];
      sockets.push(this);
    }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    removeEventListener(name, handler) {
      if (this.handlers.get(name) === handler) this.handlers.delete(name);
    }
    send(value) { this.sent.push(JSON.parse(value)); }
    emit(name, data) { this.handlers.get(name)?.(name === "message" ? { data: JSON.stringify(data) } : {}); }
    open() { this.readyState = 1; this.emit("open"); }
    close() { this.readyState = 3; this.emit("close"); }
    ack(id) {
      this.emit("message", { id, channel: "futures.trades", event: "subscribe", result: { status: "success" } });
    }
    trades(rows) { this.emit("message", { channel: "futures.trades", event: "update", result: rows }); }
  }
  const fetchImpl = options.fetchImpl || (async (url, init) => {
    requests.push({ url, ...init });
    return { ok: true, json: async () => [] };
  });
  const feed = createGateTradeFeed({
    store, WebSocketImpl: Socket, fetchImpl, now: () => clock,
    setTimer: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimer: id => timers.delete(id),
    setEvery: (fn, ms) => { const id = ++timerId; intervals.set(id, { fn, ms }); return id; },
    clearEvery: id => intervals.delete(id),
    ...(options.verified === false ? {} : { semantics: { verified: true }, normalizeTrade: adapter }),
    onChange: options.onChange || (() => {})
  });
  return {
    feed, store, calls, sockets, requests, timers, intervals, contracts,
    advance(ms) { clock += ms; },
    runTimer(ms) {
      const match = [...timers].find(([, timer]) => timer.ms === ms);
      assert.ok(match, "expected timer " + ms);
      timers.delete(match[0]); match[1].fn();
    },
    heartbeat() { [...intervals.values()].forEach(timer => timer.fn()); }
  };
}

test("default semantics fail closed, include provenance, and never access network", () => {
  assert.equal(GATE_CVD_SEMANTICS.verified, false);
  assert.ok(Object.isFrozen(GATE_CVD_SEMANTICS));
  for (const size of ["2", "-2"]) {
    const result = normalizeGateTrade({ ...raw(), size }, "BTC_USDT", 0.1, "WS", START);
    assert.equal(result.trade, null);
    assert.equal(result.state, "UNAVAILABLE");
    assert.equal(result.source, "WS");
    assert.match(result.reason, /не підтверджують напрям/);
    assert.equal("direction" in result.fields, false);
  }
  const h = harness({ verified: false });
  h.feed.subscribe("BTC_USDT", 0.1);
  assert.equal(h.sockets.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.calls.at(-1)[2], "UNAVAILABLE");
  h.feed.dispose();
  const noBypass = createGateTradeFeed({
    store: h.store, semantics: { verified: true },
    WebSocketImpl: class { constructor() { assert.fail("default normalizer must never open a socket"); } },
    fetchImpl: () => assert.fail("default normalizer must never fetch")
  });
  noBypass.subscribe("BTC_USDT", 1);
  noBypass.dispose();
});

test("raw validation is strict, nondirectional and never fabricates IDs", () => {
  const fields = normalizeGateTradeFields(raw(), "BTC_USDT", "0.1", "REST", START).fields;
  assert.equal(fields.quoteVolume, 2);
  assert.equal(fields.timestamp, START);
  assert.equal(fields.signedSize, -2);
  assert.equal("direction" in fields, false);
  for (const change of [
    { id: undefined }, { id: Number.MAX_SAFE_INTEGER + 1 }, { id: "" }, { price: "0x10" },
    { price: " 10" }, { price: Infinity }, { price: 0 }, { size: 0 }, { size: "" },
    { create_time_ms: START + 6000, create_time: undefined },
    { create_time_ms: START + 2000 }, { create_time_ms: "oops" },
    { contract: "ETH_USDT" }, { is_internal: true }, { size: "1e308", price: "1e308" }
  ]) {
    assert.equal(normalizeGateTradeFields({ ...raw(), ...change }, "BTC_USDT", 0.1, "WS", START).fields, null);
  }
  assert.equal(normalizeGateTradeFields(raw(), "BTC_USDT", -1, "WS", START).fields, null);
  assert.equal(normalizeGateTradeFields({ ...raw(), create_time_ms: undefined }, "BTC_USDT", 1, "REST", START).fields.timestamp, START);
});

test("official public REST and WS schema shapes preserve magnitude but prove neither direction nor reconciliation", () => {
  // Schema-shaped synthetic records, not a captured or verified cross-transport match.
  // REST: gate/gateapi-python@759c91c/docs/FuturesTrade.md; WS: gate/gatews@12a935d/go/response_future.go.
  const rest = { id: 101, create_time: START / 1000, create_time_ms: START,
    contract: "BTC_USDT", size: "-2", price: "10" };
  const ws = { id: 101, create_time: START / 1000, create_time_ms: START,
    contract: "BTC_USDT", size: -2, price: "10" };
  for (const [source, row] of [["REST", rest], ["WS", ws]]) {
    const result = normalizeGateTrade(row, "BTC_USDT", "0.001", source, START);
    assert.equal(result.fields.id, "101");
    assert.equal(result.fields.signedSize, -2);
    assert.equal(result.fields.quoteVolume, 0.02);
    assert.equal(result.fields.source, source);
    assert.equal(result.fields.timestamp, START);
    assert.equal("direction" in result.fields, false);
    assert.equal(result.trade, null);
    assert.equal(result.state, "UNAVAILABLE");
  }
});

test("neither order sign nor undocumented side or private maker role enables public aggressor CVD", () => {
  for (const source of ["REST", "WS"]) {
    for (const size of ["2", "-2", "0.25", "-0.25"]) {
      for (const extra of [{}, { side: "buy" }, { side: "sell" },
        { taker_side: "buy" }, { taker_side: "sell" }, { role: "maker" }, { role: "taker" }]) {
        const result = normalizeGateTrade({ ...raw(), size, ...extra }, "BTC_USDT", 0.1, source, START);
        assert.equal(result.fields.signedSize, Number(size));
        assert.equal("direction" in result.fields, false);
        assert.equal(result.trade, null);
        assert.equal(result.state, "UNAVAILABLE");
      }
    }
  }
});

test("apparently matching public REST and WS records cannot enter directional history while semantics are unverified", () => {
  const store = createCvdStore();
  const h = harness({ verified: false, store });
  h.feed.subscribe("BTC_USDT", 0.1);
  for (const source of ["WS", "REST", "WS", "REST"]) {
    const result = normalizeGateTrade(raw("BTC_USDT", "101"), "BTC_USDT", 0.1, source, START);
    assert.equal(result.trade, null);
  }
  const snapshot = store.snapshot("BTC_USDT", START);
  assert.equal(snapshot.state, "UNAVAILABLE");
  assert.equal(snapshot.retainedIds, 0);
  assert.equal(snapshot.lastTradeAt, null);
  for (const frame of Object.values(snapshot.frames)) {
    assert.equal(frame.cvd, null);
    assert.equal(frame.divergence.status, "INSUFFICIENT_DATA");
  }
  assert.equal(h.sockets.length, 0);
  assert.equal(h.requests.length, 0);
  h.feed.dispose();
});

test("unverified subscriptions expose the direction limitation before multiplier metadata arrives", () => {
  const store = createCvdStore();
  const h = harness({ verified: false, store });
  assert.equal(h.feed.subscribe("BTC_USDT"), true);
  const snapshot = store.snapshot("BTC_USDT", START);
  assert.equal(snapshot.multiplier, null);
  assert.equal(snapshot.state, "UNAVAILABLE");
  assert.equal(snapshot.reason, GATE_CVD_SEMANTICS.reason);
  assert.equal(h.feed.subscribe("BTC_USDT", 0.1), false);
  assert.equal(h.feed.status().activeContracts, 1);
  assert.equal(h.sockets.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.timers.size, 0);
  h.feed.dispose();
  const verified = harness();
  assert.equal(verified.feed.subscribe("BTC_USDT"), false);
  assert.equal(verified.feed.subscribe("BTC_USDT", 0), false);
  assert.equal(verified.feed.status().activeContracts, 0);
  assert.equal(verified.sockets.length, 0);
  assert.equal(verified.feed.subscribe("BTC_USDT", 0.1), true);
  assert.equal(verified.sockets.length, 1);
  verified.feed.dispose();
});

test("one shared socket, idempotent subscriptions, exact ACK mapping and pre-ACK drops", async () => {
  const h = harness();
  assert.equal(h.feed.subscribe("BTC_USDT", 0.1), true);
  assert.equal(h.feed.subscribe("BTC_USDT", 0.1), false);
  h.feed.subscribe("ETH_USDT", 1);
  assert.equal(h.sockets.length, 1);
  const socket = h.sockets[0];
  assert.equal(socket.url, "wss://fx-ws.gateio.ws/v4/ws/usdt");
  socket.open();
  assert.deepEqual(socket.sent.map(frame => frame.payload), [["BTC_USDT"], ["ETH_USDT"]]);
  socket.trades([raw()]);
  assert.equal(h.calls.filter(call => call[0] === "ingest").length, 0);
  socket.ack(socket.sent[1].id);
  assert.equal(h.calls.filter(call => call[0] === "reset").at(-1)[1], "ETH_USDT");
  socket.trades([raw(), raw("ETH_USDT")]);
  assert.equal(h.calls.filter(call => call[0] === "ingest").length, 1);
  socket.ack();
  socket.trades([raw(), raw()]);
  assert.equal(h.calls.filter(call => call[0] === "ingest").length, 3);
  await flush();
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests.every(request => request.url.endsWith("&limit=1000")));
  h.feed.dispose();
});

test("id-less ACKs retain original order after an unacknowledged pair is removed", async () => {
  const h = harness();
  h.feed.subscribe("BTC_USDT", 1);
  h.feed.subscribe("ETH_USDT", 1);
  const socket = h.sockets[0];
  socket.open();
  h.feed.unsubscribe("BTC_USDT");
  socket.ack();
  assert.equal(h.calls.filter(call => call[0] === "reset").length, 0);
  socket.ack();
  assert.equal(h.calls.filter(call => call[0] === "reset").at(-1)[1], "ETH_USDT");
  await flush();
  h.feed.dispose();
});

test("snapshots are bounded and sequential; unsubscribe and disposal abort active requests", async () => {
  const requests = [];
  const h = harness({ fetchImpl: (url, init) => new Promise((resolve, reject) => {
    requests.push({ url, ...init, resolve });
    init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }) });
  h.feed.subscribe("BTC_USDT", 1);
  h.feed.subscribe("ETH_USDT", 1);
  const socket = h.sockets[0];
  socket.open(); socket.ack(); socket.ack();
  assert.equal(requests.length, 1);
  h.feed.unsubscribe("BTC_USDT");
  assert.equal(requests[0].signal.aborted, true);
  await flush();
  assert.equal(requests.length, 2);
  h.feed.dispose();
  assert.equal(requests[1].signal.aborted, true);
  await flush();
  assert.equal(h.timers.size, 0);
  assert.equal(h.intervals.size, 0);
  assert.equal(socket.handlers.size, 0);
  assert.equal(h.feed.status().activeContracts, 0);
  assert.equal(h.feed.subscribe("BTC_USDT", 1), false);
});

test("disconnect immediately resets coverage, reconnects once, and ignores stale socket callbacks", async () => {
  const h = harness();
  h.feed.subscribe("BTC_USDT", 1);
  const first = h.sockets[0];
  first.open(); first.ack();
  await flush();
  const staleMessage = first.handlers.get("message");
  h.advance(1000);
  first.close();
  assert.equal(h.calls.at(-1)[2], "DELAYED");
  assert.equal(h.calls.filter(call => call[0] === "reset").length, 2);
  assert.equal(h.timers.size, 1);
  h.runTimer(1000);
  const second = h.sockets[1];
  second.open();
  second.trades([raw()]);
  staleMessage({ data: JSON.stringify({ channel: "futures.trades", event: "update", result: [raw()] }) });
  assert.equal(h.calls.filter(call => call[0] === "ingest").length, 0);
  second.ack();
  await flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.calls.filter(call => call[0] === "reset").length, 3);
  h.feed.dispose();
});

test("injected verified fixture adapter deduplicates synthetic WS/REST IDs without asserting Gate compatibility", async () => {
  const store = createCvdStore();
  let rows = [raw()];
  const h = harness({ store, fetchImpl: async () => ({ ok: true, json: async () => rows }) });
  h.feed.subscribe("BTC_USDT", 1);
  const first = h.sockets[0];
  first.open(); first.ack();
  first.trades([raw(), raw()]);
  await flush();
  let snapshot = store.snapshot("BTC_USDT", START);
  assert.equal(snapshot.duplicateCount, 2);
  h.advance(1000);
  first.trades([raw("BTC_USDT", "3", START + 1000), raw("BTC_USDT", "2", START + 500)]);
  snapshot = store.snapshot("BTC_USDT", START + 1000);
  assert.equal(snapshot.duplicateCount, 2);
  first.close();
  h.advance(1000);
  h.runTimer(1000);
  const second = h.sockets[1];
  second.open(); second.ack();
  rows = [raw(), raw("BTC_USDT", "4", START + 2000)];
  await flush();
  snapshot = store.snapshot("BTC_USDT", START + 2000);
  assert.equal(snapshot.startedAt, START + 2000);
  assert.ok(snapshot.rejectedCount >= 1);
  h.feed.dispose();
});

test("heartbeat freshness is separate from trades; silent socket reconnects, callback errors are isolated", async () => {
  const h = harness({ onChange: () => { throw new Error("render failed"); } });
  h.feed.subscribe("BTC_USDT", 1);
  const socket = h.sockets[0];
  socket.open(); socket.ack();
  await flush();
  h.advance(15000); h.heartbeat();
  assert.equal(socket.sent.at(-1).channel, "futures.ping");
  socket.emit("message", { channel: "futures.pong" });
  h.advance(30000); h.heartbeat();
  assert.equal(socket.readyState, 1);
  h.advance(15000); h.heartbeat();
  assert.equal(socket.readyState, 3);
  assert.equal(h.calls.at(-1)[2], "DELAYED");
  h.feed.dispose();
});

test("malformed frames and subscription errors cannot escape and reset coverage", () => {
  for (const payload of ["{", JSON.stringify({ channel: "futures.trades", event: "update", result: null }),
    JSON.stringify({ channel: "futures.trades", event: "subscribe", result: { status: "fail" } })]) {
    const h = harness();
    h.feed.subscribe("BTC_USDT", 1);
    const socket = h.sockets[0];
    socket.open();
    assert.doesNotThrow(() => socket.handlers.get("message")({ data: payload }));
    assert.equal(h.calls.at(-1)[2], "DELAYED");
    assert.equal(h.timers.size, 1);
    h.feed.dispose();
  }
});

test("reconnection backoff is single, exponential, capped, and cancelled on final unsubscribe", () => {
  const h = harness();
  h.feed.subscribe("BTC_USDT", 1);
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    h.sockets.at(-1).close();
    assert.equal(h.timers.size, 1);
    h.runTimer(delay);
  }
  h.sockets.at(-1).close();
  h.feed.unsubscribe("BTC_USDT");
  assert.equal(h.timers.size, 0);
  assert.equal(h.intervals.size, 0);
  h.feed.dispose();
});

test("a socket stuck connecting is timed out and cleaned up", () => {
  const h = harness();
  h.feed.subscribe("BTC_USDT", 1);
  const socket = h.sockets[0];
  h.advance(15000);
  h.runTimer(15000);
  assert.equal(socket.readyState, 3);
  assert.equal(h.calls.at(-1)[2], "DELAYED");
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timers.size, 1);
  h.feed.dispose();
});

test("missing ACK times out even with heartbeat messages and pair toggle tombstones", async () => {
  const h = harness();
  h.feed.subscribe("BTC_USDT", 1);
  const socket = h.sockets[0];
  socket.open(); socket.ack();
  await flush();
  h.feed.subscribe("ETH_USDT", 1);
  for (let i = 0; i < 20; i += 1) {
    h.feed.unsubscribe("ETH_USDT");
    h.feed.subscribe("ETH_USDT", 1);
    socket.emit("message", { channel: "futures.pong" });
  }
  assert.equal(h.feed.status().pendingSubscriptions, 21);
  assert.equal(h.timers.size, 1, "one ACK watchdog covers all subscription batches");
  h.advance(15000);
  h.runTimer(15000);
  assert.equal(socket.readyState, 3);
  assert.equal(h.feed.status().pendingSubscriptions, 0);
  assert.equal(h.calls.at(-1)[2], "DELAYED");
  assert.equal(h.timers.size, 1, "only the reconnect timer remains");
  h.feed.dispose();
  assert.equal(h.timers.size, 0);
});

test("ACK rearming retains the oldest remaining batch deadline rather than extending its wait", async () => {
  const h = harness();
  h.feed.subscribe("BTC_USDT", 1);
  h.feed.subscribe("ETH_USDT", 1);
  const socket = h.sockets[0];
  socket.open();
  h.advance(5000);
  socket.ack(socket.sent[1].id);
  await flush();
  assert.deepEqual([...h.timers.values()].map(timer => timer.ms), [10000]);
  h.advance(10000);
  h.runTimer(10000);
  assert.equal(socket.readyState, 3);
  h.feed.dispose();
});

test("successful trades do not notify the UI for every trade; lifecycle notifications identify the pair", async () => {
  const changes = [];
  const h = harness({ onChange: contract => changes.push(contract) });
  h.feed.subscribe("BTC_USDT", 1);
  const socket = h.sockets[0];
  socket.open(); socket.ack();
  await flush();
  const count = changes.length;
  socket.trades(Array.from({ length: 100 }, (_, i) => raw("BTC_USDT", String(i + 1))));
  assert.equal(changes.length, count);
  assert.ok(changes.every(contract => contract === "BTC_USDT"));
  h.feed.dispose();
  assert.equal(h.timers.size, 0);
});

test("REST timeout aborts at 15 seconds and malformed snapshots fail without throwing", async () => {
  let signal;
  const h = harness({ fetchImpl: (url, init) => new Promise((resolve, reject) => {
    signal = init.signal;
    signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
  }) });
  h.feed.subscribe("BTC_USDT", 1);
  h.sockets[0].open(); h.sockets[0].ack();
  h.runTimer(15000);
  assert.equal(signal.aborted, true);
  await flush();
  h.feed.dispose();
  for (const rows of [{ error: "invalid" }, Array.from({ length: 1001 }, () => raw())]) {
    const bad = harness({ fetchImpl: async () => ({ ok: true, json: async () => rows }) });
    bad.feed.subscribe("BTC_USDT", 1);
    bad.sockets[0].open(); bad.sockets[0].ack();
    await flush();
    assert.equal(bad.calls.at(-1)[2], "DELAYED");
    assert.equal(bad.calls.filter(call => call[0] === "ingest").length, 0);
    bad.feed.dispose();
  }
});
