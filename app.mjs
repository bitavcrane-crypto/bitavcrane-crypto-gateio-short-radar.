import {
  API_BASE,
  analyzeContract,
  normalizeCandles,
  rankTickers,
  toNumber,
} from "./radar.mjs";

const REFRESH_MS = 60_000;
const SCAN_BATCH_SIZE = 80;
const CONCURRENCY = 6;
const WATCHLIST_KEY = "gateio-short-radar-watchlist";
const statusLabels = {
  "short-candidate": "SHORT-кандидат",
  "reversal-watch": "Можливий розворот",
  weakening: "Виснаження",
  overheated: "Перегрів",
  "early-pump": "Початок пампу",
  "active-pump": "Активний памп",
  scanning: "Моніторинг",
  insufficient: "Недостатньо даних",
  cancelled: "Сигнал скасовано",
};
const ui = Object.fromEntries([
  "connection", "notification-button", "refresh-button", "market-count", "pump-count",
  "candidate-count", "updated-at", "all-count", "active-count", "hot-count", "watch-count",
  "short-count", "results", "search", "sort", "add-watchlist", "watchlist-dialog",
  "watchlist-form", "contract-input",
].map((id) => [id, document.getElementById(id)]));

let tickers = [];
let rotatingOffset = 0;
let isRefreshing = false;
let activeFilter = "all";
let dataUpdatedAt = null;
const analyses = new Map();
const tickersByContract = new Map();
const notifiedStatuses = new Map();

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function formatPrice(value) {
  const number = toNumber(value);
  if (number === null) return "—";
  return new Intl.NumberFormat("en-US", { maximumSignificantDigits: 7 }).format(number);
}

function formatPercent(value, digits = 1) {
  const number = toNumber(value);
  return number === null ? "—" : `${number > 0 ? "+" : ""}${number.toFixed(digits)}%`;
}

function formatFunding(value) {
  const number = toNumber(value);
  return number === null ? "—" : `${(number * 100).toFixed(4)}%`;
}

function localTime(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }) : "—";
}

async function getJson(endpoint, params = {}) {
  const url = new URL(`${API_BASE}${endpoint}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Gate.io API: ${response.status}`);
  return response.json();
}

async function mapConcurrent(values, limit, callback) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (index < values.length) {
      const current = values[index++];
      await callback(current);
    }
  });
  await Promise.all(workers);
}

