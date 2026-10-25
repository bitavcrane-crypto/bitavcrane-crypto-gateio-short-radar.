import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSqueezeEngine } from "../squeeze-engine.mjs";

const STEP = 300;
const start = 1_700_000_000;

function candles(count, interval, { trend = 0.001, volume = 10 } = {}) {
  let close = 100;
  return Array.from({ length: count }, (_, index) => {
    const open = close;
    close *= 1 + trend;
    return {
      time: start + index * interval,
      open,
      high: close * 1.002,
      low: open * 0.998,
      close,
      volume
    };
  });
}

function flowRows(statsRows, deltas = [5, 5, 5, -2, -2, -2]) {
  return statsRows.slice(-6).map((row, index) => ({
    time: row.time,
    delta: deltas[index]
  }));
}

function makeInput({
  spike = false,
  volumeSpike = true,
  missingVolume = false,
  missingOi = false,
  missingLiquidations = false,
  oiDirection = 1,
  liquidationSide = null,
  fundingRate = 0,
  verifiedFlow = false,
  flowDeltas,
  early = false,
  exhaustion = false,
  structureBreak = false,
  timeframeMismatch = false
} = {}) {
  const five = candles(40, STEP, { trend: 0.0005 });
  if (spike) {
    const previous = five.at(-2).close;
    five[five.length - 1] = {
      ...five.at(-1),
      open: previous,
      close: previous * 1.04,
      high: previous * 1.045,
      low: previous * 0.999,
      volume: volumeSpike ? 50 : 10
    };
  }
  if (early) {
    const prior = five.at(-5).close;
    five[five.length - 4].close = prior * 1.02;
    five[five.length - 4].high = prior * 1.021;
    five[five.length - 3].open = five[five.length - 4].close;
    five[five.length - 3].close = five[five.length - 4].close * 1.02;
    five[five.length - 3].high = five[five.length - 3].close * 1.001;
    five[five.length - 2].open = five[five.length - 3].close;
    five[five.length - 2].close = five[five.length - 3].close * 1.02;
    five[five.length - 2].high = five[five.length - 2].close * 1.001;
    five[five.length - 1].open = five[five.length - 2].close;
    five[five.length - 1].close = five[five.length - 2].close * 1.0001;
    five[five.length - 1].high = five[five.length - 1].close * 1.001;
    five[five.length - 1].volume = 20;
  }
  if (missingVolume) five.at(-1).volume = null;

  const fifteen = candles(24, 900, { trend: early || exhaustion ? 0.006 : 0.0005 });
  if (exhaustion || structureBreak) {
    const pivot = fifteen.at(-5).close;
    fifteen[fifteen.length - 4] = {
      ...fifteen.at(-4),
      open: pivot,
      close: pivot * 0.98,
      high: pivot * 1.002,
      low: pivot * 0.975
    };
    fifteen[fifteen.length - 3] = {
      ...fifteen.at(-3),
      open: pivot * 0.98,
      close: pivot * 0.982,
      high: pivot * 1.003,
      low: pivot * 0.979
    };
    fifteen[fifteen.length - 2] = {
      ...fifteen.at(-2),
      open: pivot * 0.982,
      close: pivot * 0.985,
      high: pivot * 0.994,
      low: pivot * 0.98
    };
    fifteen[fifteen.length - 1] = {
      ...fifteen.at(-1),
      open: pivot * 0.985,
      close: pivot * 0.9845,
      high: structureBreak ? pivot * 1.01 : pivot * 0.986,
      low: pivot * 0.975
    };
  }

  const statsRows = Array.from({ length: 20 }, (_, index) => {
    const time = start + index * STEP;
    const openInterest = index === 19 ? (oiDirection === 1 ? 104 : 96) :
      oiDirection === 1 ? (index >= 8 ? 102 : 100) : (index >= 8 ? 98 : 100);
    return {
      time,
      openInterest: missingOi ? null : openInterest,
      longLiquidationSize: missingLiquidations ? null : 0,
      shortLiquidationSize: missingLiquidations ? null : 0
    };
  });
  if (liquidationSide && !missingLiquidations) {
    statsRows.at(-1)[liquidationSide === "long" ?
      "longLiquidationSize" : "shortLiquidationSize"] = 10;
  }
  if (missingLiquidations) {
    statsRows.forEach(row => {
      delete row.longLiquidationSize;
      delete row.shortLiquidationSize;
    });
  }
  const input = {
    frames: {
      "5m": { timeframe: "5m", quality: "OK", candles: five },
      "15m": { timeframe: "15m", quality: "OK", candles: fifteen },
      "1h": { timeframe: "1h", quality: "OK", candles: candles(2, 3600) },
      "4h": { timeframe: "4h", quality: "OK", candles: candles(2, 14400) }
    },
    derivatives: { quality: "OK", rows: statsRows },
    funding: { quality: "OK", normalized8h: fundingRate },
    flow: {
      quality: verifiedFlow ? "OK" : "UNAVAILABLE",
      verified: verifiedFlow,
      source: "Gate.io verified test fixture",
      rows: flowRows(statsRows, flowDeltas)
    }
  };
  if (timeframeMismatch) input.frames["5m"].timeframe = "15m";
  return input;
}

