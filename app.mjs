import { addPair, buildMarketData, normalizeCandles, removePair, sortPairsBySignal, transitionSignal, validatePairList } from "./core.mjs";
import { fetchCandles, fetchContracts, fetchContractStats, fetchOrderBook, fetchTickers, fetchVisualizationCandles, normalizeContract, normalizeContractStats, normalizeOrderBook, normalizeTicker } from "./gate-api.mjs";
import { DEFAULT_CONFIRMATION_SETTINGS, evaluateShortConfirmation, normalizeConfirmationSettings } from "./indicator-confirmation.mjs";
import { buildIndicatorVisualization } from "./indicator-visualization.mjs";
import { getVisualizationInterval, normalizeVisualizationSelections, removeVisualizationContract, setVisualizationInterval, VISUALIZATION_INTERVALS } from "./visualization-state.mjs";

const DEFAULT_PAIRS = ["BTC_USDT", "ETH_USDT", "SOL_USDT"];
const PAIR_KEY = "gate-short-radar-pairs";
const CONFIRMATION_KEY = "gate-short-radar-confirmation-settings";
const VISUALIZATION_SETTINGS_KEY = "gate-short-radar-visualization-settings";
const VISUALIZATION_STATE_KEY = "gate-short-radar-visualization-state";
const MINIMUM_RISK_REWARD_KEY = "gate-short-radar-minimum-risk-reward";
const DEFAULT_VISUALIZATION_SETTINGS = {
  rci: { periods: [6, 12, 24] }, ema: { periods: [200, 55, 22] }
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
let minimumRiskReward = loadMinimumRiskReward();
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
  return {
    rci: { periods: periodList("rci", "periods", DEFAULT_VISUALIZATION_SETTINGS.rci.periods, 2, 100) },
    ema: { periods: periodList("ema", "periods", DEFAULT_VISUALIZATION_SETTINGS.ema.periods, 2, 500) }
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
    return normalizeVisualizationSelections(JSON.parse(localStorage.getItem(VISUALIZATION_STATE_KEY) || "{}"));
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
  return getVisualizationInterval(visualizationSelections, contract);
}

function currentChartSettings() {
  return {
    rci: visualizationSettings.rci,
    obv: confirmationSettings.obv,
    ema: visualizationSettings.ema,
    kdj: confirmationSettings.kdj
  };
}

function loadPairs() {
  try {
    const value = JSON.parse(localStorage.getItem(PAIR_KEY) || "null");
    return Array.isArray(value) ? validatePairList(value, value.filter(function (pair) {
      return typeof pair === "string";
    }).map(function (pair) { return pair.trim().toUpperCase(); })) : DEFAULT_PAIRS.slice();
  } catch (error) {
    return DEFAULT_PAIRS.slice();
  }
}

function loadMinimumRiskReward() {
  try {
    const value = Number(localStorage.getItem(MINIMUM_RISK_REWARD_KEY));
    return Number.isFinite(value) && value >= 1 && value <= 5 ? value : 1.5;
  } catch (error) {
    return 1.5;
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

function renderStrategyPanel(model) {
  const strategy = model.strategy;
  if (!strategy) return "";
  const matrix = ["15m", "1h", "4h"].map(function (interval) {
    const row = strategy.matrix[interval];
    return '<div class="strategy-matrix-row"><strong>' + interval + '</strong><span>' +
      escapeHtml(row.label) + "</span><small>Ціна " + formatPercent(model.data.changes[interval]) +
      " · OI " + formatPercent(model.data.oiChanges[interval]) + "</small>" +
      (strategy.matrixTransitions && strategy.matrixTransitions[interval] ?
        '<small class="scenario-transition">Перехід: ' +
          escapeHtml(strategy.matrixTransitions[interval]) + "</small>" : "") + "</div>";
  }).join("");
  const scoreReasons = strategy.scoreReasons.length ? strategy.scoreReasons.join(" · ") : "Підтвердження для балів відсутні";
  const optionalMissing = strategy.missingScoreData.filter(function (field) {
    return !strategy.missing.includes(field);
  });
  const missing = strategy.missing.length ? strategy.missing.join(" · ") :
    strategy.dataReady ? "Немає" : "якість обов’язкових даних не підтверджена";
  const blockers = strategy.blockers.length ? Array.from(new Set(strategy.blockers)).join(" · ") : "Блокувань немає";
  const setup = strategy.setup ? strategy.setupStatus + " · " + strategy.setup.type +
    " · рівень " + formatNumber(strategy.setup.level, 8) : "Формацію не знайдено";
  const updateTime = model.data.orderBook && model.data.orderBook.fetchedAt ?
    new Date(model.data.orderBook.fetchedAt).toLocaleTimeString("uk-UA") : "немає";
  const latestCandle = model.data.candles15[model.data.candles15.length - 1];
  const confirmation = latestCandle ? "закриття 15m " + formatNumber(latestCandle.close, 8) +
    " · " + new Date((latestCandle.time + 900) * 1000).toLocaleString("uk-UA") : "закриття недоступне";
  const levels = model.levels ? "Entry " + formatNumber(model.levels.entry, 8) +
    " · Stop " + formatNumber(model.levels.stop, 8) + " · TP1/2/3 " +
    [model.levels.tp1, model.levels.tp2, model.levels.tp3].map(function (value) {
      return formatNumber(value, 8);
    }).join(" / ") + " · Gross R/R 1 : " + formatNumber(strategy.riskReward, 2) +
    " · Net R/R 1 : " + formatNumber(strategy.netRiskReward, 2) + " (" + strategy.riskRewardBasis + ")" :
    "Entry/Stop/цілі не розраховані";
  return '<section class="strategy-panel"><div class="strategy-heading"><strong>Price × OI · ' +
    escapeHtml(setup) + '</strong><span>' + escapeHtml(strategy.status) + "</span></div>" +
    '<div class="strategy-matrix">' + matrix + "</div><p><strong>SHORT SCORE " + strategy.score +
    "/100:</strong> " + escapeHtml(scoreReasons) +
    (optionalMissing.length ? " · Додаткові дані для score: " + escapeHtml(optionalMissing.join(" · ")) : "") +
    "</p><p><strong>Відсутні дані:</strong> " +
    escapeHtml(missing) + "</p><p><strong>Блокування:</strong> " + escapeHtml(blockers) +
    "</p><p><strong>Ліквідність:</strong> " + escapeHtml(strategy.liquidity.passed ?
      "ліквідність і спред придатні" : "непридатна або неперевірена; причини наведені вище") +
    "</p><p><strong>Рівні:</strong> " + escapeHtml(levels) + " · " + escapeHtml(confirmation) +
    "</p><p class=\"strategy-time\">Книга заявок оновлена: " + escapeHtml(updateTime) +
    " · поріг R/R: 1 : " + formatNumber(strategy.minimumRiskReward, 2) + "</p></section>";
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
  const markers = (options.markers || []).map(function (index) {
    const position = x(index, options.markerLength || 1);
    return '<line x1="' + position + '" y1="0" x2="' + position + '" y2="' + height +
      '" stroke="#ff958c" stroke-dasharray="3 3"/>';
  }).join("");
  const paths = seriesList.map(function (series) {
    const points = series.values.map(function (value, index) {
      return typeof value === "number" && Number.isFinite(value) ? x(index, series.values.length) + "," + y(value) : null;
    }).filter(Boolean);
    return points.length > 1 ? '<polyline fill="none" stroke="' + series.color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="' +
      points.join(" ") + '"/>' : "";
  }).join("");
  return '<svg class="indicator-chart-svg" viewBox="0 0 320 104" role="img" aria-label="' +
    escapeHtml(options.label) + '" preserveAspectRatio="none">' + backgrounds + guides + markers + paths + "</svg>";
}

function directionLabel(value) {
  return value === "bullish" ? "зростає" : value === "bearish" ? "спадає" : "нейтральний";
}

function hasBullishFourHourTrend(pair, interval) {
  if (interval === "4h") return false;
  const model = models[pair];
  const candles = model && model.data && model.data.candles && model.data.candles["4h"];
  if (!Array.isArray(candles) || !candles.length) return false;
  const contextSettings = {
    rci: { periods: [6] }, obv: { lookback: 10 }, ema: { periods: [55, 22] },
    kdj: { period: 9, ma1: 3, ma2: 3 }
  };
  const context = buildIndicatorVisualization(candles, contextSettings,
    Math.floor(Date.now() / 1000), VISUALIZATION_INTERVALS["4h"]);
  return context.status === "ok" && context.indicators.ema.lines.length === 2 &&
    context.indicators.ema.lines.every(function (line) {
      return Number.isFinite(line.value) && line.direction === "bullish" &&
        context.indicators.ema.close > line.value;
    });
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
  const view = buildIndicatorVisualization(data.candles, currentChartSettings(), Math.floor(Date.now() / 1000),
    VISUALIZATION_INTERVALS[interval]);
  if (view.status === "incomplete") {
    return header + '<div class="visualization-meta">Остання свічка: ' + escapeHtml(lastCandle) +
      " · дані оновлено: " + cacheTime + '</div><p class="visualization-message">Недостатньо історії для розрахунку · у послідовності свічок є пропуск або некоректна мітка часу.</p>';
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
    (ema.crosses.length ? ema.crosses.map(function (cross) {
      return cross.periods.join("/") + " " + cross.direction;
    }).join(", ") : "немає") + "</p>" +
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
        " · J " + formatNumber(kdj.j, 1) + " · напрямки K/D/J: " + directionLabel(kdj.directions.k) + " / " +
        directionLabel(kdj.directions.d) + " / " + directionLabel(kdj.directions.j) + " · перетин: " +
        (kdj.cross === "unavailable" ? "недоступний" : kdj.cross === "none" ? "немає" : kdj.cross) +
        " · можливе виснаження: " + (kdj.possibleExhaustion ? "так" : "не визначено") + "</p>" +
      chartSvg([
        { values: kdj.kValues, color: "#77c8ff" },
        { values: kdj.dValues, color: "#f18c8c" },
        { values: kdj.jValues, color: "#c59bff" }
      ], { guides: [20, 50, 80], label: "KDJ" });
  const model = models[pair];
  const shortTermTurn = ema.direction === "bearish" || kdj.cross === "bearish" ||
    rci.possibleReversalDown || kdj.possibleExhaustion ||
    (obv.direction === "bearish" && Number.isFinite(obv.change) && obv.change < 0);
  const higherTrendConflict = shortTermTurn && hasBullishFourHourTrend(pair, interval);
  const summary = model && model.state ? "Базовий радар: " + model.state.label +
    ". Індикатори цього таймфрейму — окремий контекст; потрібне підтвердження ціною." :
    "Базовий радар очікує дані. Графіки не змінюють його сигнали.";
  return header + (data.error ? '<p class="visualization-message">Дані тимчасово недоступні · показано останній успішний набір · ' +
    escapeHtml(data.error) + " · останнє успішне оновлення: " + cacheTime + "</p>" : "") +
    '<div class="visualization-meta">' + view.candles.length + " закритих " + interval +
    " свічок · остання свічка: " + escapeHtml(lastCandle) + " · дані оновлено: " + cacheTime + "</div>" +
    '<div class="indicator-chart-grid">' +
    '<section class="indicator-chart-card"><h4>RCI · ' + rci.periods.join(" / ") + "</h4>" + rciContent + "</section>" +
    '<section class="indicator-chart-card"><h4>OBV · SMA / Δ ' + obv.lookback + "</h4>" + obvContent + "</section>" +
    '<section class="indicator-chart-card"><h4>Ціна / EMA · ' + ema.periods.join(" / ") + "</h4>" + emaContent + "</section>" +
    '<section class="indicator-chart-card"><h4>KDJ · ' + kdj.period + " / " + kdj.ma1 + " / " + kdj.ma2 +
    "</h4>" + kdjContent + "</section></div>" +
    (model && model.data ? (function () {
      const recent = model.data.candles["15m"].slice(-40);
      const oiHistory = model.data.stats.history.slice(-40);
      return '<div class="indicator-chart-grid market-chart-grid">' +
        '<section class="indicator-chart-card"><h4>Ціна · 15m</h4>' +
        chartSvg([{ values: recent.map(function (candle) { return candle.close; }), color: "#f3f5f7" }],
          {
            label: "Ціна close, 15m",
            guides: model.strategy.setup ? [model.strategy.setup.level] : [],
            markers: recent.length ? [recent.length - 1] : [],
            markerLength: recent.length
          }) + "</section>" +
        '<section class="indicator-chart-card"><h4>Обсяг · 15m</h4>' +
        chartSvg([{ values: recent.map(function (candle) { return candle.volume; }), color: "#e8b86d" }],
          { label: "Обсяг контрактів, 15m" }) + "</section>" +
        '<section class="indicator-chart-card"><h4>Open Interest · 5m історія</h4>' +
        chartSvg([{ values: oiHistory.map(function (row) { return row.openInterest; }), color: "#49d4a5" }],
        { label: "Open Interest з Gate.io contract stats" }) + "</section></div>";
    })() : "") +
    '<p class="visualization-summary">' + escapeHtml(summary) +
    (higherTrendConflict ? " Старший 4h підтверджує висхідний тренд, тоді як молодший інтервал показує ознаки розвороту: це ризик контртрендового входу." :
      " Перекупленість сама по собі не є умовою SHORT; підтвердження ціною залишається необхідним.") + "</p>";
}

function renderVisualizationControl(pair) {
  const open = openVisualizations.has(pair);
  const id = "visualization-" + pair.replace(/[^a-zA-Z0-9_-]/g, "-");
  return '<button class="visualization-toggle" type="button" data-visualization="' + escapeHtml(pair) +
    '" aria-controls="' + id + '" aria-expanded="' + open + '">📊 Візуалізація</button>' +
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
  const funding = formatFunding(data);
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
      '</div><p class="quality-note">Gross R:R до TP1 = 1 : ' + formatNumber(levelData.riskReward, 2) +
        ' · Net R:R = 1 : ' + formatNumber(model.strategy.netRiskReward, 2) +
      ' · *Оцінка за закриттям 15m' + (levelData.valid === false ?
        " · NO TRADE: рівні невалідні" : "") +
      '</p>' : '<p class="quality-note">Entry/Stop/TP з’являться лише для знайденого сетапу з локальною інвалідацією.</p>';
  const qualityNotes = [];
  if (model.quality !== "OK") qualityNotes.push("Якість оцінки: " + model.quality);
  if (model.state.key === "incomplete" && model.quality === "STALE") {
    qualityNotes.push("Показані останні отримані значення; нові дані недоступні");
  }
  if (!Number.isFinite(data.indicators.rsi) || !data.indicators.macd) qualityNotes.push("Історії свічок недостатньо для всіх індикаторів");
  return '<article class="card"><div class="card-head"><div><h2 class="pair-name">' + escapeHtml(pair) +
    '</h2><p class="price">Остання ціна: ' + formatNumber(ticker.last, 8) +
    (ticker.mark !== null ? " · mark " + formatNumber(ticker.mark, 8) : "") +
    (ticker.index !== null ? " · index " + formatNumber(ticker.index, 8) : "") +
    '</p></div><button class="remove-button" type="button" data-remove="' + escapeHtml(pair) +
    '" aria-label="Видалити ' + escapeHtml(pair) + '">✕</button></div>' +
    displayState(model) +
    '<div class="scores">' + score("PUMP", model.pumpScore) + score("EXHAUSTION", model.exhaustionScore) +
    score("SHORT", model.shortScore) + '</div><div class="metrics">' +
    ["5m", "15m", "1h", "4h"].map(function (timeframe) {
      return metric("Ціна · " + timeframe, formatPercent(data.changes[timeframe]), data.qualities[timeframe]);
    }).join("") +
    metric("Обсяг · ratio / 24h", data.volumeRatio === null ? "Немає даних" :
      formatNumber(data.volumeRatio, 2) + "x · $" + formatNumber(ticker.volume24h, 0),
      data.volumeRatio === null || ticker.volume24h === null ? "INCOMPLETE" : "OK") +
    metric("OI · контракти / USD", stats.openInterest === null ? "Немає даних" :
      formatNumber(stats.openInterest, 2) + " / $" + formatNumber(stats.openInterestUsd, 2),
      openInterestQuality) +
    metric("Δ OI · 15m / 1h / 4h", formatPercent(data.oiChanges["15m"]) + " / " +
      formatPercent(data.oiChanges["1h"]) + " / " + formatPercent(data.oiChanges["4h"]),
      stats.quality === "OK" && oiChangesComplete ? "OK" : "INCOMPLETE") +
    metric("Price × OI · 15m / 1h / 4h", model.strategy ?
      model.strategy.matrix["15m"].label + " / " + model.strategy.matrix["1h"].label + " / " +
        model.strategy.matrix["4h"].label : "Немає даних",
      model.strategy && model.strategy.dataReady ? "OK" : "INCOMPLETE") +
    metric("Спред / slippage $1000 / min bid/ask ±0,5%", data.orderBook && data.orderBook.quality === "OK" ?
      formatNumber(data.orderBook.spreadPercent, 3) + "% / " +
        formatPercent(data.orderBook.slippagePercent) + " / $" + formatNumber(data.orderBook.depthUsd, 0) :
      "NO TRADE · дані недоступні", data.orderBook && data.orderBook.quality === "OK" ?
        model.strategy.liquidity.passed ? "OK" : "NO TRADE" : data.orderBook ? data.orderBook.quality : "NO DATA") +
    metric("Funding / період", funding + " / " + interval,
      ticker.quality !== "OK" ? ticker.quality : !Number.isFinite(data.fundingNormalized) ? "INCOMPLETE" : "OK") +
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
    '</div>' + levels + renderStrategyPanel(model) + renderConfirmation(model) +
    '<p class="why"><strong>Чому?</strong> ' + escapeHtml(model.why) + '</p>' +
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
      visualizationSelections = removeVisualizationContract(visualizationSelections, pair);
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
      visualizationSelections = setVisualizationInterval(visualizationSelections, pair, select.value);
      saveVisualizationSelections();
      ensureVisualizationData(pair, select.value);
      render();
    });
  });
}