function currentWatchlist() {
  try {
    const saved = JSON.parse(localStorage.getItem(WATCHLIST_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((symbol) => typeof symbol === "string") : [];
  } catch {
    return [];
  }
}

function updateStatus(connection, text) {
  ui.connection.classList.toggle("offline", !connection);
  ui.connection.innerHTML = `<i></i>${escapeHtml(text)}`;
}

function makeAnalysis(contract, candles, ticker, oiHistory = [], fiveMinuteConfirmed = null) {
  const analysis = analyzeContract({
    contract,
    candles,
    ticker,
    oiHistory,
    fiveMinuteConfirmed,
  });
  analysis.lastUpdated = Date.now();
  return analysis;
}

function preserveOrCancelScenario(next, previous) {
  if (!previous) return next;
  const hasActiveSetup = ["short-candidate", "reversal-watch", "weakening"].includes(previous.status);
  if (hasActiveSetup && previous.invalidation && next.price > previous.invalidation) {
    return {
      ...next,
      status: "cancelled",
      reasons: [...next.reasons, `Сценарій скасовано: ціна відновилася вище ${formatPrice(previous.invalidation)}.`],
      pending: ["Для нового сценарію потрібні новий памп та окреме підтвердження."],
    };
  }
  if (previous.status === "cancelled" && next.isPump) {
    return {
      ...next,
      status: "cancelled",
      reasons: [...next.reasons, "Попередній сценарій залишається скасованим до появи нового підтвердженого сетапу."],
    };
  }
  return next;
}

function notifyStageChange(analysis, previous) {
  if (analysis.status === previous?.status) return;
  if (!["early-pump", "active-pump", "overheated", "weakening", "reversal-watch", "short-candidate", "cancelled"].includes(analysis.status)) return;
  const key = `${analysis.contract}:${analysis.status}`;
  if (notifiedStatuses.get(analysis.contract) === analysis.status) return;
  notifiedStatuses.set(analysis.contract, analysis.status);
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const reason = analysis.reasons.slice(0, 2).join(" ");
  new Notification(`${analysis.contract} · ${statusLabels[analysis.status]}`, {
    body: `${formatPrice(analysis.price)} · 15хв · SHORT ${analysis.score}/100 · ${reason || "Зміна статусу."}`,
    tag: key,
  });
}

function mappedState(analysis) {
  return `
    <div class="coin">
      <span class="coin-icon">${escapeHtml((analysis?.contract || "?").slice(0, 2))}</span>
      <div class="coin-name">
        <strong>${escapeHtml(analysis?.contract || "—")}${currentWatchlist().includes(analysis?.contract) ? `<button class="watch-remove" data-remove="${escapeHtml(analysis.contract)}" title="Видалити зі списку">×</button>` : ""}</strong>
        <span class="status status-${escapeHtml(analysis?.status || "insufficient")}">${escapeHtml(statusLabels[analysis?.status] || "Очікування скану")}</span>
      </div>
    </div>
    <div class="metric"><strong class="${(analysis?.change4h || 0) >= 0 ? "positive" : "negative"}">${formatPercent(analysis?.change4h)}</strong><small>1г ${formatPercent(analysis?.change1h)}</small></div>
    <div class="metric"><strong>${analysis?.volumeRatio === null || analysis?.volumeRatio === undefined ? "—" : `${analysis.volumeRatio.toFixed(2)}×`}</strong><small>від середнього · 15хв</small></div>
    <div class="metric-stack"><span>OI ${formatPercent(analysis?.oiChange)}</span><span>FUND ${formatFunding(analysis?.fundingRate)}</span><small>${analysis?.oiChange === null || analysis?.oiChange === undefined ? "OI: не надано" : "Gate.io contract_stats"}</small></div>
    <div class="signals">
      <span class="signal ${analysis?.isOverheated ? "active" : ""}">Перегрів</span>
      <span class="signal ${analysis?.weaknessSignals >= 2 ? "active" : ""}">Виснаження ${analysis?.weaknessSignals ?? 0}/5</span>
      <span class="signal ${analysis?.status === "short-candidate" ? "confirmed" : ""}">Розворот</span>
    </div>
    <div class="score">
      <span class="score-number ${analysis?.score >= 70 ? "score-high" : analysis?.score >= 40 ? "score-mid" : ""}">${analysis?.score ?? 0}</span>
      <div class="levels"><strong>${analysis?.support ? formatPrice(analysis.support) : "—"}</strong><small>тригер пробою · ${analysis?.invalidation ? `скасування ${formatPrice(analysis.invalidation)}` : "скасування —"}</small></div>
    </div>
    <div class="details">
      <div><strong>Фактичні ознаки</strong><ul>${(analysis?.reasons?.length ? analysis.reasons : ["Підтверджених ознак поки немає."]).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></div>
      <div><strong>Що потрібно далі</strong><ul>${(analysis?.pending?.length ? analysis.pending : ["Сетап підтверджено; рівні слід перевірити вручну."]).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>
      <div><strong>Бал SHORT · внесок</strong><ul><li>Памп ${analysis?.scoreFactors?.pump ?? 0} · обсяг ${analysis?.scoreFactors?.volume ?? 0} · перегрів ${analysis?.scoreFactors?.overheated ?? 0}</li><li>Ослаблення ${analysis?.scoreFactors?.weakness ?? 0} · пробій ${analysis?.scoreFactors?.supportBreak ?? 0}</li><li>Funding ${analysis?.scoreFactors?.funding ?? 0} · OI ${analysis?.scoreFactors?.openInterest ?? 0} балів</li><li class="source-note">Оцінка не є ймовірністю чи гарантією прибутку.</li></ul></div>
      <div><strong>Дані та оновлення</strong><ul><li>${escapeHtml(analysis?.sources?.price || "Джерело: Gate.io REST · свічки 15хв")}</li><li>${escapeHtml(analysis?.sources?.volume || "Джерело: Gate.io REST · обсяг свічок")}</li><li>${analysis?.sources?.funding ? escapeHtml(analysis.sources.funding) : "Funding: недоступний"}</li><li>${analysis?.sources?.oi ? escapeHtml(analysis.sources.oi) : "OI: недоступний"}</li><li>Скановано: ${localTime(analysis?.lastUpdated)} · свічка: ${localTime(analysis?.latestCandleTime)}</li></ul></div>
    </div>`;
}

function visibleAnalyses() {
  let values = [...analyses.values()];
  const watchlist = currentWatchlist();
  if (activeFilter === "pump") values = values.filter((item) => item.isPump);
  if (activeFilter === "hot") values = values.filter((item) => item.isOverheated);
  if (activeFilter === "watch") values = values.filter((item) => ["weakening", "reversal-watch"].includes(item.status));
  if (activeFilter === "short") values = values.filter((item) => item.status === "short-candidate");
  const search = ui.search.value.trim().toUpperCase();
  if (search) values = values.filter((item) => item.contract.includes(search));
  values.sort((a, b) => {
    if (watchlist.includes(a.contract) !== watchlist.includes(b.contract)) return watchlist.includes(a.contract) ? -1 : 1;
    if (ui.sort.value === "change") return (b.change4h ?? -Infinity) - (a.change4h ?? -Infinity);
    if (ui.sort.value === "volume") return (b.volumeRatio ?? -Infinity) - (a.volumeRatio ?? -Infinity);
    return b.score - a.score || (b.change4h ?? -Infinity) - (a.change4h ?? -Infinity);
  });
  return values;
}

function render() {
  const items = visibleAnalyses();
  const pumpCount = [...analyses.values()].filter((item) => item.isPump).length;
  const hotCount = [...analyses.values()].filter((item) => item.isOverheated).length;
  const watchCount = [...analyses.values()].filter((item) => ["weakening", "reversal-watch"].includes(item.status)).length;
  const shortCount = [...analyses.values()].filter((item) => item.status === "short-candidate").length;
  ui.marketCount.textContent = tickers.length || "—";
  ui.pumpCount.textContent = pumpCount;
  ui.candidateCount.textContent = shortCount;
  ui.updatedAt.textContent = localTime(dataUpdatedAt);
  ui.allCount.textContent = analyses.size;
  ui.activeCount.textContent = pumpCount;
  ui.hotCount.textContent = hotCount;
  ui.watchCount.textContent = watchCount;
  ui.shortCount.textContent = shortCount;
  if (!items.length) {
    ui.results.innerHTML = `<div class="empty-state"><strong>${tickers.length ? "Немає контрактів за цим фільтром" : "Очікуємо дані Gate.io"}</strong><p>${tickers.length ? "Спробуйте інший фільтр або додайте контракт у список спостереження." : "Перевірте підключення до публічного API."}</p></div>`;
    return;
  }
  ui.results.innerHTML = items.map((item) => `<article class="result-row">${mappedState(item)}</article>`).join("");
}

function selectScanBatch() {
  const ranked = rankTickers(tickers);
  if (!ranked.length) return [];
  const size = Math.min(SCAN_BATCH_SIZE, ranked.length);
  const selected = Array.from({ length: size }, (_, index) => ranked[(rotatingOffset + index) % ranked.length]);
  rotatingOffset = (rotatingOffset + size) % ranked.length;
  const selectedSymbols = new Set(selected.map((ticker) => ticker.contract));
  currentWatchlist().forEach((contract) => {
    if (!selectedSymbols.has(contract)) selected.push(tickersByContract.get(contract) || { contract, funding_rate: null });
  });
  return selected;
}

async function fetchCandleAnalysis(ticker) {
  const contract = ticker.contract;
  try {
    const candles = await getJson("/futures/usdt/candlesticks", {
      contract,
      interval: "15m",
      limit: "100",
    });
    const previous = analyses.get(contract);
    const first = makeAnalysis(contract, candles, ticker);
    const analysis = preserveOrCancelScenario(first, previous);
      analyses.set(contract, analysis);
    notifyStageChange(analysis, previous);
  } catch (error) {
    const previous = analyses.get(contract);
    if (!previous) {
      analyses.set(contract, {
        contract,
        status: "insufficient",
        score: 0,
        reasons: [],
        pending: [error.message || "Дані свічок тимчасово недоступні."],
        lastUpdated: Date.now(),
      });
    }
  }
}

async function fetchOpenInterest(analysis) {
  try {
    const rows = await getJson("/futures/usdt/contract_stats", {
      contract: analysis.contract,
      interval: "15m",
      limit: "2",
    });
    const previous = analysis;
    const updated = makeAnalysis(
      analysis.contract,
      analysis.candles ?? [],
      tickersByContract.get(analysis.contract) || {},
      Array.isArray(rows) ? rows : [],
    );
    if (updated.status !== "insufficient") {
      const adjusted = preserveOrCancelScenario(updated, previous);
      analyses.set(analysis.contract, adjusted);
      notifyStageChange(adjusted, previous);
    }
  } catch {
    // Open interest is optional; absent history is displayed as unavailable.
  }
}

async function fetchFiveMinuteConfirmation(analysis) {
  try {
    const rows = await getJson("/futures/usdt/candlesticks", {
      contract: analysis.contract,
      interval: "5m",
      limit: "3",
    });
    const now = Date.now();
    const candles = normalizeCandles(rows, now, 5 * 60 * 1000);
    if (candles.length) {
      const last = candles.at(-1);
      const confirmed = last.close < last.open && analysis.support && last.close < analysis.support;
      const updated = {
        ...analysis,
        fiveMinuteConfirmed: Boolean(confirmed),
        reasons: confirmed
          ? [...analysis.reasons, "5хв підтверджує ведмежий імпульс."]
          : analysis.reasons,
      };
      analyses.set(analysis.contract, updated);
    }
  } catch {
    // The 5-minute confirmation is supplementary and does not block the main scan.
  }
}

async function refresh() {
  if (isRefreshing) return;
  isRefreshing = true;
  ui.refreshButton.disabled = true;
  updateStatus(true, "Оновлення ринку");
  try {
    const response = await getJson("/futures/usdt/tickers");
    tickers = Array.isArray(response) ? response.filter((ticker) => ticker.contract) : [];
    tickersByContract.clear();
    tickers.forEach((ticker) => tickersByContract.set(ticker.contract, ticker));
    const batch = selectScanBatch();
    render();
    await mapConcurrent(batch, CONCURRENCY, fetchCandleAnalysis);

    const enriched = [...analyses.values()]
      .filter((item) => item.isPump || currentWatchlist().includes(item.contract))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
    await mapConcurrent(enriched, 4, fetchOpenInterest);

    const confirmationTargets = [...analyses.values()]
      .filter((item) => item.isPump && item.support)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
    await mapConcurrent(confirmationTargets, 4, fetchFiveMinuteConfirmation);
    dataUpdatedAt = Date.now();
    updateStatus(true, `Онлайн · ${batch.length} пар у циклі`);
  } catch (error) {
    updateStatus(false, "Немає з'єднання");
    if (!analyses.size) {
      ui.results.innerHTML = `<div class="empty-state"><strong>Не вдалося отримати дані Gate.io</strong><p>${escapeHtml(error.message || "Перевірте мережу та доступність API.")}</p></div>`;
    }
  } finally {
    isRefreshing = false;
    ui.refreshButton.disabled = false;
    render();
    window.setTimeout(refresh, REFRESH_MS);
  }
}

function addWatchlistContract(event) {
  event.preventDefault();
  const value = ui.contractInput.value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
  if (!value) return;
  const contract = value.endsWith("_USDT") ? value : `${value}_USDT`;
  const watchlist = new Set(currentWatchlist());
  watchlist.add(contract);
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify([...watchlist]));
  if (!analyses.has(contract)) {
    analyses.set(contract, {
      contract,
      status: "insufficient",
      score: 0,
      reasons: [],
      pending: ["Контракт буде перевірено під час наступного циклу сканування."],
      lastUpdated: Date.now(),
    });
  }
  ui.contractInput.value = "";
  ui.watchlistDialog.close();
  render();
}

ui.refreshButton.addEventListener("click", refresh);
ui.search.addEventListener("input", render);
ui.sort.addEventListener("change", render);
ui.addWatchlist.addEventListener("click", () => ui.watchlistDialog.showModal());
ui.watchlistForm.addEventListener("submit", addWatchlistContract);
ui.notificationButton.addEventListener("click", async () => {
  if ("Notification" in window) {
    const permission = await Notification.requestPermission();
    ui.notificationButton.textContent = permission === "granted" ? "Сповіщення увімкнено" : "Сповіщення вимкнено";
  }
});
document.querySelectorAll(".filter").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelector(".filter.active")?.classList.remove("active");
    button.classList.add("active");
    activeFilter = button.dataset.filter;
    render();
  });
});
ui.results.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove]");
  if (!button) return;
  const contract = button.dataset.remove;
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(currentWatchlist().filter((item) => item !== contract)));
  render();
});

if (!("Notification" in window)) ui.notificationButton.hidden = true;
refresh();
