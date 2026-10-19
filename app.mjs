import { addPair, buildMarketData, normalizeCandles, removePair, sortPairsBySignal, transitionSignal, validatePairList } from "./core.mjs";
import { fetchCandles, fetchContracts, fetchContractStats, fetchTickers, fetchVisualizationCandles, normalizeContract, normalizeContractStats, normalizeTicker } from "./gate-api.mjs";
import { DEFAULT_CONFIRMATION_SETTINGS, evaluateShortConfirmation, normalizeConfirmationSettings } from "./indicator-confirmation.mjs";
import { buildIndicatorVisualization } from "./indicator-visualization.mjs";

const DEFAULT_PAIRS = ["BTC_USDT", "ETH_USDT", "SOL_USDT"];
const PAIR_KEY = "gate-short-radar-pairs";
const CONFIRMATION_KEY = "gate-short-radar-confirmation-settings";
const VISUALIZATION_SETTINGS_KEY = "gate-short-radar-visualization-settings";
const VISUALIZATION_STATE_KEY = "gate-short-radar-visualization-state";
const VISUALIZATION_INTERVALS = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400 };
const DEFAULT_VISUALIZATION_SETTINGS = {
  rci: { periods: [6, 12, 24] }, obv: { lookback: 10 },
  ema: { periods: [200, 55, 22] }, kdj: { period: 9, ma1: 3, ma2: 3 }
};
const POLL_MS = 60000;
const MAX_EVENTS = 12;
const cardsNode = document.getElementById("cards");
const signalSummaryNode = document.getElementById("signal-summary");
const noticeNode = document.getElementById("notice");
const connectionNode = document.getElementById("connection");
const eventList = document.getElementById("event-list");
const pairInput = document.getElementById("pair-input");
let confirmationSettings = loadConfirmationSettings();
let visualizationSettings = loadVisualizationSettings();
let contracts = [];
let pairs = loadPairs();
let models = {};
let pairErrors = {};
let events = [];
let openVisualizations = new Set();
let visualizationSelections = loadVisualizationSelections();
let visualizationData = {};
let visualizationLoading = new Set();
let busy = false;
let lastSuccessfulUpdate = null;

function loadConfirmationSettings() {
  try {
    const value = JSON.parse(localStorage.getItem(CONFIRMATION_KEY) || "null");
    return normalizeConfirmationSettings(value).settings;
  } catch (error) {
    return normalizeConfirmationSettings(DEFAULT_CONFIRMATION_SETTINGS).settings;
  }
}

function normalizeVisualizationSettings(value) {
  function periodList(group, key, defaults, minimum, maximum) {
    const supplied = value && value[group] && Array.isArray(value[group][key]) ? value[group][key] : [];
    return defaults.map(function (fallback, index) {
      const candidate = Number(supplied[index]);
      return Number.isInteger(candidate) && candidate >= minimum && candidate <= maximum ? candidate : fallback;
    });
  }
  function period(group, key, fallback, minimum, maximum) {
    const candidate = Number(value && value[group] && value[group][key]);
    return Number.isInteger(candidate) && candidate >= minimum && candidate <= maximum ? candidate : fallback;
  }
  return {
    rci: { periods: periodList("rci", "periods", DEFAULT_VISUALIZATION_SETTINGS.rci.periods, 2, 100) },
    obv: { lookback: period("obv", "lookback", 10, 2, 100) },
    ema: { periods: periodList("ema", "periods", DEFAULT_VISUALIZATION_SETTINGS.ema.periods, 2, 500) },
    kdj: {
      period: period("kdj", "period", 9, 2, 100),
      ma1: period("kdj", "ma1", 3, 1, 20),
      ma2: period("kdj", "ma2", 3, 1, 20)
    }
  };
}

function loadVisualizationSettings() {
  try {
    return normalizeVisualizationSettings(JSON.parse(localStorage.getItem(VISUALIZATION_SETTINGS_KEY) || "null"));
  } catch (error) {
    return normalizeVisualizationSettings(DEFAULT_VISUALIZATION_SETTINGS);
  }
}