async function ensureVisualizationData(contract, interval) {
  if (!VISUALIZATION_INTERVALS[interval]) return;
  if (!visualizationData[contract]) visualizationData[contract] = {};
  const existing = visualizationData[contract][interval] || {};
  if (existing.loading || (existing.updatedAt && Date.now() - existing.updatedAt < POLL_MS && !existing.error)) return;
  existing.loading = true;
  delete existing.error;
  visualizationData[contract][interval] = existing;
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
    visualizationData[contract][interval] = existing;
    render();
  }
}

function refreshOpenVisualizations() {
  openVisualizations.forEach(function (contract) {
    ensureVisualizationData(contract, selectedVisualizationInterval(contract));
  });
}

function formatFunding(data) {
  const funding = data.funding;
  if (!funding || !Number.isFinite(funding.normalized)) return "UNKNOWN (ставка/період недоступні)";
  return formatNumber(funding.normalized * 100, 4) + "%/8h · raw " +
    formatNumber(funding.raw * 100, 4) + "%/" + formatNumber(funding.intervalSeconds / 3600, 1) +
    "h · " + (funding.raw > 0 ? "LONG платять SHORT" : funding.raw < 0 ? "SHORT платять LONG" : "нейтральний") +
    " · " + (funding.fetchedAt ? new Date(funding.fetchedAt).toLocaleTimeString("uk-UA") : "час невідомий");
}

