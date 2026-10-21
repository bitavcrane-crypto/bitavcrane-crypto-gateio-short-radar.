import { createCvdStore } from "./cvd.mjs";
import { createGateTradeFeed } from "./gate-api.mjs";

const TIMEFRAMES = ["15m", "1h", "4h"];
const STATE_LABELS = {
  LOADING: "Завантаження", AVAILABLE: "Доступно", DELAYED: "Дані затримуються",
  INSUFFICIENT_DATA: "Недостатньо даних", UNAVAILABLE: "Недоступно", ERROR: "Помилка"
};
const DIVERGENCE_LABELS = {
  BEARISH: "Підтверджена ведмежа", BULLISH: "Підтверджена бичача",
  NONE: "Підтвердженої дивергенції немає", INSUFFICIENT_DATA: "Недостатньо даних"
};
const REASON_LABELS = {
  NO_TRADES: "Немає достовірних угод у цьому інтервалі",
  INVALID_TRADE: "Некоректна угода: неперервність даних втрачена",
  INVALID_AGGREGATE: "Некоректний підсумковий обсяг",
  PARTIAL_COVERAGE: "Інтервал покритий не повністю",
  PROVISIONAL: "Поточний інтервал ще не завершений",
  STALE_TRADES: "Час останньої угоди перевищує поріг свіжості",
  SESSION_STARTED: "Початок нової сесії",
  COVERAGE_RESET: "Неперервність даних скинута",
  HISTORY_LIMIT: "Досягнуто ліміт історії: новий прогрів",
  ID_CAPACITY: "Досягнуто ліміт ID: новий прогрів без ризику повторного підрахунку",
  MINIMUM_BARS: "Потрібно щонайменше 9 завершених інтервалів",
  MINIMUM_TRADES: "Потрібно щонайменше 20 угод",
  INCOMPLETE_OR_INVALID_BARS: "Неповні або некоректні інтервали",
  GAPPED_BARS: "Історія містить пропуски інтервалів",
  INCOMPLETE_COVERAGE: "Неповне покриття для підтвердження",
  INVALID_INPUT: "Непридатні вхідні дані"
};

function reason(value) {
  return REASON_LABELS[value] || STATE_LABELS[value] || value || "";
}