function loadVisualizationSelections() {
  try {
    const stored = JSON.parse(localStorage.getItem(VISUALIZATION_STATE_KEY) || "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    const selections = {};
    Object.keys(stored).forEach(function (contract) {
      if (VISUALIZATION_INTERVALS[stored[contract]]) selections[contract] = stored[contract];
    });
    return selections;
  } catch (error) {
    return {};
  }
}

function saveVisualizationSelections() {
  try {
    localStorage.setItem(VISUALIZATION_STATE_KEY, JSON.stringify(visualizationSelections));
  } catch (error) {
    noticeNode.hidden = false;
    noticeNode.textContent = "Вибір таймфрейму не вдалося зберегти у localStorage.";
  }
}

function selectedVisualizationInterval(contract) {
  return visualizationSelections[contract] || "15m";
}

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

function confirmationIndicatorValue(result) {
  if (!result.value) return "Немає даних";
  if (result.key === "RCI") {
    return formatNumber(result.value.value, 1) + " · попереднє " + formatNumber(result.value.previous, 1);
  }
  if (result.key === "OBV") return "Δ " + formatNumber(result.value.change, 2);
  if (result.key === "EMA") {
    return formatNumber(result.value.fast, 6) + " / " + formatNumber(result.value.slow, 6);
  }
  return "K " + formatNumber(result.value.k, 1) + " / D " + formatNumber(result.value.d, 1);
}

function renderConfirmation(model) {
  const confirmation = model.indicatorConfirmation;
  if (!confirmation) return "";
  const indicators = confirmation.indicators.map(function (result) {
    return '<div class="confirmation-indicator"><span>' + escapeHtml(result.key) + '</span><strong>' +
      escapeHtml(confirmationIndicatorValue(result)) + '</strong><small>' + escapeHtml(result.detail) + "</small></div>";
  }).join("");
  const reasons = confirmation.reasons.length ? confirmation.reasons.join(" · ") : "Немає додаткових причин очікувати";
  return '<section class="confirmation-panel"><div class="confirmation-heading"><strong>Базовий сигнал радара</strong>' +
    '<span>' + escapeHtml(model.state.label) + '</span></div><div class="confirmation-heading">' +
    '<strong>Додаткове підтвердження</strong><span>' + escapeHtml(confirmation.label) + '</span></div>' +
    '<p class="confirmation-quality">Якість підтвердження: ' + escapeHtml(confirmation.quality) +
    ' · Ризик сценарію: ' + (confirmation.conflict ? "підвищений через суперечність" :
      confirmation.unavailable.length ? "оцінити неможливо через відсутні дані" :
        confirmation.state === "confirmed" ? "залишається" : "не усунутий") + '</p>' +
    '<div class="confirmation-indicators">' + indicators + '</div><p class="confirmation-reasons"><strong>Чому вхід не підтверджений?</strong> ' +
    escapeHtml(reasons) + "</p></section>";
}

function chartSvg(seriesList, options) {
  const allValues = seriesList.reduce(function (values, series) {
    return values.concat(series.values.filter(function (value) { return typeof value === "number" && Number.isFinite(value); }));
  }, []);
  if (allValues.length < 2) return '<p class="chart-empty">Недостатньо даних для графіка</p>';
  const min = options.min === undefined ? Math.min.apply(null, allValues) : options.min;
  const max = options.max === undefined ? Math.max.apply(null, allValues) : options.max;
  const range = max === min ? Math.abs(max) * 0.1 || 1 : max - min;
  const low = options.min === undefined ? min - range * 0.08 : min;
  const high = options.max === undefined ? max + range * 0.08 : max;
  const width = 320;
  const height = 104;
  const pad = 5;
  const x = function (index, length) { return pad + index * (width - pad * 2) / Math.max(1, length - 1); };
  const y = function (value) { return height - pad - ((value - low) / (high - low)) * (height - pad * 2); };
  const backgrounds = options.zones ? options.zones.map(function (zone) {
    return '<rect x="0" y="' + y(zone.to) + '" width="' + width + '" height="' +
      Math.max(0, y(zone.from) - y(zone.to)) + '" fill="' + zone.color + '"/>';
  }).join("") : "";
  const guides = (options.guides || []).map(function (value) {
    return '<line x1="0" y1="' + y(value) + '" x2="' + width + '" y2="' + y(value) +
      '" stroke="#4c5b6c" stroke-dasharray="4 4"/>';
  }).join("");
  const paths = seriesList.map(function (series) {
    const points = series.values.map(function (value, index) {
      return typeof value === "number" && Number.isFinite(value) ? x(index, series.values.length) + "," + y(value) : null;
    }).filter(Boolean);
    return points.length > 1 ? '<polyline fill="none" stroke="' + series.color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="' +
      points.join(" ") + '"/>' : "";
  }).join("");
  return '<svg class="indicator-chart-svg" viewBox="0 0 320 104" role="img" aria-label="' +
    escapeHtml(options.label) + '" preserveAspectRatio="none">' + backgrounds + guides + paths + "</svg>";
}

function directionLabel(value) {
  return value === "bullish" ? "зростає" : value === "bearish" ? "спадає" : "нейтральний";
}

function renderIndicatorVisualization(pair) {
  const interval = selectedVisualizationInterval(pair);
  const data = visualizationData[pair] && visualizationData[pair][interval];
  const cacheTime = data && data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString("uk-UA") : "немає";
  const lastCandle = data && data.candles && data.candles.length ?
    new Date(data.candles[data.candles.length - 1].time * 1000).toLocaleString("uk-UA") : "немає";
  const header = '<div class="visualization-heading"><strong>' + escapeHtml(pair) +
    ' · RCI / EMA / KDJ · ' + interval + '</strong><label>Таймфрейм <select data-visualization-timeframe="' +
    escapeHtml(pair) + '" aria-label="Таймфрейм графіків ' + escapeHtml(pair) + '">' +
    Object.keys(VISUALIZATION_INTERVALS).map(function (item) {
      return '<option value="' + item + '"' + (item === interval ? " selected" : "") + ">" + item + "</option>";
    }).join("") + '</select></label></div>';
  if (!data || data.loading || (!data.candles && !data.error)) {
    return header + '<p class="visualization-message">Завантаження свічок ' + interval + "…</p>";
  }
  if (data.error && (!data.candles || !data.candles.length)) {
    return header + '<p class="visualization-message">Дані тимчасово недоступні · ' +
      escapeHtml(data.error) + " · останнє успішне оновлення: " + cacheTime + "</p>";
  }
  if (!data.candles || !data.candles.length) {
    return header + '<p class="visualization-message">Недостатньо історії для розрахунку.</p>';
  }
  const view = buildIndicatorVisualization(data.candles, visualizationSettings, Math.floor(Date.now() / 1000),
    VISUALIZATION_INTERVALS[interval]);
  if (view.status === "incomplete") {
    return header + '<p class="visualization-message">Недостатньо історії для розрахунку · у послідовності свічок є пропуск або некоректна мітка часу.</p>';
  }
  if (view.status !== "ok") {
    return header + '<p class="visualization-message">Недостатньо історії для розрахунку.</p>';
  }
  const indicators = view.indicators;
  const rci = indicators.rci;
  const rciColors = ["#77c8ff", "#49d4a5", "#f18c8c"];
  const rciContent = '<p class="chart-summary">' + rci.lines.map(function (line) {
    return "RCI(" + line.period + ") <strong>" + formatNumber(line.value, 1) + '</strong> · ' +
      directionLabel(line.direction);
  }).join(" · ") + " · шкала −100…+100 · " +
    (rci.possibleReversalDown ? "можливий розворот униз" : "розворот униз не підтверджено") + "</p>" +
    chartSvg(rci.lines.map(function (line, index) {
      return { values: line.values, color: rciColors[index % rciColors.length] };
    }), {
      min: -100, max: 100, guides: [-80, 0, 80], label: "RCI periods " + rci.periods.join(", "),
      zones: [{ from: 80, to: 100, color: "#633b3b66" }, { from: -100, to: -80, color: "#24574366" }]
    }) + '<p class="chart-footnote">Дивергенція RCI не визначається: надійного алгоритму в модулі немає.</p>';
  const obv = indicators.obv;
  const obvContent = !obv.volumeAvailable ?
    '<p class="chart-empty">Дані тимчасово недоступні для OBV · немає повного обсягу.</p>' :
      '<p class="chart-summary">Зміна OBV (' + obv.lookback + ' свічок): <strong>' +
        formatNumber(obv.change, 2) + '</strong> · напрямок: ' + directionLabel(obv.direction) + "</p>" +
      chartSvg([
        { values: obv.values, color: "#e8b86d" },
        { values: obv.averageValues, color: "#77c8ff" }
      ], { label: "OBV та SMA " + obv.lookback }) +
      '<p class="chart-footnote">OBV розраховано за напрямком close; лінія згладжування — SMA(' +
      obv.lookback + "). Абсолютний OBV не є самостійним SHORT-сигналом.</p>";
  const ema = indicators.ema;
  const emaColors = ["#49d4a5", "#f18c8c", "#c59bff"];
  const emaContent = '<p class="chart-summary">Close ' + formatNumber(ema.close, 8) + " · " +
    ema.lines.map(function (line) {
      return "EMA(" + line.period + ") " + formatNumber(line.value, 8) + " " + directionLabel(line.direction);
    }).join(" · ") + " · " + ema.position + " · перетин на останній свічці: " +
    (ema.crossed ? "так" : "ні") + "</p>" +
    chartSvg([{ values: ema.closeValues, color: "#f3f5f7" }].concat(ema.lines.map(function (line, index) {
      return { values: line.values, color: emaColors[index % emaColors.length] };
    })), { label: "Ціна close та EMA " + ema.periods.join(", ") }) +
    (ema.lines.some(function (line) { return !Number.isFinite(line.value); }) ?
      '<p class="chart-footnote">Недостатньо історії для EMA ' + ema.lines.filter(function (line) {
        return !Number.isFinite(line.value);
      }).map(function (line) { return line.period; }).join(", ") + ".</p>" : "");
  const kdj = indicators.kdj;
  const kdjContent = !Number.isFinite(kdj.k) || !Number.isFinite(kdj.d) || !Number.isFinite(kdj.j) ?
    '<p class="chart-empty">Недостатньо історії для розрахунку KDJ ' + kdj.period + ".</p>" :
      '<p class="chart-summary">K ' + formatNumber(kdj.k, 1) + " · D " + formatNumber(kdj.d, 1) +
        " · J " + formatNumber(kdj.j, 1) + " · " + directionLabel(kdj.direction) + " · перетин: " +
        (kdj.cross === "unavailable" ? "недоступний" : kdj.cross === "none" ? "немає" : kdj.cross) + "</p>" +
      chartSvg([
        { values: kdj.kValues, color: "#77c8ff" },
        { values: kdj.dValues, color: "#f18c8c" },
        { values: kdj.jValues, color: "#c59bff" }
      ], { guides: [20, 50, 80], label: "KDJ" });
  const model = models[pair];
  const summary = model && model.state ? "Базовий радар: " + model.state.label +
    ". Індикатори цього таймфрейму — окремий контекст; потрібне підтвердження ціною." :
    "Базовий радар очікує дані. Графіки не змінюють його сигнали.";
  return header + (data.error ? '<p class="visualization-message">Дані тимчасово недоступні · показано останній успішний набір · ' +
    escapeHtml(data.error) + " · останнє успішне оновлення: " + cacheTime + "</p>" : "") +
    '<div class="visualization-meta">' + view.candles.length + " закритих " + interval +
    " свічок · остання свічка: " + escapeHtml(lastCandle) + " · дані оновлено: " + cacheTime + "</div>" +
    '<div class="indicator-chart-grid">' +
    '<section class="indicator-chart-card"><h4>RCI · ' + rci.periods.join(" / ") + "</h4>" + rciContent + "</section>" +
    '<section class="indicator-chart-card"><h4>OBV · SMA / Δ " + obv.lookback + "</h4>" + obvContent + "</section>" +
    '<section class="indicator-chart-card"><h4>Ціна / EMA · ' + ema.periods.join(" / ") + "</h4>" + emaContent + "</section>" +
    '<section class="indicator-chart-card"><h4>KDJ · ' + kdj.period + " / " + kdj.ma1 + " / " + kdj.ma2 +
    "</h4>" + kdjContent + "</section></div>" +
    '<p class="visualization-summary">' + escapeHtml(summary) +
    " Перекупленість сама по собі не є умовою SHORT; сильний висхідний тренд 4h підвищує ризик контртрендового входу.</p>";
}

function renderVisualizationControl(pair) {
  const open = openVisualizations.has(pair);
  const id = "visualization-" + pair.replace(/[^a-zA-Z0-9_-]/g, "-");
  return '<button class="visualization-toggle" type="button" data-visualization="' + escapeHtml(pair) +
    '" aria-controls="' + id + '" aria-expanded="' + open + '">📊 Візуалізація індикаторів</button>' +
    '<div class="visualization-panel" id="' + id + '"' + (open ? "" : " hidden") + '>' +
    (open ? renderIndicatorVisualization(pair) : "") + '</div>';
}

function renderCard(pair) {
  const model = models[pair];
  if (!model) {
    return '<article class="card"><div class="card-head"><div><h2 class="pair-name">' +
      escapeHtml(pair) + '</h2><p class="price">Очікування першого оновлення</p></div>' +
      '<button class="remove-button" type="button" data-remove="' + escapeHtml(pair) + '" aria-label="Видалити ' +
      escapeHtml(pair) + '">✕</button></div><span class="state incomplete">Дані недоступні</span>' +
      '<p class="why"><strong>Чому?</strong> ' + escapeHtml(pairErrors[pair] ||
        "Очікуємо перше успішне оновлення. SHORT-сигнал не формується без перевірених даних.") + "</p>" +
      renderVisualizationControl(pair) + "</article>";
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
    '</div>' + levels + renderConfirmation(model) + '<p class="why"><strong>Чому?</strong> ' + escapeHtml(model.why) + '</p>' +
    (qualityNotes.length ? '<p class="quality-note">' + escapeHtml(qualityNotes.join(" · ")) + "</p>" : "") +
    renderVisualizationControl(pair) + "</article>";
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
      delete visualizationSelections[pair];
      delete visualizationData[pair];
      openVisualizations.delete(pair);
      savePairs();
      saveVisualizationSelections();
      render();
    });
  });
  cardsNode.querySelectorAll("[data-visualization]").forEach(function (button) {
    button.addEventListener("click", function () {
      const pair = button.getAttribute("data-visualization");
      if (openVisualizations.has(pair)) openVisualizations.delete(pair);
      else {
        openVisualizations.add(pair);
        ensureVisualizationData(pair, selectedVisualizationInterval(pair));
      }
      render();
    });
  });
  cardsNode.querySelectorAll("[data-visualization-timeframe]").forEach(function (select) {
    select.addEventListener("change", function () {
      const pair = select.getAttribute("data-visualization-timeframe");
      visualizationSelections[pair] = select.value;
      saveVisualizationSelections();
      ensureVisualizationData(pair, select.value);
      render();
    });
  });
}

