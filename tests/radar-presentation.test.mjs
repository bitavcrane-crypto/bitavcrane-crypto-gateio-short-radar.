import test from "node:test";
import assert from "node:assert/strict";
import { summarizeShort, rankShortCandidates, chartWindow, contextSeries, formatLevelPrice,
  readableTechnicalText } from "../radar-presentation.mjs";

test("confirmed entries rank before blocked setups; missing data is last even at high score", () => {
  const models = {
    missing: { shortScore: 100, strategy: { dataReady: false } },
    watch: { shortScore: 90, strategy: { dataReady: true, setup: {}, liquidity: { passed: true } } },
    entry: { shortScore: 85, confirmed: true, state: { key: "entry" },
      strategy: { dataReady: true, allowed: true } }
  };
  assert.deepEqual(rankShortCandidates(["missing", "watch", "entry"], models), ["entry", "watch", "missing"]);
  assert.match(summarizeShort(models.watch).title, /входу немає/);
  assert.notEqual(summarizeShort({ ...models.entry, confirmed: false }).tone, "ready");
});

test("plain-language conclusion explains low reward and liquidity without raw decimals", () => {
  const result = summarizeShort({ strategy: { dataReady: true, setup: {}, liquidity: { passed: false },
    netRiskReward: 0.04, minimumRiskReward: 1.5 } });
  assert.match(result.text, /ліквідність/);
  assert.match(result.text, /прибуток.*замалий/);
  assert.doesNotMatch(result.text, /0\.04|volumeRatio|depthUsd/);
});

test("expired historical entries cannot rank as near-entry setups", () => {
  const model = { strategy: { dataReady: true, setupConfirmed: true, setup: {},
    flags: { referenceExpired: true } } };
  assert.equal(summarizeShort(model).rank, 0);
  assert.match(summarizeShort(model).title, /неактуальний/);
});

test("chart compression and history navigation are clamped without lookahead", () => {
  assert.deepEqual(chartWindow(600, 240, 0), { start: 360, end: 600, count: 240, offset: 0 });
  assert.deepEqual(chartWindow(600, 600, 500), { start: 0, end: 600, count: 600, offset: 0 });
  assert.deepEqual(chartWindow(600, 120, 120), { start: 360, end: 480, count: 120, offset: 120 });
  assert.deepEqual(chartWindow(10, 600, -12), { start: 0, end: 10, count: 10, offset: 0 });
});

test("small-token levels keep precision and long technical floats are rounded for display only", () => {
  assert.notEqual(formatLevelPrice(0.00000012341), formatLevelPrice(0.00000012342));
  assert.notEqual(formatLevelPrice(0.002858), formatLevelPrice(0.002845));
  assert.equal(formatLevelPrice(null), "—");
  assert.match(readableTechnicalText("volumeRatio=0.36425629242156315"), /0,3643/);
});

test("context charts preserve real timestamps and explicit gaps; never fabricate zero data", () => {
  const series = contextSeries([{ time: 100, oi: 10 }, { time: 400, oi: 11 },
    { time: 1600, oi: 12 }, { time: 1700, oi: null }, { time: 2000, oi: 99 }],
  "oi", [100, 1800], 600);
  assert.deepEqual(series.times, [100, 400, 401, 1600]);
  assert.deepEqual(series.values, [10, 11, null, 12]);
});
