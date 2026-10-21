const API_ROOT = "https://fapi.binance.com/fapi/v1";
const WS_URL = "wss://fstream.binance.com/public/stream";
const EXCHANGE_INFO_CACHE_MS = 5 * 60 * 1000;

let exchangeInfoCache = null;
let exchangeInfoPromise = null;

function numeric(value) {
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && !value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function validId(value) {
  return (typeof value === "string" && /^\d+$/.test(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

export function gateContractToBinanceSymbol(contract) {
  if (typeof contract !== "string") return null;
  const match = /^([A-Z0-9]{1,30})_USDT$/.exec(contract);
  return match ? match[1] + "USDT" : null;
}

export function resolveBinanceUsdMPerpetualSymbol(contract, exchangeInfo) {
  const candidate = gateContractToBinanceSymbol(contract);
  if (!candidate || !Array.isArray(exchangeInfo?.symbols)) return null;
  const match = exchangeInfo.symbols.find(function (item) {
    return item && item.symbol === candidate && item.status === "TRADING" &&
      item.contractType === "PERPETUAL" && item.quoteAsset === "USDT" &&
      item.marginAsset === "USDT";
  });
  return match?.symbol || null;
}

export function normalizeBinanceAggregateTrade(row, contract, symbol, now = Date.now()) {
  const invalid = reason => ({ trade: null, reason });
  if (!row || typeof row !== "object" || Array.isArray(row) ||
      row.e !== "aggTrade" || row.s !== symbol ||
      (row.st !== undefined && row.st !== 1) ||
      typeof contract !== "string" || !contract.trim() ||
      !Number.isFinite(now)) {
    return invalid("Некоректна подія Binance USDⓈ-M aggTrade.");
  }
  if (!validId(row.a)) return invalid("Відсутній безпечний ID агрегованої угоди Binance.");
  if (typeof row.m !== "boolean") return invalid("Відсутній підтверджений maker-прапорець Binance.");

  const price = numeric(row.p);
  const quantity = numeric(row.q);
  const timestamp = numeric(row.T);
  const quoteVolume = price * quantity;
  if (price === null || price <= 0 || quantity === null || quantity <= 0 ||
      timestamp === null || !Number.isSafeInteger(timestamp) || timestamp <= 0 ||
      timestamp > now + 5000 || !Number.isFinite(quoteVolume) || quoteVolume <= 0) {
    return invalid("Некоректні числові поля агрегованої угоди Binance.");
  }

  return {
    trade: {
      contract,
      id: symbol + ":" + String(row.a),
      timestamp,
      price,
      quantity,
      quoteVolume,
      direction: row.m ? "SELL" : "BUY",
      source: "BINANCE_USDM_AGGTRADE",
      quality: "VERIFIED"
    },
    reason: null
  };
}

function loadExchangeInfo(fetchImpl, now) {
  if (exchangeInfoCache && now - exchangeInfoCache.fetchedAt < EXCHANGE_INFO_CACHE_MS) {
    return Promise.resolve(exchangeInfoCache.data);
  }
  if (exchangeInfoPromise) return exchangeInfoPromise;
  exchangeInfoPromise = (async function () {
    const response = await fetchImpl(API_ROOT + "/exchangeInfo", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error("Binance exchangeInfo HTTP " + response.status);
    const data = await response.json();
    if (!data || !Array.isArray(data.symbols)) throw new Error("Некоректний Binance exchangeInfo.");
    exchangeInfoCache = { fetchedAt: now, data };
    return data;
  })().finally(function () {
    exchangeInfoPromise = null;
  });
  return exchangeInfoPromise;
}

export function clearBinanceExchangeInfoCache() {
  exchangeInfoCache = null;
  exchangeInfoPromise = null;
}

export function createBinanceTradeFeed({
  store,
  WebSocketImpl = globalThis.WebSocket,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onChange = () => {}
}) {
  const entries = new Map();
  const pending = new Map();
  let socket = null;
  let detach = () => {};
  let disposed = false;
  let reconnectTimer = null;
  let handshakeTimer = null;
  let ackTimer = null;
  let retry = 1000;
  let sequence = 0;

  function notify(contract) {
    try { onChange(contract); } catch { /* Rendering must not interrupt transport cleanup. */ }
  }

  function current(entry) {
    return !disposed && entries.get(entry.contract) === entry;
  }

  function setStatus(entry, state, reason) {
    store.status(entry.contract, state, reason);
    if (entry.state === state && entry.reason === reason) return;
    entry.state = state;
    entry.reason = reason;
    notify(entry.contract);
  }

  function stopSocket() {
    const old = socket;
    socket = null;
    detach();
    detach = () => {};
    if (handshakeTimer !== null) clearTimer(handshakeTimer);
    handshakeTimer = null;
    if (ackTimer !== null) clearTimer(ackTimer);
    ackTimer = null;
    pending.clear();
    try { old?.close(); } catch { /* Already closed. */ }
  }

  function scheduleReconnect() {
    if (disposed || !entries.size || reconnectTimer !== null) return;
    reconnectTimer = setTimer(function () {
      reconnectTimer = null;
      connect();
    }, retry);
    retry = Math.min(30000, retry * 2);
  }

  function disconnected(reason) {
    stopSocket();
    for (const entry of entries.values()) {
      if (!entry.symbol) continue;
      entry.live = false;
      entry.requested = false;
      store.resetCoverage(entry.contract, now(), reason);
      setStatus(entry, "DELAYED", reason);
    }
    scheduleReconnect();
  }

  function armAckTimeout() {
    if (ackTimer !== null) clearTimer(ackTimer);
    ackTimer = null;
    if (!pending.size) return;
    const deadline = Math.min(...Array.from(pending.values(), batch => batch.deadline));
    const connection = socket;
    ackTimer = setTimer(function () {
      ackTimer = null;
      if (!disposed && socket === connection && pending.size) {
        if (deadline <= now()) {
          disconnected("Binance не підтвердив підписку за 15 секунд; історію CVD скинуто.");
        } else {
          armAckTimeout();
        }
      }
    }, Math.max(0, deadline - now()));
  }

  function sendSubscriptions(requestedEntries) {
    if (!socket || socket.readyState !== 1) return;
    const eligible = requestedEntries.filter(function (entry) {
      return current(entry) && entry.symbol && !entry.requested;
    });
    if (!eligible.length) return;
    const id = ++sequence;
    pending.set(String(id), { entries: eligible, deadline: now() + 15000 });
    eligible.forEach(entry => { entry.requested = true; });
    armAckTimeout();
    socket.send(JSON.stringify({
      method: "SUBSCRIBE",
      params: eligible.map(entry => entry.symbol.toLowerCase() + "@aggTrade"),
      id
    }));
  }

  function acknowledge(frame) {
    const key = String(frame.id);
    const batch = pending.get(key);
    if (!batch) return;
    pending.delete(key);
    armAckTimeout();
    if (frame.code !== undefined || frame.result !== null) {
      for (const entry of batch.entries) {
        if (current(entry)) {
          entry.requested = false;
          setStatus(entry, "ERROR", "Binance відхилив підписку на агреговані угоди.");
        }
      }
      return;
    }
    retry = 1000;
    for (const entry of batch.entries) {
      if (!current(entry)) continue;
      entry.live = true;
      entry.session += 1;
      store.resetCoverage(entry.contract, now(),
        "Нова сесія Binance: проміжок до підтвердження підписки не використовується.");
      setStatus(entry, "LOADING", "Підписку Binance підтверджено; очікуємо першу угоду.");
    }
  }

  function message(event) {
    const frame = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      throw new Error("Некоректне повідомлення Binance.");
    }
    if (frame.id !== undefined) {
      acknowledge(frame);
      return;
    }
    if (frame.e !== "aggTrade") return;
    const entry = Array.from(entries.values()).find(item => item.symbol === frame.s);
    if (!entry || !entry.live) return;
    const normalized = normalizeBinanceAggregateTrade(frame, entry.contract, entry.symbol, now());
    if (!normalized.trade) {
      store.resetCoverage(entry.contract, now(), normalized.reason);
      setStatus(entry, "UNAVAILABLE", normalized.reason);
      return;
    }
    if (store.ingest(normalized.trade, now())) notify(entry.contract);
  }

  function connect() {
    if (disposed || socket || !entries.size ||
        !Array.from(entries.values()).some(entry => entry.symbol && !entry.requested)) return;
    if (typeof WebSocketImpl !== "function") {
      for (const entry of entries.values()) {
        if (entry.symbol) setStatus(entry, "ERROR", "WebSocket недоступний у цьому середовищі.");
      }
      return;
    }
    try {
      const connection = new WebSocketImpl(WS_URL);
      socket = connection;
      const guard = callback => event => {
        if (disposed || socket !== connection) return;
        try { callback(event); } catch {
          disconnected("Некоректні дані або помилка WebSocket Binance; історію CVD скинуто.");
        }
      };
      const handlers = {
        open: guard(function () {
          if (handshakeTimer !== null) clearTimer(handshakeTimer);
          handshakeTimer = null;
          sendSubscriptions(Array.from(entries.values()));
        }),
        message: guard(message),
        close: guard(function () {
          disconnected("З’єднання Binance перервано; прогрів почнеться заново.");
        }),
        error: guard(function () {
          disconnected("Помилка WebSocket Binance; історію CVD скинуто.");
        })
      };
      for (const [name, handler] of Object.entries(handlers)) connection.addEventListener(name, handler);
      detach = function () {
        for (const [name, handler] of Object.entries(handlers)) connection.removeEventListener(name, handler);
      };
      handshakeTimer = setTimer(function () {
        if (!disposed && socket === connection) {
          disconnected("З’єднання Binance не відкрилося за 15 секунд.");
        }
      }, 15000);
    } catch {
      disconnected("Не вдалося відкрити публічне з’єднання Binance.");
    }
  }

  async function resolveAndSubscribe(entry) {
    try {
      const info = await loadExchangeInfo(fetchImpl, now());
      if (!current(entry)) return;
      const symbol = resolveBinanceUsdMPerpetualSymbol(entry.contract, info);
      if (!symbol) {
        setStatus(entry, "UNAVAILABLE",
          "На Binance немає активного USDⓈ-M perpetual USDT-контракту з точним символом для цієї Gate-пари.");
        return;
      }
      entry.symbol = symbol;
      setStatus(entry, "LOADING", "Перевірено активний Binance USDⓈ-M perpetual; очікуємо підключення.");
      if (!socket) connect();
      else if (socket.readyState === 1) sendSubscriptions([entry]);
    } catch {
      if (current(entry)) {
        setStatus(entry, "UNAVAILABLE", "Не вдалося перевірити активні USDⓈ-M контракти Binance.");
      }
    }
  }

  function subscribe(contract, expectedSymbol) {
    if (disposed || entries.has(contract) || typeof contract !== "string" || !contract.trim()) return false;
    const entry = { contract, symbol: null, live: false, requested: false, session: 0, state: null, reason: null };
    entries.set(contract, entry);
    store.addContract(contract, { startedAt: now() });
    const candidate = gateContractToBinanceSymbol(contract);
    if (!candidate) {
      setStatus(entry, "UNAVAILABLE", "Не вдалося зіставити Gate-пару з форматом USDT perpetual Binance.");
      return true;
    }
    if (expectedSymbol !== undefined && expectedSymbol !== candidate) {
      setStatus(entry, "UNAVAILABLE", "Символ Binance не збігається з точним зіставленням Gate-пари.");
      return true;
    }
    setStatus(entry, "LOADING", "Перевіряємо активний Binance USDⓈ-M контракт.");
    void resolveAndSubscribe(entry);
    return true;
  }

  function unsubscribe(contract) {
    const entry = entries.get(contract);
    if (!entry) return false;
    entries.delete(contract);
    for (const [id, batch] of pending) {
      batch.entries = batch.entries.filter(item => item !== entry);
      if (!batch.entries.length) pending.delete(id);
    }
    armAckTimeout();
    store.removeContract(contract);
    if (socket?.readyState === 1 && entry.requested && entry.symbol) {
      try {
        socket.send(JSON.stringify({
          method: "UNSUBSCRIBE",
          params: [entry.symbol.toLowerCase() + "@aggTrade"],
          id: ++sequence
        }));
      } catch { disconnected("Помилка відписки від Binance; історію CVD скинуто."); }
    }
    if (!entries.size) {
      if (reconnectTimer !== null) clearTimer(reconnectTimer);
      reconnectTimer = null;
      stopSocket();
      retry = 1000;
    }
    notify(contract);
    return true;
  }

  function dispose() {
    if (disposed) return;
    for (const contract of [...entries.keys()]) unsubscribe(contract);
    disposed = true;
    if (reconnectTimer !== null) clearTimer(reconnectTimer);
    reconnectTimer = null;
    stopSocket();
  }

  return {
    subscribe,
    unsubscribe,
    dispose,
    status: () => ({
      activeContracts: entries.size,
      connected: socket?.readyState === 1,
      pendingSubscriptions: pending.size
    })
  };
}