async function ensureVisualizationData(contract, interval, force) {
  if (!VISUALIZATION_INTERVALS[interval]) return;
  if (!visualizationData[contract]) visualizationData[contract] = {};
  const existing = visualizationData[contract][interval] || {};
  if (existing.loading || (!force && existing.updatedAt &&
      Date.now() - existing.updatedAt < POLL_MS && !existing.error)) return;
  existing.loading = true;
  delete existing.error;
  visualizationData[contract][interval] = existing;
  const loadingKey = contract + "|" + interval;
  visualizationLoading.add(loadingKey);
  try {
    const rows = await fetchVisualizationCandles(contract, interval);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const normalized = normalizeCandles(rows, interval, nowSeconds);
    if (!normalized.candles.length) throw new Error("Gate.io не повернув завершені свічки");
    existing.candles = normalized.candles;
    existing.quality = normalized.quality;
    existing.updatedAt = Date.now();
  } catch (error) {
    existing.error = error.message || "помилка API";
  } finally {
    existing.loading = false;
    visualizationLoading.delete(loadingKey);
    visualizationData[contract][interval] = existing;
    render();
  }
}

function refreshOpenVisualizations() {
  openVisualizations.forEach(function (contract) {
    ensureVisualizationData(contract, selectedVisualizationInterval(contract));
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
    indicatorConfirmation: evaluateShortConfirmation([], { state: { key: "incomplete" } },
      confirmationSettings, Math.floor(Date.now() / 1000)),
    why: "Оновлення не вдалося (" + message + "). Показані останні значення застаріли й не є підтвердженням для входу."
  });
}

