function roundPeso(n) {
  // If you want always round up: return Math.ceil(n);
  return Math.round(n);
}

function normalizeRate(rate, fallback) {
  const parsed = Number(rate);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const DEFAULT_MATERIAL_MARKUP_RATE = normalizeRate(
  process.env.QUOTE_MATERIAL_MARKUP_RATE,
  0.1165
);
const DEFAULT_INSTALLATION_MARKUP_RATE = normalizeRate(
  process.env.QUOTE_INSTALLATION_MARKUP_RATE,
  0.112
);

function applyMarkup(basePrice, markupRate) {
  return roundPeso(Number(basePrice || 0) * (1 + normalizeRate(markupRate, 0)));
}

exports.DEFAULT_MATERIAL_MARKUP_RATE = DEFAULT_MATERIAL_MARKUP_RATE;
exports.DEFAULT_INSTALLATION_MARKUP_RATE = DEFAULT_INSTALLATION_MARKUP_RATE;
exports.applyMarkup = applyMarkup;

exports.applyMaterialMarkup = (basePrice, markupRate = DEFAULT_MATERIAL_MARKUP_RATE) => {
  return applyMarkup(basePrice, markupRate);
};

exports.applyInstallationMarkup = (
  basePrice,
  markupRate = DEFAULT_INSTALLATION_MARKUP_RATE
) => {
  return applyMarkup(basePrice, markupRate);
};

exports.computePanelKW = (panelQty, panelWatt) => {
  const totalWatt = Number(panelQty) * Number(panelWatt);
  return totalWatt / 1000;
};

exports.computeInstallation = (panelQty, panelWatt, ratePerWatt = 9) => {
  const totalWatt = Number(panelQty) * Number(panelWatt);
  return roundPeso(totalWatt * ratePerWatt);
};