function escape(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function number(value, digits = 2) {
  return Number.isFinite(value) ? value.toLocaleString("uk-UA", { maximumFractionDigits: digits }) : "—";
}

function timestamp(value) {
  return Number.isFinite(value) ? new Date(value).toLocaleString("uk-UA", { timeZone: "UTC" }) + " UTC" : "—";
}

export function renderCvdSnapshot(snapshot, selected = "15m", chart) {
  const state = snapshot?.state || "LOADING";
  const usable = state === "AVAILABLE";
  const frames = snapshot?.frames || {};
  const metrics = TIMEFRAMES.map(function (timeframe) {
    const frame = frames[timeframe];
    const ready = usable && frame?.state === "AVAILABLE";
    const value = function (key, digits) { return ready ? number(frame[key], digits) : "—"; };
    const divergence = ready ? frame.divergence : null;
    const pivots = divergence?.pivots || [];
    return '<section class="cvd-timeframe"><h4>' + escape(timeframe) + " · " +
      escape(STATE_LABELS[frame?.state] || STATE_LABELS[state]) + '</h4><dl>' +
      "<dt>Агресивні BUY / SELL · USDT</dt><dd>" + value("buyVolume") + " / " + value("sellVolume") + "</dd>" +
      "<dt>Δ / зміна CVD · USDT</dt><dd>" + value("delta") + " / " + value("cvdChange") + "</dd>" +
      "<dt>CVD сесії · USDT</dt><dd>" + value("cvd") + "</dd>" +
      "<dt>Дисбаланс Δ / (BUY + SELL)</dt><dd>" +
      (ready && Number.isFinite(frame.imbalance) ? number(frame.imbalance * 100) + "%" : "—") + "</dd>" +
      "<dt>Нахил · USDT/хв</dt><dd>" + value("slope") + "</dd>" +
      "<dt>Зміна ціни за той самий інтервал</dt><dd>" +
      (ready && Number.isFinite(frame.priceChange) ? number(frame.priceChange) + "%" : "—") + "</dd>" +
      "<dt>Напрям CVD</dt><dd>" + (ready && Number.isFinite(frame.cvdChange) ?
        frame.cvdChange > 0 ? "Покупці переважають" : frame.cvdChange < 0 ? "Продавці переважають" : "Баланс" : "Не визначено") + "</dd>" +
      "<dt>Угоди / покриття інтервалу</dt><dd>" + number(frame?.sampleCount, 0) + " / " +
      (Number.isFinite(frame?.coverage) ? number(frame.coverage * 100, 1) + "%" : "—") + "</dd></dl>" +
      '<p class="cvd-divergence">' + escape(DIVERGENCE_LABELS[divergence?.status] || "Недостатньо даних для дивергенції") + "</p>" +
      (pivots.length ? '<p class="quality-note">Півоти: ' + pivots.map(function (pivot) {
        return escape(timestamp(pivot.timestamp));
      }).join(" → ") + "</p>" : "") +
      '<p class="quality-note">' + escape(reason(frame?.reason || snapshot?.reason)) +
      (divergence?.reasonCodes?.length ? " · " + escape(divergence.reasonCodes.map(reason).join(", ")) : "") + "</p></section>";
  }).join("");
  const frame = frames[selected];
  const bars = usable && frame?.state === "AVAILABLE" ? (frame.bars || []).filter(function (bar) {
    return bar.closed && bar.coverage === 1;
  }).sort(function (a, b) { return a.time - b.time; }) : [];
  let charts = '<p class="chart-empty">Графік недоступний: потрібна достовірна завершена історія угод.</p>';
  if (bars.length > 1 && typeof chart === "function") {
    const plotted = [];
    bars.forEach(function (bar, index) {
      const previous = bars[index - 1];
      if (previous && bar.time > previous.end) plotted.push({ time: previous.end, close: null, cvd: null });
      plotted.push(bar);
    });
    const times = plotted.map(function (bar) { return bar.time; });
    const draw = function (key, label, color) {
      return chart([{ label: label, times: times, values: plotted.map(function (bar) { return bar[key]; }), color: color, digits: 4 }],
        { label: label, times: times, domainTimes: times });
    };
    charts = "<h4>Ціна · USDT · " + escape(selected) + "</h4>" + draw("close", "Ціна · USDT", "#56d9f5") +
      "<h4>CVD · USDT · окрема шкала · " + escape(selected) + "</h4>" + draw("cvd", "CVD · USDT", "#f9c35b") +
      '<p class="quality-note">' + escape(timestamp(times[0])) + " → " + escape(timestamp(bars[bars.length - 1].end)) + "</p>";
  }
  return '<p class="cvd-status" role="status">' + escape(state) + " · " + escape(STATE_LABELS[state] || state) +
    " · " + escape(reason(snapshot?.reason) || "Очікуємо перевірені дані угод.") + '</p>' +
    '<p class="quality-note">Остання угода: ' + escape(timestamp(snapshot?.lastTradeAt)) +
    '. Свіжі ≤30 с; DELAYED >30 с; UNAVAILABLE >120 с. Якість: ' +
    (usable ? "перевірені напрямок і повнота" : "непридатна для напрямного висновку") + '.</p>' +
    '<p class="quality-note">Початок сесії CVD: ' + escape(timestamp(snapshot?.startedAt)) +
    " · " + escape(reason(snapshot?.sessionReason)) + "</p>" +
    '<div class="cvd-metrics">' + metrics + '</div>' +
    '<label>Графік CVD · таймфрейм <select data-cvd-timeframe>' + TIMEFRAMES.map(function (timeframe) {
      return '<option value="' + timeframe + '"' + (timeframe === selected ? " selected" : "") + ">" + timeframe + "</option>";
    }).join("") + "</select></label>" + charts +
    '<p class="quality-note">Показано лише закриті інтервали. Поточний інтервал — попередній, не підтвердження дивергенції. ' +
    'CVD скидається при новій сесії або розриві даних; значення різних сесій не порівнюються. ' +
    'Півот: 2 закриті інтервали зліва та справа; негативна Δ сама по собі не є дивергенцією.</p>';
}

export function createCvdAnalysis({ chart, getMultiplier, createStore = createCvdStore, createFeed = createGateTradeFeed,
  setEvery = setInterval, clearEvery = clearInterval } = {}) {
  const open = new Map();
  let hosts = new Map();
  let feed = null;
  let store = null;
  let timer = null;
  let root = null;

  function update(contract) {
    const host = hosts.get(contract);
    if (!host || !open.has(contract)) return;
    const content = host.querySelector("[data-cvd-content]");
    if (!content) return;
    try {
      const snapshot = store.snapshot(contract, Date.now()) || {
        state: "UNAVAILABLE", reason: "Немає достовірного множника контракту для обчислення USDT-обсягу."
      };
      content.innerHTML = renderCvdSnapshot(snapshot, open.get(contract), chart);
    } catch {
      content.innerHTML = '<p role="status">ERROR · CVD недоступний. Основний радар працює незалежно.</p>';
    }
  }

  function stop(contract) {
    open.delete(contract);
    try { feed?.unsubscribe(contract); } catch { /* CVD cannot disable the radar. */ }
    if (!open.size && timer !== null) {
      clearEvery(timer);
      timer = null;
    }
  }

  function start(contract) {
    open.set(contract, "15m");
    try {
      if (!feed) {
        store = createStore();
        feed = createFeed({ store: store });
      }
      feed.subscribe(contract, getMultiplier?.(contract));
      if (timer === null) timer = setEvery(function () { open.forEach(function (_, pair) { update(pair); }); }, 5000);
      update(contract);
    } catch {
      update(contract);
    }
  }

  function click(event) {
    const button = event.target.closest?.("[data-cvd-toggle]");
    if (!button || !root?.contains(button)) return;
    const contract = button.getAttribute("data-cvd-toggle");
    if (!hosts.has(contract)) return;
    const content = hosts.get(contract).querySelector("[data-cvd-content]");
    if (open.has(contract)) {
      stop(contract);
      content.hidden = true;
      content.innerHTML = "";
      button.setAttribute("aria-expanded", "false");
    } else {
      content.hidden = false;
      button.setAttribute("aria-expanded", "true");
      start(contract);
    }
  }

  function change(event) {
    if (!event.target.matches?.("[data-cvd-timeframe]") || !TIMEFRAMES.includes(event.target.value)) return;
    const contract = event.target.closest("[data-cvd-contract]")?.getAttribute("data-cvd-contract");
    if (open.has(contract)) {
      open.set(contract, event.target.value);
      update(contract);
    }
  }

  function mount(node, pairs) {
    try {
      if (root !== node) {
        root?.removeEventListener("click", click);
        root?.removeEventListener("change", change);
        root = node;
        root.addEventListener("click", click);
        root.addEventListener("change", change);
      }
      const active = new Set(pairs);
      Array.from(open.keys()).forEach(function (contract) { if (!active.has(contract)) stop(contract); });
      hosts = new Map();
      node.querySelectorAll("[data-remove]").forEach(function (button) {
        const contract = button.getAttribute("data-remove");
        if (!active.has(contract)) return;
        const card = button.closest("article");
        if (!card) return;
        let host = card.querySelector("[data-cvd-contract]");
        if (!host) {
          host = node.ownerDocument.createElement("section");
          host.className = "cvd-analysis";
          host.setAttribute("data-cvd-contract", contract);
          card.append(host);
        }
        const expanded = open.has(contract);
        host.innerHTML = '<button type="button" class="visualization-toggle" data-cvd-toggle="' + escape(contract) +
          '" aria-expanded="' + expanded + '">CVD / Графік</button>' +
          '<p class="quality-note">Лише аналіз · не впливає на PUMP / EXHAUSTION / SHORT та торгові рівні.</p>' +
          '<div data-cvd-content' + (expanded ? "" : " hidden") + "></div>";
        hosts.set(contract, host);
        if (expanded) {
          try { feed?.subscribe(contract, getMultiplier?.(contract)); } catch { /* Keep rendering other pairs. */ }
          update(contract);
        }
      });
    } catch {
      // The optional analysis must never interrupt pair rendering.
    }
  }

  function dispose() {
    Array.from(open.keys()).forEach(stop);
    try { feed?.dispose(); } catch { /* Optional transport cleanup is isolated. */ }
    feed = null;
    store = null;
    root?.removeEventListener("click", click);
    root?.removeEventListener("change", change);
    root = null;
    hosts.clear();
  }

  return { mount, dispose };
}
