import { addPair, buildMarketData, removePair, sortPairsBySignal, transitionSignal, validatePairList } from "./core.mjs";
import { fetchCandles, fetchContracts, fetchContractStats, fetchTickers, normalizeContract, normalizeContractStats, normalizeTicker } from "./gate-api.mjs";

const DEFAULT_PAIRS = ["BTC_USDT", "ETH_USDT", "SOL_USDT"];
const PAIR_KEY = "gate-short-radar-pairs";
const POLL_MS = 60000;
const MAX_EVENTS = 12;
const cardsNode = document.getElementById("cards");
const signalSummaryNode = document.getElementById("signal-summary");
const noticeNode = document.getElementById("notice");
const connectionNode = document.getElementById("connection");
const eventList = document.getElementById("event-list");
const pairInput = document.getElementById("pair-input");
let contracts = [];
let pairs = loadPairs();
let models = {};
let pairErrors = {};
let events = [];
let busy = false;
let lastSuccessfulUpdate = null;

function loadPairs() {
  try {
    const value = JSON.parse(localStorage.getItem(PAIR_KEY) || "null");
    return Array.isArray(value) ? value : DEFAULT_PAIRS.slice();
  } catch (error) {
    return DEFAULT_PAIRS.slice();
  }
}

function savePairs() {
  try {
    localStorage.setItem(PAIR_KEY, JSON.stringify(pairs));
  } catch (error) {
    noticeNode.hidden = false;
    noticeNode.textContent = "Браузер не дозволяє зберегти список у localStorage.";
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, function (character) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
  });
}

function formatNumber(value, digits) {
  return typeof value === "number" && Number.isFinite(value) ?
    value.toLocaleString("uk-UA", { maximumFractionDigits: digits === undefined ? 4 : digits }) : "—";
}

function formatPercent(value) {
  return typeof value === "number" && Number.isFinite(value) ?
    (value >= 0 ? "+" : "") + formatNumber(value, 2) + "%" : "Немає даних";
}

function qualityLabel(value) {
  return value ? '<small class="quality">' + escapeHtml(value) + "</small>" : "";
}

function metric(label, value, quality) {
  return '<div class="metric"><span>' + label + qualityLabel(quality) +
    '</span><strong>' + escapeHtml(value) + "</strong></div>";
}

function score(label, value) {
  return '<div class="score"><span>' + label + '</span><strong>' +
    (typeof value === "number" && Number.isFinite(value) ? value + "/100" : "Немає даних") + "</strong></div>";
}

function displayState(model) {
  const label = model ? model.state.label : "NO DATA";
  const key = model ? model.state.key : "incomplete";
  return '<span class="state ' + escapeHtml(key) + '">' + escapeHtml(label) + "</span>";
}