function updateConfirmationSettings(settings) {
  confirmationSettings = settings;
  try {
    localStorage.setItem(CONFIRMATION_KEY, JSON.stringify(settings));
  } catch (error) {
    noticeNode.hidden = false;
    noticeNode.textContent = "Налаштування підтвердження не вдалося зберегти у localStorage.";
  }
  Object.keys(models).forEach(function (pair) {
    const model = models[pair];
    if (!model || !model.data) return;
    models[pair] = Object.assign({}, model, {
      indicatorConfirmation: evaluateShortConfirmation(model.data.candles15, model, settings,
        Math.floor(Date.now() / 1000), model.indicatorConfirmation)
    });
  });
  render();
}

function syncConfirmationControls() {
  document.querySelectorAll("[data-indicator]").forEach(function (checkbox) {
    checkbox.checked = confirmationSettings[checkbox.dataset.indicator].enabled;
  });
  document.querySelectorAll("[data-period]").forEach(function (input) {
    const path = input.dataset.period.split(".");
    input.value = confirmationSettings[path[0]][path[1]];
  });
}

function syncVisualizationControls() {
  document.querySelectorAll("[data-vis-period]").forEach(function (input) {
    const path = input.dataset.visPeriod.split(".");
    input.value = path[0] === "rci" || path[0] === "ema" ?
      visualizationSettings[path[0]].periods[Number(path[1])] :
      visualizationSettings[path[0]][path[1]];
  });
}

