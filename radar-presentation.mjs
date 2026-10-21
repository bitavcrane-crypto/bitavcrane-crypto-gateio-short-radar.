// Presentation only: readiness is not a calibrated probability of profit.
export function summarizeShort(model) {
  const strategy = model?.strategy;
  if (!strategy || !strategy.dataReady || model.quality === "STALE" || model.state?.key === "incomplete") {
    return { tone: "muted", rank: -1, title: "НЕ ВХОДИТИ · даних недостатньо",
      text: "Немає повного свіжого набору даних. Висновок про SHORT ненадійний." };
  }
  if (strategy.allowed && model.confirmed && model.state?.key === "entry") {
    return { tone: "ready", rank: 5, title: "SHORT ПІДТВЕРДЖЕНО",
      text: "Перевірки структури, ліквідності та ризику пройдено. Це не гарантія прибутку." };
  }
  if (strategy.flags?.shortSqueezeRisk) {
    return { tone: "danger", rank: 0, title: "НЕ ВХОДИТИ · ризик різкого відскоку",
      text: "Є ознаки небезпеки для шортів. Не переслідувати падіння." };
  }
  if (strategy.flags?.referenceExpired || strategy.flags?.lateEntry) {
    return { tone: "danger", rank: 0, title: "НЕ ВХОДИТИ · старий план уже неактуальний",
      text: strategy.flags.referenceExpired ? "Поточна ціна вже на або за Stop чи TP1. Потрібна нова формація." :
        "Ціна змістилася: потенціал поточного входу замалий порівняно з ризиком." };
  }
  if (strategy.setup) {
    const causes = [];
    if (!strategy.liquidity?.passed) causes.push("замала ліквідність або завеликі витрати");
    if (Number.isFinite(strategy.netRiskReward) && strategy.netRiskReward < strategy.minimumRiskReward) {
      causes.push("прибуток до першої цілі замалий порівняно з ризиком");
    }
    if (strategy.flags?.strongBullish4h) causes.push("старший тренд ще висхідний");
    if (strategy.flags?.matrixConflict) causes.push("ціна та OI дають суперечливі ознаки");
    return { tone: "watch", rank: strategy.setupConfirmed ? 4 : 3, title: "ЧЕКАТИ · формація є, входу немає",
      text: causes.length ? causes.slice(0, 2).join("; ") + "." :
        "Не всі обов’язкові перевірки пройдено. Технічні причини — під кнопкою нижче." };
  }
  return { tone: "watch", rank: model.state?.key === "exhaustion" ? 2 : 1,
    title: "СПОСТЕРІГАТИ · SHORT не підтверджено",
    text: "Сам памп, високий funding чи перекупленість не є підставою для входу." };
}

export function rankShortCandidates(pairs, models) {
  return pairs.map((pair, index) => ({ pair, index, model: models[pair] }))
    .sort((a, b) => summarizeShort(b.model).rank - summarizeShort(a.model).rank ||
      (b.model?.shortScore ?? -1) - (a.model?.shortScore ?? -1) || a.index - b.index)
    .map(item => item.pair);
}

export function formatLevelPrice(value) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  // Six significant digits, never the fixed six decimals that hid small-token levels.
  return value.toLocaleString("uk-UA", { maximumSignificantDigits: 8, useGrouping: false });
}

export function readableTechnicalText(value) {
  return String(value).replace(/-?\d+\.\d{5,}(?:e[+-]?\d+)?/gi, number =>
    Number(number).toLocaleString("uk-UA", { maximumFractionDigits: 4, useGrouping: false }));
}

export function chartWindow(length, count = 240, offset = 0) {
  const size = Math.min(length, Math.max(24, Math.min(600, Number(count) || 240)));
  const back = Math.max(0, Math.min(Math.max(0, length - size), Math.floor(Number(offset) || 0)));
  return { start: Math.max(0, length - back - size), end: length - back, count: size, offset: back };
}

export function contextSeries(rows, field, domainTimes, maxGapSeconds) {
  if (!Array.isArray(rows) || !domainTimes.length) return { times: [], values: [] };
  const byTime = new Map();
  rows.forEach(row => {
    if (Number.isFinite(row?.time) && row.time >= domainTimes[0] &&
        row.time <= domainTimes[domainTimes.length - 1] && Number.isFinite(row[field])) {
      byTime.set(row.time, row[field]);
    }
  });
  const times = [], values = [];
  [...byTime.keys()].sort((a, b) => a - b).forEach(time => {
    const previous = times[times.length - 1];
    if (Number.isFinite(previous) && time - previous > maxGapSeconds) {
      times.push(previous + 1); values.push(null);
    }
    times.push(time); values.push(byTime.get(time));
  });
  return { times, values };
}