function renderCard(pair) {
  const model = models[pair];
  if (!model) {
    return '<article class="card"><div class="card-head"><div><h2 class="pair-name">' +
      escapeHtml(pair) + '</h2><p class="price">Очікування першого оновлення</p></div>' +
      '<button class="remove-button" type="button" data-remove="' + escapeHtml(pair) + '" aria-label="Видалити ' +
      escapeHtml(pair) + '">✕</button></div><span class="state incomplete">Дані недоступні</span>' +
      '<p class="why"><strong>Чому?</strong> ' + escapeHtml(pairErrors[pair] ||
        "Очікуємо перше успішне оновлення. SHORT-сигнал не формується без перевірених даних.") + "</p></article>";
  }
  const data = model.data;
  const ticker = data.ticker;
  const stats = data.stats;
  const openInterestQuality = stats.openInterest === null && stats.openInterestUsd === null ?
    "NO DATA" : stats.openInterest === null || stats.openInterestUsd === null ? "INCOMPLETE" : stats.quality;
  const oiChangesComplete = ["15m", "1h", "4h"].every(function (intervalKey) {
    return typeof data.oiChanges[intervalKey] === "number" && Number.isFinite(data.oiChanges[intervalKey]);
  });
  const funding = typeof ticker.funding === "number" && data.fundingIntervalSeconds ?
    (ticker.funding > 0 ? "+" : "") + formatNumber(ticker.funding * 100, 4) + "% · " +
      (ticker.funding > 0 ? "LONG платять SHORT" : ticker.funding < 0 ? "SHORT платять LONG" : "нейтральний") :
    typeof ticker.funding === "number" ? "UNKNOWN (період невідомий)" : "Немає даних";
  const interval = data.fundingIntervalSeconds ?
    formatNumber(data.fundingIntervalSeconds / 3600, 1) + " год" : "невідомо";
  const liquidationQuality = stats.longLiquidationUsd === null && stats.shortLiquidationUsd === null ?
    "NO DATA" : stats.longLiquidationUsd === null || stats.shortLiquidationUsd === null ? "INCOMPLETE" : stats.quality;
  const liquidationRatio = stats.longLiquidationUsd === 0 && stats.shortLiquidationUsd > 0 ?
    "SHORT>0 · LONG=0" : stats.longLiquidationUsd > 0 && stats.shortLiquidationUsd !== null ?
      formatNumber(stats.shortLiquidationUsd / stats.longLiquidationUsd, 2) + "x SHORT/LONG" : "Немає даних";
  const levelData = model.levels;
  const levels = levelData ?
    '<div class="levels">' +
      '<div class="level"><span>ENTRY*</span><strong>' + formatNumber(levelData.entry, 6) + '</strong></div>' +
      '<div class="level"><span>STOP</span><strong>' + formatNumber(levelData.stop, 6) + '</strong></div>' +
      '<div class="level"><span>TP1</span><strong>' + formatNumber(levelData.tp1, 6) + '</strong></div>' +
      '<div class="level"><span>TP2</span><strong>' + formatNumber(levelData.tp2, 6) + '</strong></div>' +
      '<div class="level"><span>TP3</span><strong>' + formatNumber(levelData.tp3, 6) + '</strong></div>' +
    '</div><p class="quality-note">R:R до TP1 = 1 : ' + formatNumber(levelData.riskReward, 2) +
      ' · *Оцінка за закриттям 15m</p>' : '<p class="quality-note">Entry/Stop/TP з’являться лише для SHORT SETUP або SHORT ENTRY.</p>';
  const qualityNotes = [];
  if (model.quality !== "OK") qualityNotes.push("Якість оцінки: " + model.quality);
  if (model.state.key === "incomplete" && model.quality === "STALE") {
    qualityNotes.push("Показані останні отримані значення; нові дані недоступні");
  }
  if (!data.indicators.rsi || !data.indicators.macd) qualityNotes.push("Історії свічок недостатньо для всіх індикаторів");
  return '<article class="card"><div class="card-head"><div><h2 class="pair-name">' + escapeHtml(pair) +
    '</h2><p class="price">Остання ціна: ' + formatNumber(ticker.last, 8) +
    (ticker.mark !== null ? " · mark " + formatNumber(ticker.mark, 8) : "") +
    (ticker.index !== null ? " · index " + formatNumber(ticker.index, 8) : "") +
    '</p></div><button class="remove-button" type="button" data-remove="' + escapeHtml(pair) +
    '" aria-label="Видалити ' + escapeHtml(pair) + '">✕</button></div>' +
    displayState(model) +
    '<div class="scores">' + score("PUMP", model.pumpScore) + score("EXHAUSTION", model.exhaustionScore) +
    score("SHORT", model.shortScore) + '</div><div class="metrics">' +
    metric("5m / 15m", formatPercent(data.changes["5m"]) + " / " + formatPercent(data.changes["15m"]), data.qualities["15m"]) +
    metric("1h / 4h", formatPercent(data.changes["1h"]) + " / " + formatPercent(data.changes["4h"]), data.qualities["1h"]) +
    metric("Обсяг · ratio / 24h", data.volumeRatio === null ? "Немає даних" :
      formatNumber(data.volumeRatio, 2) + "x · $" + formatNumber(ticker.volume24h, 0),
      data.volumeRatio === null || ticker.volume24h === null ? "INCOMPLETE" : "OK") +
    metric("OI · контракти / USD", stats.openInterest === null ? "Немає даних" :
      formatNumber(stats.openInterest, 2) + " / $" + formatNumber(stats.openInterestUsd, 2),
      openInterestQuality) +
    metric("Δ OI · 15m / 1h / 4h", formatPercent(data.oiChanges["15m"]) + " / " +
      formatPercent(data.oiChanges["1h"]) + " / " + formatPercent(data.oiChanges["4h"]),
      stats.quality === "OK" && oiChangesComplete ? "OK" : "INCOMPLETE") +
    metric("Funding / період", funding + " / " + interval,
      typeof ticker.funding !== "number" ? "NO DATA" : data.fundingIntervalSeconds ? "OK" : "INCOMPLETE") +
    metric("Ліквідації · 5m USD", stats.longLiquidationUsd === null || stats.shortLiquidationUsd === null ?
      "Немає достовірних даних" : "LONG $" + formatNumber(stats.longLiquidationUsd, 2) +
      " / SHORT $" + formatNumber(stats.shortLiquidationUsd, 2),
      liquidationQuality) +
    metric("SHORT/LONG ліквідації", liquidationRatio,
      liquidationRatio === "Немає даних" ? "INCOMPLETE" : stats.quality) +
    metric("L/S account · taker · Δ 15m", stats.lsrAccount === null ? "Немає даних" :
      formatNumber(stats.lsrAccount, 3) + " / " + formatNumber(stats.lsrTaker, 3) +
      " · " + formatPercent(stats.lsrAccountChange15m),
      stats.lsrAccount === null ? "NO DATA" : stats.lsrTaker === null ? "INCOMPLETE" : stats.quality) +
    metric("RSI / MACD", (data.indicators.rsi === null ? "—" : formatNumber(data.indicators.rsi, 1)) + " / " +
      (data.indicators.macd ? formatNumber(data.indicators.macd.histogram, 6) : "—"), data.indicators.macd ? "OK" : "INCOMPLETE") +
    metric("Довіра моделі", model.confidence, "не ймовірність прибутку") +
    '</div>' + levels + '<p class="why"><strong>Чому?</strong> ' + escapeHtml(model.why) + '</p>' +
    (qualityNotes.length ? '<p class="quality-note">' + escapeHtml(qualityNotes.join(" · ")) + "</p>" : "") +
    "</article>";
}

