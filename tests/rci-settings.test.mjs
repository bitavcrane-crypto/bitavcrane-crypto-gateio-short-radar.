import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../app.mjs", import.meta.url), "utf8");
function fn(name) {
  const start = source.indexOf("function " + name + "(");
  const end = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, end);
}
const defaults = runInNewContext(source.match(/const DEFAULT_VISUALIZATION_SETTINGS = ([\s\S]*?\n});/)[0] +
  "\nDEFAULT_VISUALIZATION_SETTINGS;");
const normalize = runInNewContext(fn("normalizeVisualizationSettings") + "\nnormalizeVisualizationSettings;",
  { DEFAULT_VISUALIZATION_SETTINGS: defaults });

test("RCI migrates old saved periods to +95/+5 without losing EMA or confusing RSI", () => {
  const settings = normalize({ rci: { periods: [7, 13, 25] }, ema: { periods: [100, 40, 20] } });
  assert.deepEqual(Array.from(settings.rci.periods), [7, 13, 25]);
  assert.deepEqual(Array.from(settings.ema.periods), [100, 40, 20]);
  assert.equal(settings.rci.upper, 95);
  assert.equal(settings.rci.lower, 5);
  assert.equal(defaults.rci.upper, 95);
  assert.equal(defaults.rci.lower, 5);
});

test("RCI validates signed fractional levels, invalid types, bounds and reversed/equal thresholds", () => {
  const valid = normalize({ rci: { periods: [2, 50, 100], upper: "95.5", lower: "-5.5" } });
  assert.equal(valid.rci.upper, 95.5);
  assert.equal(valid.rci.lower, -5.5);
  assert.deepEqual(Array.from(valid.rci.periods), [2, 50, 100]);
  for (const bad of ["", " ", null, false, [], {}, NaN, Infinity, 101, -101]) {
    assert.equal(normalize({ rci: { upper: bad } }).rci.upper, 95);
    assert.equal(normalize({ rci: { lower: bad } }).rci.lower, 5);
  }
  for (const [upper, lower] of [[5, 95], [5, 5], [-95, 5]]) {
    const result = normalize({ rci: { upper, lower } });
    assert.equal(result.rci.upper, 95);
    assert.equal(result.rci.lower, 5);
  }
  assert.deepEqual(Array.from(normalize({ rci: { periods: [1, 12.5, 101] } }).rci.periods), [6, 12, 24]);
});

function controls() {
  const fields = [
    ["rci.0", "7"], ["rci.1", "13"], ["rci.2", "25"],
    ["rci.upper", "96.5"], ["rci.lower", "-4.5"],
    ["ema.0", "200"], ["ema.1", "55"], ["ema.2", "22"]
  ].map(([path, value]) => ({
    dataset: { visPeriod: path }, value, message: "", valid: true, reported: false,
    setCustomValidity(message) { this.message = message; },
    checkValidity() { return this.valid && !this.message; },
    reportValidity() { this.reported = true; }
  }));
  const stored = new Map();
  let renders = 0;
  const globals = {
    DEFAULT_VISUALIZATION_SETTINGS: defaults, visualizationSettings: normalize(null),
    VISUALIZATION_SETTINGS_KEY: "settings", noticeNode: {},
    document: { querySelectorAll: () => fields },
    localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    render: () => { renders++; }
  };
  const api = runInNewContext(["normalizeVisualizationSettings", "syncVisualizationControls",
    "readVisualizationControls", "loadVisualizationSettings"].map(fn).join("\n") +
    "\n({ readVisualizationControls, loadVisualizationSettings });", globals);
  return { ...api, globals, fields, stored, renders: () => renders };
}

test("RCI controls update all three periods and levels and survive a browser storage reload", () => {
  const harness = controls();
  harness.readVisualizationControls();
  const loaded = harness.loadVisualizationSettings();
  assert.deepEqual(Array.from(loaded.rci.periods), [7, 13, 25]);
  assert.equal(loaded.rci.upper, 96.5);
  assert.equal(loaded.rci.lower, -4.5);
  assert.equal(harness.renders(), 1);
  assert.equal(harness.fields[3].value, 96.5);
  assert.equal(harness.fields[4].value, -4.5);
});

test("invalid or crossed RCI levels cannot silently change the chart or saved parameters", () => {
  const harness = controls();
  harness.fields[4].value = "99";
  harness.readVisualizationControls();
  assert.match(harness.fields[4].message, /меншим/);
  assert.equal(harness.fields[4].reported, true);
  assert.equal(harness.stored.size, 0);
  assert.equal(harness.renders(), 0);
  harness.fields[4].value = "5";
  harness.readVisualizationControls();
  assert.equal(harness.fields[4].message, "");
  assert.equal(harness.renders(), 1);
  harness.fields[0].valid = false;
  harness.readVisualizationControls();
  assert.equal(harness.fields[0].reported, true);
  assert.equal(harness.renders(), 1);
});
