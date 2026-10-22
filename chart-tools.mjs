export const DEFAULT_CHART_LAYERS = Object.freeze({
  ema: true, rci: true, obv: true, volume: true, oi: true, funding: true,
  oiChange: false, topOi: true, taker: true, liquidations: true, whales: true, whaleMode: "levels"
});

export function normalizeChartLayers(value) {
  const result = { ...DEFAULT_CHART_LAYERS };
  if (!value || typeof value !== "object") return result;
  for (const key of Object.keys(result)) {
    if (key === "whaleMode") continue;
    if (typeof value[key] === "boolean") result[key] = value[key];
  }
  result.whaleMode = value.whaleMode === "history" ? "history" : "levels";
  return result;
}

export function axisTicks(minimum, maximum, count = 5) {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) return [];
  return Array.from({ length: count }, (_, index) => minimum + (maximum - minimum) * index / (count - 1));
}

export function timeAxisTicks(times) {
  if (!Array.isArray(times) || !times.length) return [];
  const indices = [...new Set([0, Math.floor((times.length - 1) / 2), times.length - 1])];
  return indices.map(index => {
    const time = times[index];
    if (!Number.isFinite(time) || !Number.isFinite(new Date(time * 1000).getTime())) return null;
    const date = new Date(time * 1000).toISOString();
    return { time, day: date.slice(8, 10) + "." + date.slice(5, 7), clock: date.slice(11, 16) };
  }).filter(Boolean);
}

export function formatChartValue(value, price = false, compact = false) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Немає даних";
  return new Intl.NumberFormat("uk-UA", price ?
    { maximumSignificantDigits: 8 } : compact ?
      { notation: "compact", maximumSignificantDigits: 4 } : { maximumSignificantDigits: 10 }).format(value);
}

export function chartReadout(series, values) {
  return series.map((item, index) => item.label + ": " + formatChartValue(values[index],
    item.price === true || item.digits === 8)).join(" · ");
}

export function oiChangeRows(rows) {
  return rows.map((row, index) => {
    const previous = rows[index - 1];
    const valid = previous && row.time - previous.time === 300 &&
      Number.isFinite(row.openInterest) && Number.isFinite(previous.openInterest);
    return { time: row.time, change: valid ? row.openInterest - previous.openInterest : null };
  });
}

export function layoutAxisLabels(items, top, bottom, gap = 16) {
  const sorted = items.map(item => ({ ...item, labelY: Math.max(top, Math.min(bottom, item.y)) }))
    .sort((a, b) => a.labelY - b.labelY);
  for (let index = 1; index < sorted.length; index++) {
    sorted[index].labelY = Math.max(sorted[index].labelY, sorted[index - 1].labelY + gap);
  }
  if (sorted.length && sorted.at(-1).labelY > bottom) {
    sorted.at(-1).labelY = bottom;
    for (let index = sorted.length - 2; index >= 0; index--) {
      sorted[index].labelY = Math.min(sorted[index].labelY, sorted[index + 1].labelY - gap);
    }
  }
  return sorted;
}