function render() {
  document.getElementById("pair-count").textContent = pairs.length + (pairs.length === 1 ? " пара" : " пар");
  const activeShortCount = pairs.filter(function (pair) {
    return models[pair] && models[pair].state.key === "entry";
  }).length;
  signalSummaryNode.className = "signal-summary" + (activeShortCount ? " has-signals" : "");
  signalSummaryNode.textContent = activeShortCount ?
    "SHORT підтверджено для " + activeShortCount + (activeShortCount === 1 ? " монети." : " монет.") :
    "Активних SHORT-сигналів немає. Моніторинг триває";
  cardsNode.innerHTML = pairs.length ? sortPairsBySignal(pairs, models).map(renderCard).join("") :
    '<div class="empty">Список порожній. Додайте контракт Gate.io Futures.</div>';
  eventList.innerHTML = events.length ? events.map(function (event) {
    return "<li>" + escapeHtml(event) + "</li>";
  }).join("") : '<li class="empty-event">Нових змін поки немає.</li>';
  cardsNode.querySelectorAll("[data-remove]").forEach(function (button) {
    button.addEventListener("click", function () {
      const pair = button.getAttribute("data-remove");
      pairs = removePair(pairs, pair);
      delete models[pair];
      delete pairErrors[pair];
      savePairs();
      render();
    });
  });
}

function notifyChange(pair, oldState, newState) {
  if (!oldState || oldState === newState || newState === "incomplete" || newState === "none") return;
  const message = pair + ": " + oldState.toUpperCase() + " → " + newState.toUpperCase();
  events.unshift(new Date().toLocaleTimeString("uk-UA") + " · " + message);
  events = events.slice(0, MAX_EVENTS);
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification("Gate.io SHORT Radar", { body: message }); } catch (error) { /* Browser notification may be unavailable. */ }
  }
}

function lastSuccessLabel() {
  return "Останнє успішне оновлення: " +
    (lastSuccessfulUpdate ? lastSuccessfulUpdate.toLocaleTimeString("uk-UA") : "немає");
}

function markPairUnavailable(pair, message) {
  pairErrors[pair] = message;
  if (!models[pair]) return;
  models[pair] = Object.assign({}, models[pair], {
    state: { key: "incomplete", label: "Дані недоступні", score: 0 },
    quality: "STALE",
    pumpScore: null,
    exhaustionScore: null,
    shortScore: null,
    confidence: "Немає даних",
    levels: null,
    why: "Оновлення не вдалося (" + message + "). Показані останні значення застаріли й не є підтвердженням для входу."
  });
}

async function mapLimited(items, limit, worker) {
  let index = 0;
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    workers.push((async function () {
      while (index < items.length) {
        const current = index;
        index += 1;
        await worker(items[current]);
      }
    })());
  }
  await Promise.all(workers);
}

