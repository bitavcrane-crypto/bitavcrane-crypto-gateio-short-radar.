const STEP = 300;
const valid = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

// ContractStat aggregates, not individual trades or inferred openings of positions.
// Exclude the latest possibly forming interval. Never interpolate missing buckets.
export function buildGateContext(rows, nowSeconds) {
  if (!Array.isArray(rows) || !Number.isFinite(nowSeconds)) return [];
  const samples = new Map();
  for (const row of rows) {
    if (!row || !Number.isInteger(row.time) || row.time <= 0 || row.time + STEP > nowSeconds) continue;
    if (samples.has(row.time)) samples.set(row.time, { time: row.time });
    else samples.set(row.time, row);
  }
  const result = [];
  let previous = null;
  let cumulative = 0;
  let segment = 0;
  let continuous = false;
  for (const row of [...samples.values()].sort((a, b) => a.time - b.time)) {
    if (previous !== null && row.time - previous !== STEP) {
      result.push({ time: previous + Math.min(STEP, (row.time - previous) / 2), buy: null, sell: null, delta: null,
        cumulative: null, longLiquidations: null, shortLiquidations: null, segment: null });
      continuous = false;
    }
    const buy = valid(row.longTakerVolume) ? row.longTakerVolume : null;
    const sell = valid(row.shortTakerVolume) ? row.shortTakerVolume : null;
    const delta = buy !== null && sell !== null ? buy - sell : null;
    if (delta === null) {
      continuous = false;
    } else {
      if (!continuous) { cumulative = 0; segment += 1; }
      cumulative += delta;
      continuous = true;
    }
    result.push({ time: row.time, buy, sell, delta, cumulative: delta === null ? null : cumulative,
      segment: delta === null ? null : segment,
      longLiquidations: valid(row.longLiquidationSize) ? row.longLiquidationSize : null,
      shortLiquidations: valid(row.shortLiquidationSize) ? row.shortLiquidationSize : null });
    previous = row.time;
  }
  return result;
}

export function indicatorState({ enabled, loading = false, error = null, points = 0, required = 2,
  latestTime = null, nowSeconds = Date.now() / 1000, maxAge = null, unavailableReason = "" }) {
  if (!enabled) return { kind: "off", label: "Вимкнено", detail: "Увімкніть, щоб показати графік." };
  if (unavailableReason) return { kind: "missing", label: "Немає даних", detail: unavailableReason };
  if (points >= required) {
    const stale = Number.isFinite(maxAge) && (!Number.isFinite(latestTime) ||
      latestTime > nowSeconds + 30 || nowSeconds - latestTime > maxAge);
    return error || stale ?
      { kind: "stale", label: "Історичні дані", detail: error || "Джерело не оновилося вчасно; це не поточне підтвердження." } :
      { kind: "ready", label: "Дані доступні", detail: "Показано фактичні дані відповідного джерела." };
  }
  if (loading) return { kind: "loading", label: "Завантаження", detail: "Очікуємо відповідь джерела." };
  if (error) return { kind: "error", label: "Недоступно", detail: error };
  return { kind: "missing", label: points ? "Недостатньо історії" : "Немає даних",
    detail: points ? `Є ${points}; потрібно щонайменше ${required} фактичних точок.` :
      "Джерело не повернуло потрібні поля. Відсутність даних не означає нуль." };
}
