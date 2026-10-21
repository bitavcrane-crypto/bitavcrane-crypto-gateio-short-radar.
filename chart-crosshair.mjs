function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function timestampAtPosition(times, position, domainTimes = times) {
  if (!Array.isArray(times) || !times.length || !finite(position)) return null;
  const first = domainTimes[0];
  const last = domainTimes[domainTimes.length - 1];
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

export function positionAtClientX(clientX, bounds, viewBoxWidth, plotStart, plotEnd) {
  if (!finite(clientX) || !bounds || !finite(bounds.left) || !finite(bounds.width) || bounds.width <= 0 ||
      !finite(viewBoxWidth) || viewBoxWidth <= 0 || !finite(plotStart) || !finite(plotEnd) || plotEnd <= plotStart) {
    return null;
  }
  const viewX = (clientX - bounds.left) / bounds.width * viewBoxWidth;
  return (viewX - plotStart) / (plotEnd - plotStart);
}

export function valueAtPosition(value, minimum, maximum, plotTop, plotBottom) {
  if (!finite(value) || !finite(minimum) || !finite(maximum) || maximum <= minimum ||
      !finite(plotTop) || !finite(plotBottom) || plotBottom <= plotTop ||
      value < minimum || value > maximum) return null;
  return plotBottom - ((value - minimum) / (maximum - minimum)) * (plotBottom - plotTop);
}

export function valueAtClientY(clientY, bounds, viewBoxHeight, plotTop, plotBottom, minimum, maximum) {
  if (![clientY, bounds?.top, bounds?.height, viewBoxHeight, plotTop, plotBottom, minimum, maximum]
    .every(finite) || bounds.height <= 0 || viewBoxHeight <= 0 || plotBottom <= plotTop || maximum <= minimum) return null;
  const viewY = (clientY - bounds.top) / bounds.height * viewBoxHeight;
  const fraction = Math.max(0, Math.min(1, (viewY - plotTop) / (plotBottom - plotTop)));
  return maximum - fraction * (maximum - minimum);
}

export function valuesAtTimestamp(seriesList, timestamp) {
  if (!Array.isArray(seriesList) || !finite(timestamp)) return [];
  return seriesList.map(function (series) {
    if (!series || !Array.isArray(series.times) || !Array.isArray(series.values)) return null;
    let index = series.times.indexOf(timestamp);
    if (index < 0 && series.asOf === true && finite(series.maxAgeSeconds) && series.maxAgeSeconds >= 0) {
      // A historical observation is valid only at/after its own time, never from the future.
      for (let candidate = series.times.length - 1; candidate >= 0; candidate--) {
        if (series.times[candidate] <= timestamp) {
          if (timestamp - series.times[candidate] <= series.maxAgeSeconds) index = candidate;
          break;
        }
      }
    }
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
      const source = charts[sourceIndex];
      const timestamp = timestampAtPosition(source.cursorTimes || source.times, position, source.times);
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