function notifyChange(pair, oldState, newState, model) {
  if (!oldState || oldState === newState || newState === "incomplete" || newState === "none") return;
  if (newState === "entry" && (!model || !model.confirmed || !model.strategy ||
      !model.strategy.allowed || !model.strategy.dataReady || model.strategy.blockers.length ||
      model.strategy.missing.length)) return;
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
  const unavailableReason = "NO TRADE — DATA UNAVAILABLE: " + message;
  const strategy = models[pair].strategy ? Object.assign({}, models[pair].strategy, {
    allowed: false,
    dataReady: false,
    missingData: true,
    missing: ["останні дані застаріли: " + message],
    readiness: {
      ready: false,
      missing: ["останні дані застаріли: " + message],
      timeframes: Object.fromEntries(["15m", "1h", "4h"].map(function (interval) {
        return [interval, { ready: false, missing: ["candles." + interval + ": оновлення не вдалося"] }];
      }))
    },
    status: "DATA UNAVAILABLE",
    setupStatus: models[pair].strategy.setup ? "SETUP DETECTED" : null,
    setupConfirmed: false,
    liquidity: { passed: false, reasons: ["останні дані застаріли"] },
    blockers: [unavailableReason],
    score: 0,
    scoreReasons: [],
    missingScoreData: ["останні дані застаріли"]
  }) : null;
  models[pair] = Object.assign({}, models[pair], {
    data: Object.assign({}, models[pair].data, {
      orderBook: Object.assign({}, models[pair].data.orderBook, { quality: "STALE" }),
      ticker: Object.assign({}, models[pair].data.ticker, { quality: "STALE" }),
      stats: Object.assign({}, models[pair].data.stats, { quality: "STALE" }),
      qualities: { "5m": "STALE", "15m": "STALE", "1h": "STALE", "4h": "STALE" }
    }),
    state: { key: "incomplete", label: "Дані недоступні", score: 0 },
    quality: "STALE",
    confirmed: false,
    pumpScore: null,
    exhaustionScore: null,
    shortScore: null,
    confidence: "Немає даних",
    levels: null,
    strategy: strategy,
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
  const value = { rci: { periods: [] }, ema: { periods: [] } };
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
    const contractMap = new Map();
    contracts.forEach(function (item) { contractMap.set(item.name, item); });
    const tickerMap = new Map();
    results[1].forEach(function (item) {
      if (item && typeof item.contract === "string") tickerMap.set(item.contract, item);
    });
    const failures = [];
    await mapLimited(pairs, 3, async function (pair) {
      try {
        if (!contractMap.has(pair)) throw new Error("Контракт відсутній в активному списку Gate.io; пару збережено");
        const settled = await Promise.allSettled([
          fetchCandles(pair, "5m"), fetchCandles(pair, "15m"),
          fetchCandles(pair, "1h"), fetchCandles(pair, "4h"),
          fetchContractStats(pair),
          fetchOrderBook(pair)
        ]);
        const fields = ["candles.5m", "candles.15m", "candles.1h", "candles.4h", "stats", "orderBook"];
        const responses = settled.map(function (result, index) {
          if (result.status === "fulfilled") return result.value;
          failures.push(pair + " " + fields[index] + ": " + result.reason.message);
          return index === 5 ? { quality: "NO DATA" } : [];
        });
        const ticker = normalizeTicker(tickerMap.get(pair), pair);
        const nowSeconds = Math.floor(Date.now() / 1000);
        const stats = normalizeContractStats(responses[4], nowSeconds);
        const orderBook = responses[5].quality === "NO DATA" ? responses[5] :
          normalizeOrderBook(responses[5], contractMap.get(pair) ? contractMap.get(pair).quantoMultiplier : null, Date.now());
        const model = buildMarketData({
          candles: { "5m": responses[0], "15m": responses[1], "1h": responses[2], "4h": responses[3] },
          ticker: ticker,
          stats: stats,
          orderBook: orderBook,
          fundingIntervalSeconds: contractMap.get(pair) ? contractMap.get(pair).fundingIntervalSeconds : null,
          takerFeeRate: contractMap.get(pair) ? contractMap.get(pair).takerFeeRate : null,
          minimumRiskReward: minimumRiskReward,
          nowSeconds: nowSeconds
        });
        const prior = models[pair];
        const signal = transitionSignal(model, prior, prior ? prior.candleTime : null);
        if (prior) notifyChange(pair, prior.state.key, signal.state.key, signal);
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

const riskRewardInput = document.getElementById("minimum-risk-reward");
riskRewardInput.value = String(minimumRiskReward);
riskRewardInput.addEventListener("change", function () {
  const value = Number(riskRewardInput.value);
  if (!Number.isFinite(value) || value < 1 || value > 5) {
    riskRewardInput.value = String(minimumRiskReward);
    noticeNode.hidden = false;
    noticeNode.textContent = "Мінімальний Reward/Risk має бути від 1 до 5.";
    return;
  }
  minimumRiskReward = value;
  try {
    localStorage.setItem(MINIMUM_RISK_REWARD_KEY, String(value));
  } catch (error) {
    noticeNode.hidden = false;
    noticeNode.textContent = "Параметр Reward/Risk не вдалося зберегти у localStorage.";
  }
  scan();
});

syncConfirmationControls();
syncVisualizationControls();
render();
scan();
window.setInterval(scan, POLL_MS);