test("price acceleration with abnormal volume confirms an independent spike", () => {
  const result = analyzeSqueezeEngine(makeInput({ spike: true }));
  assert.equal(result.spike.status, "CONFIRMED");
  assert.equal(result.spike.candidate, true);
  assert.equal(result.spike.components.priceAcceleration, 25);
  assert.equal(result.spike.components.volumeAnomaly, 25);
  assert.equal(result.shortConfirmation.status, "NO_TRADE");
});

test("price acceleration without abnormal volume is not a confirmed spike", () => {
  const result = analyzeSqueezeEngine(makeInput({ spike: true, volumeSpike: false }));
  assert.equal(result.spike.status, "NO_CONFIRMED_SPIKE");
  assert.equal(result.spike.candidate, false);
});

test("price, rising OI, and positive funding classify limited leverage pressure", () => {
  const result = analyzeSqueezeEngine(makeInput({
    spike: true,
    oiDirection: 1,
    fundingRate: 0.0006
  }));
  assert.equal(result.spike.type, "LEVERAGE_DRIVEN");
  assert.equal(result.spike.typeConfidence, "LIMITED");
  assert.equal(result.oiInterpretation, "LEVERAGE_BUILD_UP");
  assert.equal(result.squeeze.earlyCandidate, false);
});

test("rising price, falling OI, and short liquidations classify short covering", () => {
  const result = analyzeSqueezeEngine(makeInput({
    spike: true,
    oiDirection: -1,
    liquidationSide: "short"
  }));
  assert.equal(result.spike.type, "SHORT_COVERING");
  assert.equal(result.oiInterpretation, "SHORT_COVERING_CONFIRMED");
  assert.notEqual(result.shortConfirmation.status, "CONFIRMED");
});

test("falling price, falling OI, and long liquidations confirm a long squeeze", () => {
  const input = makeInput({ oiDirection: -1, liquidationSide: "long" });
  const last = input.frames["5m"].candles.at(-1);
  const previous = input.frames["5m"].candles.at(-2);
  input.frames["5m"].candles[input.frames["5m"].candles.length - 1] = {
    ...last,
    open: previous.close,
    close: previous.close * 0.98,
    high: previous.close * 1.001,
    low: previous.close * 0.975
  };
  const result = analyzeSqueezeEngine(input);
  assert.equal(result.squeeze.active, true);
  assert.equal(result.squeeze.direction, "LONG_SQUEEZE");
  assert.equal(result.oiInterpretation, "LONG_SQUEEZE_CONFIRMED");
});

test("rising price with verified bearish CVD is an independent flow divergence", () => {
  const result = analyzeSqueezeEngine(makeInput({
    spike: true,
    verifiedFlow: true,
    flowDeltas: [8, 7, 6, -2, -3, -4]
  }));
  assert.equal(result.squeeze.flowDivergence, true);
  assert.ok(result.availableMetrics.includes("CVD з підтвердженою семантикою"));
});

test("missing or unverified CVD never becomes neutral flow or confirmation", () => {
  const result = analyzeSqueezeEngine(makeInput({ spike: true }));
  assert.equal(result.metrics.find(metric => metric.name.startsWith("CVD")).value, null);
  assert.ok(result.missingMetrics.includes("CVD з підтвердженою семантикою"));
  assert.equal(result.spike.components.cvdImpulse, 0);
  assert.equal(result.squeeze.flowDivergence, false);
});

test("missing liquidation direction leaves an observed cascade unconfirmed", () => {
  const result = analyzeSqueezeEngine(makeInput({
    oiDirection: -1,
    missingLiquidations: true
  }));
  assert.equal(result.squeeze.active, false);
  assert.equal(result.squeeze.activeStatus, "UNCONFIRMED");
  assert.equal(result.squeeze.liquidation.long, null);
});

