import test from "node:test";
import assert from "node:assert/strict";
import { axisTicks, timeAxisTicks, formatChartValue, normalizeChartLayers, oiChangeRows,
  layoutAxisLabels, chartReadout } from "../chart-tools.mjs";
import { createCrosshairController, valuesAtTimestamp, valueAtClientY } from "../chart-crosshair.mjs";

test("chart switches normalize only known booleans and never alter a strategy", () => {
  const layers = normalizeChartLayers({ ema: false, whales: false, volume: "false", bad: true, whaleMode: "bad" });
  assert.equal(layers.ema, false);
  assert.equal(layers.whales, false);
  assert.equal(layers.volume, true);
  assert.equal(layers.rci, true);
  assert.equal(normalizeChartLayers({ rci: false }).rci, false);
  assert.equal(layers.bad, undefined);
  assert.equal(layers.whaleMode, "levels");
  assert.equal(normalizeChartLayers({ whaleMode: "history" }).whaleMode, "history");
});

test("axes contain real values and UTC dates, including across midnight", () => {
  assert.deepEqual(axisTicks(10, 20), [10, 12.5, 15, 17.5, 20]);
  assert.deepEqual(axisTicks(NaN, 20), []);
  const start = Date.UTC(2026, 9, 21, 23, 45) / 1000;
  assert.deepEqual(timeAxisTicks([start, start + 900, start + 1800]).map(tick => [tick.day, tick.clock]),
    [["21.10", "23:45"], ["22.10", "00:00"], ["22.10", "00:15"]]);
  assert.equal(timeAxisTicks([start]).length, 1);
  assert.ok(formatChartValue(0.0000000012345678, true).includes("12345678"));
  assert.equal(formatChartValue(null), "Немає даних");
});

test("readout distinguishes missing data from zero and displays named series", () => {
  assert.match(chartReadout([{ label: "Close", digits: 8 }, { label: "OI" }], [0.00000123, null]),
    /Close:.*0,00000123.*OI: Немає даних/);
  assert.match(chartReadout([{ label: "Δ OI" }], [0]), /Δ OI: 0/);
});

test("OI changes require adjacent actual snapshots and preserve negative/zero deltas", () => {
  assert.deepEqual(oiChangeRows([
    { time: 300, openInterest: 100 }, { time: 600, openInterest: 100 },
    { time: 900, openInterest: 80 }, { time: 1500, openInterest: 200 }
  ]).map(row => row.change), [null, 0, -20, null]);
});

test("adjacent LONG/SHORT labels remain separate without changing the true reference prices", () => {
  const labels = layoutAxisLabels([{ side: "long", y: 150 }, { side: "short", y: 149 }], 10, 150);
  assert.equal(labels[1].labelY - labels[0].labelY, 16);
  assert.ok(labels.every(label => label.labelY >= 10 && label.labelY <= 150));
  assert.equal(labels.find(label => label.side === "long").y, 150);
});

test("touch Y maps to the actual price under the cursor, not the candle close", () => {
  assert.equal(valueAtClientY(150, { top: 100, height: 200 }, 200, 0, 100, 10, 20), 15);
  assert.equal(valueAtClientY(0, { top: 100, height: 200 }, 200, 0, 100, 10, 20), 20);
  assert.equal(valueAtClientY(NaN, { top: 100, height: 200 }, 200, 0, 100, 10, 20), null);
});

test("historical whale readout uses only preceding observations within the age bound, never future or gaps", () => {
  const series = [{ times: [100, 200, 201, 600], values: [10, 11, null, 12], asOf: true, maxAgeSeconds: 180 }];
  assert.deepEqual(valuesAtTimestamp(series, 99), [null]);
  assert.deepEqual(valuesAtTimestamp(series, 150), [10]);
  assert.deepEqual(valuesAtTimestamp(series, 300), [null]);
  assert.deepEqual(valuesAtTimestamp(series, 781), [null]);
  assert.deepEqual(valuesAtTimestamp(series, 600), [12]);
  assert.deepEqual(valuesAtTimestamp([{ times: [100], values: [10] }], 150), [null]);
});

test("crosshair uses the domain scale even if candle cursor anchors cover a shorter interval", () => {
  const chart = { times: [100, 200, 300], cursorTimes: [100, 200],
    series: [{ times: [100, 200], values: [1, 2] }] };
  let selected;
  createCrosshairController([chart], timestamp => { selected = timestamp; }).selectAt(0, 0.5);
  assert.equal(selected, 200);
});
