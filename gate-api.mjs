const API_ROOT = "https://api.gateio.ws/api/v4";
const CACHE_MS = 15000;
const VISUALIZATION_CANDLE_LIMIT = 600;
const cache = new Map();
const receivedAt = new WeakMap();

function numeric(value) {
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && !value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

async function request(path, cacheMs, signal) {
  if (signal) signal.throwIfAborted();
  const now = Date.now();
  const cached = cache.get(path);
  if (cached && now - cached.time < cacheMs) return cached.value;
  const response = await fetch(API_ROOT + path, {
    headers: { Accept: "application/json" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error("Gate.io відповів HTTP " + response.status);
  const data = await response.json();
  if (signal) signal.throwIfAborted();
  const time = Date.now();
  if (data && typeof data === "object") {
    receivedAt.set(data, time);
    if (Array.isArray(data)) data.forEach(function (row) {
      if (row && typeof row === "object") receivedAt.set(row, time);
    });
  }
  cache.set(path, { time: time, value: data });
  return data;
}

export async function fetchContracts() {
  const rows = await request("/futures/usdt/contracts", 60000);
  if (!Array.isArray(rows)) throw new Error("Некоректний список контрактів Gate.io");
  return rows;
}

export async function fetchTickers() {
  const rows = await request("/futures/usdt/tickers", CACHE_MS);
  if (!Array.isArray(rows)) throw new Error("Некоректні ticker-дані Gate.io");
  return rows;
}

export async function fetchCandles(contract, interval) {
  return fetchCandlesWithLimit(contract, interval, 80);
}

export async function fetchVisualizationCandles(contract, interval, signal) {
  return fetchCandlesWithLimit(contract, interval, VISUALIZATION_CANDLE_LIMIT, signal);
}

async function fetchCandlesWithLimit(contract, interval, limit, signal) {
  const query = "?contract=" + encodeURIComponent(contract) + "&interval=" + encodeURIComponent(interval) + "&limit=" + limit;
  const rows = await request("/futures/usdt/candlesticks" + query, CACHE_MS, signal);
  if (!Array.isArray(rows)) throw new Error("Некоректні свічки " + contract + " " + interval);
  return rows;
}

export async function fetchContractStats(contract, signal) {
  const query = "?contract=" + encodeURIComponent(contract) + "&interval=5m&limit=100";
  const rows = await request("/futures/usdt/contract_stats" + query, CACHE_MS, signal);
  if (!Array.isArray(rows)) throw new Error("Некоректна статистика " + contract);
  return rows;
}

export async function fetchOrderBook(contract) {
  const query = "?contract=" + encodeURIComponent(contract) + "&limit=20&with_id=true";
  const book = await request("/futures/usdt/order_book" + query, CACHE_MS);
  if (!book || typeof book !== "object" || Array.isArray(book)) {
    throw new Error("Некоректна книга заявок " + contract);
  }
  return book;
}

export function normalizeTicker(row, contract) {
  if (!row || row.contract !== contract) {
    return { quality: "CONFLICT", last: null, mark: null, index: null, funding: null, volume24h: null };
  }
  const numberField = function (name, allowZero) {
    const result = numeric(row[name]);
    return result !== null && (allowZero ? result >= 0 : result > 0) ? result : null;
  };
  const funding = numeric(row.funding_rate);
  return {
    quality: "OK",
    last: numberField("last"),
    mark: numberField("mark_price"),
    index: numberField("index_price"),
    funding: funding,
    volume24h: numberField("volume_24h_quote", true),
    fetchedAt: receivedAt.get(row) || Date.now()
  };
}

export function normalizeContract(row) {
  if (!row || typeof row.name !== "string") return null;
  const interval = numeric(row.funding_interval);
  const takerFeeRate = numeric(row.taker_fee_rate);
  return {
    name: row.name,
    active: typeof row.status === "string" && row.status.toLowerCase() === "trading",
    fundingIntervalSeconds: interval !== null && interval > 0 ? interval : null,
    takerFeeRate: takerFeeRate !== null && takerFeeRate >= 0 && takerFeeRate < 1 ? takerFeeRate : null,
    quantoMultiplier: numeric(row.quanto_multiplier) > 0 ? numeric(row.quanto_multiplier) : null
  };
}

export function normalizeOrderBook(book, contractMultiplier, fetchedAtMs) {
  const fetchedAt = receivedAt.get(book) || fetchedAtMs || Date.now();
  const generatedAt = numeric(book && book.current);
  const timestampQuality = generatedAt === null && book && book.current === undefined ? "INCOMPLETE" :
    generatedAt === null || generatedAt <= 0 || generatedAt > fetchedAt / 1000 + 5 ? "SUSPECT" :
      fetchedAt / 1000 - generatedAt > 30 ? "STALE" : null;
  let invalidLevels = false;
  const levels = function (items, isBid) {
    if (!Array.isArray(items)) return [];
    return items.map(function (level) {
      const price = numeric(Array.isArray(level) ? level[0] : level && level.p);
      const size = numeric(Array.isArray(level) ? level[1] : level && level.s);
      if (price === null || price <= 0 || size === null || size <= 0) {
        invalidLevels = true;
        return null;
      }
      return { price: price, size: size, bid: isBid };
    }).filter(Boolean);
  };
  const bids = levels(book && book.bids, true).sort(function (a, b) { return b.price - a.price; });
  const asks = levels(book && book.asks, false).sort(function (a, b) { return a.price - b.price; });
  const multiplier = numeric(contractMultiplier);
  if (!bids.length || !asks.length || multiplier === null || multiplier <= 0) {
    return { quality: "INCOMPLETE", bestBid: null, bestAsk: null, spreadPercent: null, depthUsd: null, fetchedAt: fetchedAt };
  }
  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  if (bestAsk <= bestBid) {
    return { quality: "SUSPECT", bestBid: bestBid, bestAsk: bestAsk, spreadPercent: null, depthUsd: null, fetchedAt: fetchedAt };
  }
  const midpoint = (bestBid + bestAsk) / 2;
  const depthWithinHalfPercent = function (items) {
    return items.reduce(function (sum, level) {
      if (Math.abs(level.price / midpoint - 1) > 0.005) return sum;
      return sum + level.price * level.size * multiplier;
    }, 0);
  };
  const estimateSlippage = function (items) {
    const targetUsd = 1000;
    let remainingBase = targetUsd / items[0].price;
    let filledBase = 0;
    let value = 0;
    items.forEach(function (level) {
      const availableBase = level.size * multiplier;
      const fillBase = Math.min(remainingBase, availableBase);
      filledBase += fillBase;
      value += fillBase * level.price;
      remainingBase -= fillBase;
    });
    if (remainingBase > 0 || filledBase === 0) return null;
    const vwap = value / filledBase;
    return Math.abs(vwap / items[0].price - 1) * 100;
  };
  const bidDepth = depthWithinHalfPercent(bids);
  const askDepth = depthWithinHalfPercent(asks);
  const bidSlippage = estimateSlippage(bids);
  const askSlippage = estimateSlippage(asks);
  const spreadPercent = (bestAsk / bestBid - 1) * 100;
  const depthUsd = Math.min(bidDepth, askDepth);
  return {
    quality: invalidLevels || !Number.isFinite(spreadPercent) || !Number.isFinite(depthUsd) ?
      "SUSPECT" : timestampQuality || "OK",
    bestBid: bestBid,
    bestAsk: bestAsk,
    spreadPercent: Number.isFinite(spreadPercent) ? spreadPercent : null,
    depthUsd: Number.isFinite(depthUsd) ? depthUsd : null,
    slippagePercent: bidSlippage === null || askSlippage === null ? null :
      Math.max(bidSlippage, askSlippage),
    fetchedAt: fetchedAt,
    generatedAt: generatedAt,
    depthWindowPercent: 0.5,
    bidDepthUsd: bidDepth,
    askDepthUsd: askDepth,
    bidLevels: bids.map(function (level) {
      return { price: level.price, size: level.size, notionalUsd: level.price * level.size * multiplier };
    }),
    askLevels: asks.map(function (level) {
      return { price: level.price, size: level.size, notionalUsd: level.price * level.size * multiplier };
    }),
    executionNotionalUsd: 1000,
    timestampQuality: timestampQuality
  };
}

export function normalizeContractStats(rows, nowSeconds) {
  if (!Array.isArray(rows)) return { rows: [], quality: "NO DATA", duplicates: 0 };
  const byTime = new Map();
  let suspect = false;
  let duplicates = 0;
  rows.forEach(function (row) {
    if (!row || typeof row !== "object") {
      suspect = true;
      return;
    }
    const time = numeric(row.time);
    if (time === null || time <= 0 || time > 10000000000 || time > nowSeconds) {
      suspect = true;
      return;
    }
    function field(name, allowZero) {
      const value = numeric(row[name]);
      if (value === null) return null;
      if (allowZero ? value < 0 : value <= 0) {
        suspect = true;
        return null;
      }
      return value;
    }
    function optionalVisualField(name) {
      const value = numeric(row[name]);
      return value !== null && value >= 0 ? value : null;
    }
    const stat = {
      time: Math.floor(time),
      openInterest: field("open_interest", true),
      openInterestUsd: field("open_interest_usd", true),
      lsrTaker: field("lsr_taker", true),
      lsrAccount: field("lsr_account", true),
      topLsrAccount: field("top_lsr_account", true),
      topLsrSize: field("top_lsr_size", true),
      topLongOpenInterest: optionalVisualField("top_long_size"),
      topShortOpenInterest: optionalVisualField("top_short_size"),
      longLiquidationSize: field("long_liq_size", true),
      longLiquidationAmount: field("long_liq_amount", true),
      longLiquidationUsd: field("long_liq_usd", true),
      shortLiquidationSize: field("short_liq_size", true),
      shortLiquidationAmount: field("short_liq_amount", true),
      shortLiquidationUsd: field("short_liq_usd", true),
      markPrice: field("mark_price", false)
    };
    if (byTime.has(stat.time)) duplicates += 1;
    byTime.set(stat.time, stat);
  });
  const normalized = Array.from(byTime.values()).sort(function (a, b) { return a.time - b.time; });
  const latest = normalized.length ? normalized[normalized.length - 1] : null;
  const quality = suspect || duplicates ? "SUSPECT" : !latest ? "NO DATA" :
    nowSeconds - latest.time > 600 ? "STALE" : "OK";
  return { rows: normalized, quality: quality, duplicates: duplicates };
}

export function clearCache() {
  cache.clear();
}

export const GATE_CVD_SEMANTICS = Object.freeze({
  verified: false,
  reason: "Офіційні доступні документи Gate.io не підтверджують напрям агресора за знаком size; CVD недоступний."
});

function cvdNumber(value) {
  if (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Validates magnitude and provenance only: signed size is NOT an aggressor direction.
export function normalizeGateTradeFields(row, contract, multiplier, source, now = Date.now()) {
  const invalid = reason => ({ fields: null, state: "UNAVAILABLE", reason, source });
  if (!row || typeof row !== "object" || Array.isArray(row) || row.contract !== contract ||
      !["WS", "REST"].includes(source) || !Number.isFinite(now)) {
    return invalid("Некоректні дані або джерело угоди Gate.io.");
  }
  if (row.is_internal === true) return invalid("Внутрішню угоду виключено з CVD.");
  const id = row.id;
  if (!(typeof id === "string" && /^\d+$/.test(id)) &&
      !(typeof id === "number" && Number.isSafeInteger(id) && id >= 0)) {
    return invalid("Відсутній безпечний ідентифікатор угоди Gate.io.");
  }
  const price = cvdNumber(row.price);
  const signedSize = cvdNumber(row.size);
  const factor = cvdNumber(multiplier);
  const milliseconds = row.create_time_ms === undefined ? null : cvdNumber(row.create_time_ms);
  const seconds = row.create_time === undefined ? null : cvdNumber(row.create_time);
  if ((row.create_time_ms !== undefined && milliseconds === null) ||
      (row.create_time !== undefined && seconds === null) ||
      (milliseconds !== null && seconds !== null && Math.abs(milliseconds - seconds * 1000) > 1000)) {
    return invalid("Суперечливий час угоди Gate.io.");
  }
  const timestamp = milliseconds ?? (seconds === null ? null : seconds * 1000);
  const quoteVolume = Math.abs(signedSize) * price * factor;
  if (price === null || price <= 0 || signedSize === null || signedSize === 0 ||
      factor === null || factor <= 0 || timestamp === null || timestamp <= 0 ||
      !Number.isFinite(timestamp) || timestamp > now + 5000 ||
      !Number.isFinite(quoteVolume) || quoteVolume <= 0) {
    return invalid("Некоректні числові поля угоди Gate.io.");
  }
  return {
    fields: { id: String(id), contract, timestamp, price, signedSize, multiplier: factor, quoteVolume, source },
    state: "UNAVAILABLE", reason: GATE_CVD_SEMANTICS.reason, source
  };
}

export function normalizeGateTrade(row, contract, multiplier, source, now = Date.now()) {
  const result = normalizeGateTradeFields(row, contract, multiplier, source, now);
  return { ...result, trade: null, state: "UNAVAILABLE",
    reason: GATE_CVD_SEMANTICS.reason, validationReason: result.fields ? null : result.reason };
}

// Adapter injection supports transport tests/future officially verified semantics, not a UI override.
export function createGateTradeFeed({
  store, WebSocketImpl = globalThis.WebSocket, fetchImpl = globalThis.fetch,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  setEvery = setInterval, clearEvery = clearInterval,
  normalizeTrade = normalizeGateTrade, semantics = GATE_CVD_SEMANTICS, onChange = () => {}
}) {
  const entries = new Map();
  let socket = null;
  let detach = () => {};
  let disposed = false;
  let reconnectTimer = null;
  let handshakeTimer = null;
  let ackTimer = null;
  let heartbeat = null;
  let retry = 1000;
  let sequence = 0;
  let pending = [];
  let snapshots = [];
  let fetching = false;
  let lastMessage = 0;
  const verified = semantics?.verified === true && normalizeTrade !== normalizeGateTrade;

  function notify(contract) {
    try { onChange(contract); } catch { /* Rendering errors must not interrupt transport cleanup. */ }
  }
  function status(entry, state, reason) {
    store.status(entry.contract, state, reason);
    if (entry.state === state && entry.reason === reason) return;
    entry.state = state;
    entry.reason = reason;
    notify(entry.contract);
  }
  function cancelSnapshot(entry) {
    entry.controller?.abort();
    entry.controller = null;
    snapshots = snapshots.filter(item => item.entry !== entry);
  }
  function current(entry) {
    return !disposed && entries.get(entry.contract) === entry;
  }
  function stopSocket() {
    const old = socket;
    socket = null;
    detach();
    detach = () => {};
    if (heartbeat !== null) clearEvery(heartbeat);
    heartbeat = null;
    if (handshakeTimer !== null) clearTimer(handshakeTimer);
    handshakeTimer = null;
    if (ackTimer !== null) clearTimer(ackTimer);
    ackTimer = null;
    pending = [];
    try { old?.close(); } catch { /* Already closed. */ }
  }
  function scheduleReconnect() {
    if (disposed || !entries.size || reconnectTimer !== null) return;
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      connect();
    }, retry);
    retry = Math.min(30000, retry * 2);
  }
  function disconnected(reason) {
    stopSocket();
    for (const entry of entries.values()) {
      entry.live = false;
      cancelSnapshot(entry);
      store.resetCoverage(entry.contract, now(), reason);
      status(entry, "DELAYED", reason);
    }
    scheduleReconnect();
  }
  function armAckTimeout() {
    if (ackTimer !== null) clearTimer(ackTimer);
    ackTimer = null;
    if (!pending.length) return;
    const connection = socket;
    ackTimer = setTimer(() => {
      ackTimer = null;
      if (!disposed && socket === connection && pending.length) {
        disconnected("Gate.io не підтвердив підписку за 15 секунд; покриття скинуто.");
      }
    }, Math.max(0, pending[0].deadline - now()));
  }
  function sendSubscription(entry) {
    if (!socket || socket.readyState !== 1 || entry.requested) return;
    const id = ++sequence;
    const batch = { id, entries: [entry], deadline: now() + 15000 };
    pending.push(batch);
    if (pending.length === 1) armAckTimeout();
    entry.requested = true;
    socket.send(JSON.stringify({
      id, time: Math.floor(now() / 1000), channel: "futures.trades",
      event: "subscribe", payload: [entry.contract]
    }));
  }
  function ingestRows(entry, rows, source) {
    for (const row of rows) {
      if (!current(entry) || !entry.live) return;
      const normalized = normalizeTrade(row, entry.contract, entry.multiplier, source, now());
      if (normalized?.trade) store.ingest(normalized.trade, now());
      else {
        store.resetCoverage(entry.contract, now(), "Непідтверджена угода: попереднє покриття скинуто.");
        status(entry, "UNAVAILABLE", normalized?.reason || "Некоректна угода Gate.io.");
      }
    }
  }
  async function drainSnapshots() {
    if (fetching || disposed) return;
    fetching = true;
    try {
      while (snapshots.length && !disposed) {
        const { entry, session } = snapshots.shift();
        if (!current(entry) || !entry.live || entry.session !== session) continue;
        const controller = new AbortController();
        entry.controller = controller;
        const timeout = setTimer(() => controller.abort(), 15000);
        try {
          const response = await fetchImpl(API_ROOT + "/futures/usdt/trades?contract=" +
            encodeURIComponent(entry.contract) + "&limit=1000", {
            headers: { Accept: "application/json" }, signal: controller.signal
          });
          if (!response.ok) throw new Error("HTTP " + response.status);
          const rows = await response.json();
          if (!Array.isArray(rows) || rows.length > 1000) throw new Error("Некоректний список угод");
          if (!controller.signal.aborted && current(entry) && entry.session === session) {
            // Pre-anchor history cannot establish interval coverage; the store rejects it.
            ingestRows(entry, rows, "REST");
          }
        } catch {
          if (!controller.signal.aborted && current(entry) && entry.session === session) {
            status(entry, "DELAYED", "Не вдалося отримати обмежений знімок угод Gate.io.");
          }
        } finally {
          clearTimer(timeout);
          if (entry.controller === controller) entry.controller = null;
        }
      }
    } finally {
      fetching = false;
    }
  }
  function acknowledge(frame) {
    const index = frame.id === undefined ? 0 : pending.findIndex(batch => batch.id === frame.id);
    if (index < 0 || !pending.length) return;
    const [batch] = pending.splice(index, 1);
    armAckTimeout();
    if (frame.error || frame.result?.status !== "success") {
      disconnected("Gate.io відхилив підписку на угоди.");
      return;
    }
    retry = 1000;
    for (const entry of batch.entries) {
      if (!current(entry)) continue;
      entry.live = true;
      entry.session += 1;
      store.resetCoverage(entry.contract, now(), "Новий сеанс: історія до підтвердження не забезпечує покриття.");
      status(entry, "AVAILABLE", "Підписку на публічні угоди підтверджено.");
      snapshots.push({ entry, session: entry.session });
    }
    void drainSnapshots();
  }
  function message(event) {
    lastMessage = now();
    const frame = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("Invalid frame");
    if (frame.channel === "futures.trades" && frame.event === "subscribe") {
      acknowledge(frame);
      return;
    }
    if (frame.error) throw new Error("Gate.io error");
    if (frame.channel !== "futures.trades" || frame.event !== "update") return;
    if (!Array.isArray(frame.result)) throw new Error("Invalid trades");
    for (const row of frame.result) {
      if (!row || typeof row.contract !== "string") throw new Error("Invalid contract");
      const entry = entries.get(row.contract);
      if (entry?.live) ingestRows(entry, [row], "WS");
    }
  }
  function connect() {
    if (disposed || socket || !entries.size || !verified) return;
    for (const entry of entries.values()) entry.requested = false;
    try {
      const connection = new WebSocketImpl("wss://fx-ws.gateio.ws/v4/ws/usdt");
      socket = connection;
      lastMessage = now();
      const guard = callback => event => {
        if (disposed || socket !== connection) return;
        try { callback(event); } catch {
          disconnected("Некоректні дані або помилка з’єднання Gate.io; покриття скинуто.");
        }
      };
      const handlers = {
        open: guard(() => {
          if (handshakeTimer !== null) clearTimer(handshakeTimer);
          handshakeTimer = null;
          lastMessage = now();
          for (const entry of entries.values()) sendSubscription(entry);
        }),
        message: guard(message),
        close: guard(() => disconnected("З’єднання Gate.io перервано; новий сеанс без непідтверджених проміжків.")),
        error: guard(() => disconnected("Помилка WebSocket Gate.io; покриття скинуто."))
      };
      for (const [name, handler] of Object.entries(handlers)) connection.addEventListener(name, handler);
      detach = () => {
        for (const [name, handler] of Object.entries(handlers)) connection.removeEventListener(name, handler);
      };
      handshakeTimer = setTimer(guard(() => {
        handshakeTimer = null;
        disconnected("З’єднання Gate.io не відкрилося за 15 секунд; покриття скинуто.");
      }), 15000);
      heartbeat = setEvery(guard(() => {
        if (now() - lastMessage >= 45000) {
          disconnected("Немає повідомлень Gate.io понад 45 секунд; покриття скинуто.");
          return;
        }
        if (connection.readyState === 1) {
          connection.send(JSON.stringify({ time: Math.floor(now() / 1000), channel: "futures.ping" }));
        }
      }), 15000);
    } catch {
      disconnected("Не вдалося відкрити публічне з’єднання Gate.io.");
    }
  }
  function subscribe(contract, multiplier) {
    if (disposed || entries.has(contract)) return false;
    const factor = cvdNumber(multiplier);
    if (typeof contract !== "string" || !contract.trim()) return false;
    if (verified && (factor === null || factor <= 0)) return false;
    multiplier = factor !== null && factor > 0 ? factor : null;
    const entry = { contract, multiplier, live: false, requested: false, session: 0, controller: null };
    entries.set(contract, entry);
    store.addContract(contract, { startedAt: now(), multiplier });
    if (!verified) {
      status(entry, "UNAVAILABLE", GATE_CVD_SEMANTICS.reason);
      return true;
    }
    status(entry, "LOADING", "Очікування підтвердження підписки Gate.io.");
    connect();
    try { sendSubscription(entry); } catch { disconnected("Помилка підписки Gate.io."); }
    return true;
  }
  function unsubscribe(contract) {
    const entry = entries.get(contract);
    if (!entry) return false;
    entries.delete(contract);
    cancelSnapshot(entry);
    store.removeContract(contract);
    // Keep pending batches as tombstones: a late id-less ACK still belongs to its original request.
    for (const batch of pending) batch.entries = batch.entries.filter(item => item !== entry);
    if (!entries.size) {
      if (reconnectTimer !== null) clearTimer(reconnectTimer);
      reconnectTimer = null;
      stopSocket();
      retry = 1000;
    } else if (socket?.readyState === 1 && entry.requested) {
      try {
        socket.send(JSON.stringify({ time: Math.floor(now() / 1000), channel: "futures.trades",
          event: "unsubscribe", payload: [contract] }));
      } catch { disconnected("Помилка відписки Gate.io."); }
    }
    notify(contract);
    return true;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const contract of [...entries.keys()]) unsubscribe(contract);
    if (reconnectTimer !== null) clearTimer(reconnectTimer);
    reconnectTimer = null;
    stopSocket();
  }
  return { subscribe, unsubscribe, dispose,
    status: () => ({ activeContracts: entries.size, connected: Boolean(socket?.readyState === 1),
      pendingSubscriptions: pending.length, disposed }) };
}