test("missing OI prevents leverage-based squeeze classification", () => {
  const result = analyzeSqueezeEngine(makeInput({
    spike: true,
    missingOi: true,
    fundingRate: 0.0006
  }));
  assert.equal(result.spike.type, null);
  assert.equal(result.squeeze.earlyCandidate, false);
  assert.equal(result.metrics.find(metric => metric.name === "зміна відкритого інтересу").value, null);
});

test("extreme price movement alone cannot create a short confirmation", () => {
  const result = analyzeSqueezeEngine(makeInput({
    spike: true,
    missingVolume: true,
    fundingRate: 0.001
  }));
  assert.equal(result.spike.candidate, false);
  assert.equal(result.shortConfirmation.status, "NO_TRADE");
});

test("a spike followed by stalled continuation can become an exhaustion candidate", () => {
  const result = analyzeSqueezeEngine(makeInput({
    spike: true,
    exhaustion: true,
    verifiedFlow: true,
    flowDeltas: [8, 7, 6, -2, -3, -4]
  }));
  assert.equal(result.exhaustion.candidate, true);
  assert.equal(result.exhaustion.status, "CANDIDATE");
});

test("exhaustion, failed structural retest, and bearish verified flow can confirm a short candidate", () => {
  const result = analyzeSqueezeEngine(makeInput({
    spike: true,
    exhaustion: true,
    structureBreak: true,
    oiDirection: 1,
    fundingRate: 0.0006,
    verifiedFlow: true,
    flowDeltas: [8, 7, 6, -2, -3, -4]
  }));
  assert.equal(result.exhaustion.confirmed, true, JSON.stringify({
    squeeze: result.squeeze,
    exhaustion: result.exhaustion,
    short: result.shortConfirmation
  }));
  assert.equal(result.shortConfirmation.evidence.bearishStructureBreakAndFailedRetest, true);
  assert.equal(result.shortConfirmation.status, "CONFIRMED", JSON.stringify({
    early: result.squeeze.earlyCandidate,
    pressure: result.squeeze.pressure,
    exhaustion: result.exhaustion,
    evidence: result.shortConfirmation.evidence
  }));
});

test("insufficient price or volume history reports DATA_INSUFFICIENT", () => {
  const input = makeInput({ missingVolume: true });
  input.frames["5m"].candles = input.frames["5m"].candles.slice(0, 10);
  const result = analyzeSqueezeEngine(input);
  assert.equal(result.status, "DATA_INSUFFICIENT");
  assert.equal(result.spike.status, "DATA_INSUFFICIENT");
  assert.equal(result.shortConfirmation.status, "NO_TRADE");
});

test("missing observations remain null and scores do not redistribute unavailable weights", () => {
  const input = makeInput({ spike: true });
  input.frames["5m"].candles.forEach(candle => {
    candle.high = null;
    candle.low = null;
  });
  const result = analyzeSqueezeEngine(input);
  assert.equal(result.metrics.find(metric => metric.name === "розширення ATR").value, null);
  assert.equal(result.spike.components.atrExpansion, 0);
  assert.equal(result.spike.components.cvdImpulse, 0);
  assert.ok(result.spike.score <= 75);
  assert.equal(result.metrics.find(metric => metric.name === "напрямок ліквідацій").value.long, 0);
});

test("timeframe labels and candle intervals are never silently mixed", () => {
  const mismatched = analyzeSqueezeEngine(makeInput({ timeframeMismatch: true }));
  assert.equal(mismatched.status, "DATA_INSUFFICIENT");
  const gapInput = makeInput();
  gapInput.frames["5m"].candles.at(-1).time += 60;
  const gapped = analyzeSqueezeEngine(gapInput);
  assert.equal(gapped.status, "DATA_INSUFFICIENT");
});

test("early squeeze may exist without liquidation evidence and remains separate from active squeeze", () => {
  const result = analyzeSqueezeEngine(makeInput({
    early: true,
    oiDirection: 1,
    fundingRate: 0.0006,
    missingLiquidations: true,
    verifiedFlow: true,
    flowDeltas: [8, 7, 6, -2, -3, -4]
  }));
  assert.equal(result.squeeze.earlyCandidate, true);
  assert.equal(result.squeeze.active, false);
  assert.equal(result.squeeze.activeStatus, "UNCONFIRMED");
  assert.ok(result.squeeze.pressure <= 100);
});