async function scan() {
  if (busy) return;
  busy = true;
  try {
    const results = await Promise.all([fetchContracts(), fetchTickers()]);
    const normalizedContracts = results[0].map(normalizeContract).filter(Boolean);
    contracts = normalizedContracts.filter(function (item) { return item.active; });
    const allowed = contracts.map(function (item) { return item.name; });
    pairs = validatePairList(pairs, allowed);
    savePairs();
    const contractMap = new Map();
    contracts.forEach(function (item) { contractMap.set(item.name, item); });
    const tickerMap = new Map();
    results[1].forEach(function (item) {
      if (item && typeof item.contract === "string") tickerMap.set(item.contract, item);
    });
    const failures = [];
    await mapLimited(pairs, 3, async function (pair) {
      try {
        const responses = await Promise.all([
          fetchCandles(pair, "5m"), fetchCandles(pair, "15m"),
          fetchCandles(pair, "1h"), fetchCandles(pair, "4h"),
          fetchContractStats(pair)
        ]);
        const ticker = normalizeTicker(tickerMap.get(pair), pair);
        const nowSeconds = Math.floor(Date.now() / 1000);
        const stats = normalizeContractStats(responses[4], nowSeconds);
        const model = buildMarketData({
          candles: { "5m": responses[0], "15m": responses[1], "1h": responses[2], "4h": responses[3] },
          ticker: ticker,
          stats: stats,
          fundingIntervalSeconds: contractMap.get(pair) ? contractMap.get(pair).fundingIntervalSeconds : null,
          nowSeconds: nowSeconds
        });
        const prior = models[pair];
        const signal = transitionSignal(model, prior, prior ? prior.candleTime : null);
        if (!signal.unchangedCandle && prior) notifyChange(pair, prior.state.key, signal.state.key);
        models[pair] = signal;
        delete pairErrors[pair];
      } catch (error) {
        failures.push(pair + ": " + error.message);
        markPairUnavailable(pair, error.message);
      }
    });
    connectionNode.textContent = failures.length ? "⚠️ Частина даних недоступна" : "Gate.io API · оновлено";
    connectionNode.className = "connection " + (failures.length ? "offline" : "online");
    noticeNode.hidden = failures.length === 0;
    noticeNode.textContent = failures.length ? "⚠️ Gate.io API недоступний для: " + failures.join("; ") : "";
    if (!failures.length) lastSuccessfulUpdate = new Date();
    document.getElementById("updated-at").textContent = lastSuccessLabel();
    render();
  } catch (error) {
    connectionNode.textContent = "⚠️ Gate.io API недоступний";
    connectionNode.className = "connection offline";
    noticeNode.hidden = false;
    noticeNode.textContent = "⚠️ Gate.io API недоступний. Перевірте мережу, DNS або CORS. Дані не замінено нулями. " + error.message;
    pairs.forEach(function (pair) {
      markPairUnavailable(pair, error.message);
    });
    document.getElementById("updated-at").textContent = lastSuccessLabel();
    render();
  } finally {
    busy = false;
  }
}

document.getElementById("pair-form").addEventListener("submit", function (event) {
  event.preventDefault();
  if (!contracts.length) {
    noticeNode.hidden = false;
    noticeNode.textContent = "Список контрактів ще не завантажено. Повторіть спробу після підключення до Gate.io.";
    return;
  }
  const result = addPair(pairs, pairInput.value, contracts.map(function (item) { return item.name; }));
  if (result.error) {
    noticeNode.hidden = false;
    noticeNode.textContent = result.error;
    return;
  }
  pairs = result.list;
  delete pairErrors[pairInput.value.trim().toUpperCase()];
  savePairs();
  pairInput.value = "";
  noticeNode.hidden = true;
  render();
  document.getElementById("updated-at").textContent = lastSuccessLabel();
  scan();
});

document.getElementById("notify-button").addEventListener("click", async function () {
  if (!("Notification" in window)) {
    noticeNode.hidden = false;
    noticeNode.textContent = "Цей браузер не підтримує системні сповіщення; зміни стану відображаються на сторінці.";
    return;
  }
  const permission = await Notification.requestPermission();
  noticeNode.hidden = false;
  noticeNode.textContent = permission === "granted" ? "Системні сповіщення увімкнено." : "Дозвіл на системні сповіщення не надано.";
});

render();
scan();
window.setInterval(scan, POLL_MS);
