export const VISUALIZATION_INTERVALS = Object.freeze({ "5m": 300, "15m": 900, "1h": 3600, "4h": 14400 });
export const DEFAULT_VISUALIZATION_INTERVAL = "15m";
export const OPEN_INTEREST_INTERVALS = VISUALIZATION_INTERVALS;
export const DEFAULT_OPEN_INTEREST_INTERVAL = "5m";

export function normalizeVisualizationSelections(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const selections = {};
  Object.keys(value).forEach(function (contract) {
    if (VISUALIZATION_INTERVALS[value[contract]]) selections[contract] = value[contract];
  });
  return selections;
}

export function getVisualizationInterval(selections, contract) {
  return selections && VISUALIZATION_INTERVALS[selections[contract]] ?
    selections[contract] : DEFAULT_VISUALIZATION_INTERVAL;
}

export function setVisualizationInterval(selections, contract, interval) {
  if (!contract || !VISUALIZATION_INTERVALS[interval]) return Object.assign({}, selections || {});
  return Object.assign({}, selections || {}, { [contract]: interval });
}

export function removeVisualizationContract(selections, contract) {
  const updated = Object.assign({}, selections || {});
  delete updated[contract];
  return updated;
}

export function normalizeOpenInterestSelections(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const selections = {};
  Object.keys(value).forEach(function (contract) {
    if (OPEN_INTEREST_INTERVALS[value[contract]]) selections[contract] = value[contract];
  });
  return selections;
}

export function getOpenInterestInterval(selections, contract) {
  return selections && OPEN_INTEREST_INTERVALS[selections[contract]] ?
    selections[contract] : DEFAULT_OPEN_INTEREST_INTERVAL;
}

export function setOpenInterestInterval(selections, contract, interval) {
  if (!contract || !OPEN_INTEREST_INTERVALS[interval]) return Object.assign({}, selections || {});
  return Object.assign({}, selections || {}, { [contract]: interval });
}