function readVisualizationControls() {
  const value = {
    rci: { periods: [] }, obv: {}, ema: { periods: [] }, kdj: {}
  };
  document.querySelectorAll("[data-vis-period]").forEach(function (input) {
    const path = input.dataset.visPeriod.split(".");
    if (path[0] === "rci" || path[0] === "ema") value[path[0]].periods[Number(path[1])] = input.value;
    else value[path[0]][path[1]] = input.value;
  });
  visualizationSettings = normalizeVisualizationSettings(value);
  try {
    localStorage.setItem(VISUALIZATION_SETTINGS_KEY, JSON.stringify(visualizationSettings));
  } catch (error) {
    noticeNode.hidden = false;
    noticeNode.textContent = "Параметри графіків не вдалося зберегти у localStorage.";
  }
  syncVisualizationControls();
  render();
}

function readConfirmationControls() {
  const settings = {};
  ["rci", "obv", "ema", "kdj"].forEach(function (name) {
    settings[name] = { enabled: document.querySelector('[data-indicator="' + name + '"]').checked };
  });
  document.querySelectorAll("[data-period]").forEach(function (input) {
    const path = input.dataset.period.split(".");
    settings[path[0]][path[1]] = input.value;
  });
  const normalized = normalizeConfirmationSettings(settings);
  updateConfirmationSettings(normalized.settings);
  syncConfirmationControls();
  if (normalized.issues.length) {
    noticeNode.hidden = false;
    noticeNode.textContent = normalized.issues.join(" · ");
  }
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
        models[pair] = Object.assign({}, signal, {
          indicatorConfirmation: evaluateShortConfirmation(signal.data.candles15, signal, confirmationSettings,
            Math.floor(Date.now() / 1000), prior && prior.indicatorConfirmation)
        });
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
    refreshOpenVisualizations();
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

document.querySelectorAll("[data-indicator], [data-period]").forEach(function (control) {
  control.addEventListener("change", readConfirmationControls);
});
document.getElementById("reset-confirmation").addEventListener("click", function () {
  updateConfirmationSettings(normalizeConfirmationSettings(DEFAULT_CONFIRMATION_SETTINGS).settings);
  syncConfirmationControls();
  noticeNode.hidden = true;
});

document.querySelectorAll("[data-vis-period]").forEach(function (input) {
  input.addEventListener("change", readVisualizationControls);
});
document.getElementById("reset-visualization").addEventListener("click", function () {
  visualizationSettings = normalizeVisualizationSettings(DEFAULT_VISUALIZATION_SETTINGS);
  try {
    localStorage.setItem(VISUALIZATION_SETTINGS_KEY, JSON.stringify(visualizationSettings));
  } catch (error) {
    noticeNode.hidden = false;
    noticeNode.textContent = "Параметри графіків не вдалося зберегти у localStorage.";
  }
  syncVisualizationControls();
  render();
});

syncConfirmationControls();
syncVisualizationControls();
render();
scan();
window.setInterval(scan, POLL_MS);
