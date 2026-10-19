function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function timestampAtPosition(times, position) {
  if (!Array.isArray(times) || !times.length || !finite(position)) return null;
  const first = times[0];
  const last = times[times.length - 1];
  if (!finite(first) || !finite(last)) return null;
  if (times.length === 1 || first === last) return first;
  const target = first + Math.max(0, Math.min(1, position)) * (last - first);
  let nearest = null;
  let distance = Infinity;
  times.forEach(function (time) {
    if (!finite(time)) return;
    const candidate = Math.abs(time - target);
    if (candidate < distance) {
      nearest = time;
      distance = candidate;
    }
  });
  return nearest;
}

export function timestampPosition(times, timestamp) {
  if (!Array.isArray(times) || !times.length || !finite(timestamp)) return null;
  const first = times[0];
  const last = times[times.length - 1];
  if (!finite(first) || !finite(last) || timestamp < first || timestamp > last) return null;
  if (first === last) return timestamp === first ? 0.5 : null;
  return (timestamp - first) / (last - first);
}

export function valuesAtTimestamp(seriesList, timestamp) {
  if (!Array.isArray(seriesList) || !finite(timestamp)) return [];
  return seriesList.map(function (series) {
    if (!series || !Array.isArray(series.times) || !Array.isArray(series.values)) return null;
    const index = series.times.indexOf(timestamp);
    const value = index < 0 ? null : series.values[index];
    return finite(value) ? value : null;
  });
}

export function formatCrosshairTime(timestamp) {
  return finite(timestamp) ? new Date(timestamp * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC") :
    "Немає даних";
}

export function createCrosshairController(charts, onChange) {
  return {
    selectAt: function (sourceIndex, position) {
      if (!Array.isArray(charts) || !charts[sourceIndex]) return null;
      const timestamp = timestampAtPosition(charts[sourceIndex].times, position);
      if (timestamp === null) return null;
      if (typeof onChange === "function") {
        onChange(timestamp, charts.map(function (chart) {
          return {
            position: timestampPosition(chart.times, timestamp),
            values: valuesAtTimestamp(chart.series, timestamp)
          };
        }));
      }
      return timestamp;
    }
  };
}
