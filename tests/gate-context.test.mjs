import test from "node:test";
import assert from "node:assert/strict";
import { buildGateContext, indicatorState } from "../gate-context.mjs";
import { normalizeContract, normalizeContractStats } from "../gate-api.mjs";
import { normalizeChartLayers } from "../chart-tools.mjs";

const row = (time, buy = 10, sell = 4) => ({ time, longTakerVolume: buy,
  shortTakerVolume: sell, longLiquidationSize: 0, shortLiquidationSize: 2 });

test("Gate delta uses documented taker volumes in contracts, never inferred new positions", () => {
  const rows = buildGateContext([row(300), row(600, 2, 9), row(900, 0, 0)], 1200);
  assert.deepEqual(rows.map(r => r.delta), [6, -7, 0]);
  assert.deepEqual(rows.map(r => r.cumulative), [6, -1, -1]);
  assert.deepEqual(rows.map(r => r.longLiquidations), [0, 0, 0]);
  assert.deepEqual(rows.map(r => r.shortLiquidations), [2, 2, 2]);
});

test("forming/future aggregates are excluded; missing values never become zero", () => {
  const rows = buildGateContext([row(300), row(600, null, 4), row(900)], 901);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].delta, null);
  assert.equal(rows[1].cumulative, null);
  assert.deepEqual(buildGateContext(null, 1000), []);
});

test("gaps and duplicate timestamps break CVD; every continuous segment has its own baseline", () => {
  const rows = buildGateContext([row(300), row(900), row(1200), row(1200), row(1500)], 1800);
  assert.deepEqual(rows.map(r => r.time), [300, 600, 900, 1200, 1500]);
  assert.deepEqual(rows.map(r => r.cumulative), [6, null, 6, null, 6]);
  assert.deepEqual(rows.map(r => r.segment), [1, null, 2, null, 3]);
});

test("normalizer retains real taker fields, including zero, and explicit launch metadata", () => {
  const stats = normalizeContractStats([{ time: 300, long_taker_size: "0",
    short_taker_size: "12.5", long_liq_size: "0", short_liq_size: "2" }], 301);
  assert.equal(stats.rows[0].longTakerVolume, 0);
  assert.equal(stats.rows[0].shortTakerVolume, 12.5);
  assert.equal(normalizeContractStats([{ time: 300 }], 301).rows[0].longTakerVolume, null);
  assert.equal(normalizeContract({ name: "Q_USDT", launch_time: "1700000000" }).launchTime, 1700000000);
  assert.equal(normalizeContract({ name: "Q_USDT" }).launchTime, null);
});

test("layer states distinguish disabled, fetching, missing, insufficient and stale data", () => {
  assert.equal(indicatorState({ enabled: false, points: 10 }).kind, "off");
  assert.equal(indicatorState({ enabled: true, loading: true }).kind, "loading");
  assert.equal(indicatorState({ enabled: true, error: "HTTP 451" }).kind, "error");
  assert.equal(indicatorState({ enabled: true, points: 1 }).kind, "missing");
  assert.equal(indicatorState({ enabled: true, points: 10, latestTime: 100, nowSeconds: 1000, maxAge: 600 }).kind, "stale");
  assert.equal(indicatorState({ enabled: true, points: 10, latestTime: 900, nowSeconds: 1000, maxAge: 600 }).kind, "ready");
  assert.equal(indicatorState({ enabled: true, points: 10, unavailableReason: "Немає ринку Hyperliquid" }).kind, "missing");
  assert.equal(indicatorState({ enabled: true, points: 10, error: "Оновлення не вдалося" }).kind, "stale");
  const saved = normalizeChartLayers({ volume: false, taker: false });
  assert.equal(saved.volume, false);
  assert.equal(saved.taker, false);
  assert.equal(saved.liquidations, true);
});
