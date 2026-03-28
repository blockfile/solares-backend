const pool = require("../config/db");

function normalizeMaterialName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/mm\^?2/gi, "mm")
    .replace(/(\d)\.0(?=\s*mm)/gi, "$1")
    .replace(/\bblk\b/gi, "black")
    .replace(/\bblk\./gi, "black")
    .replace(/\bred\./gi, "red")
    .replace(/\bl[\s-]?foot\b/gi, "l foot")
    .replace(/\bl\s*foot\s*mounting\b/gi, "l foot bracket")
    .replace(/\broof\s+rail\b/gi, "railing")
    .replace(/\blipo4\b/gi, "lifepo")
    .replace(/\bpcs?\b/gi, "pc")
    .replace(/\bx\b/gi, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set([
  "the",
  "for",
  "with",
  "and",
  "of",
  "to",
  "in",
  "on",
  "set",
  "pc",
  "pcs",
  "roll",
  "meter",
  "m",
  "mm",
  "mm2",
  "mmx",
  "inch",
  "job"
]);

function compactNormalized(value) {
  return normalizeMaterialName(value).replace(/\s+/g, "");
}

function tokenize(value) {
  return normalizeMaterialName(value)
    .split(" ")
    .map((x) => x.trim().replace(/s$/i, ""))
    .filter((x) => x.length >= 2 && !STOP_WORDS.has(x));
}

function extractModelCodes(value) {
  const text = String(value || "").toLowerCase();
  const out = new Set();
  const re = /[a-z0-9]+(?:-[a-z0-9]+){1,}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const code = String(m[0] || "")
      .replace(/[^a-z0-9]/g, "")
      .trim();
    if (code.length >= 6) out.add(code);
  }
  return Array.from(out);
}

function extractNumberHints(value) {
  const text = String(value || "").toLowerCase();
  const kw = text.match(/(\d+(?:\.\d+)?)\s*kw\b/i);
  const watt = text.match(/(\d{3,4})\s*w\b/i);
  const ah = text.match(/(\d+(?:\.\d+)?)\s*ah\b/i);
  const amp = text.match(/(\d{1,3})\s*a\b/i);
  const pole = text.match(/(\d)\s*p\b/i);
  const color = text.match(/\b(red|black|blk|yellow|blue|white|green)\b/i);
  const normalizedColor = color
    ? String(color[1]).toLowerCase() === "blk"
      ? "black"
      : String(color[1]).toLowerCase()
    : null;
  return {
    kw: kw ? Number(kw[1]) : null,
    watt: watt ? Number(watt[1]) : null,
    ah: ah ? Number(ah[1]) : null,
    amp: amp ? Number(amp[1]) : null,
    pole: pole ? Number(pole[1]) : null,
    color: normalizedColor
  };
}

function detectItemSubgroup(description) {
  const text = normalizeMaterialName(description);

  if (
    text.includes("breaker box") ||
    text.includes("junction box") ||
    text.includes("metal enclosure") ||
    text.includes("enclosure") ||
    text.includes("ip65")
  ) {
    return "enclosure";
  }

  if (text.includes("battery") || text.includes("lifepo") || text.includes("lipo4") || /\bah\b/.test(text)) {
    return "battery";
  }

  if (
    text.includes("inverter") ||
    text.includes("deye") ||
    text.includes("solis") ||
    text.includes("hybrid") ||
    text.includes("grid tie") ||
    /\bsun\s*\d+/i.test(text)
  ) {
    return "inverter";
  }

  if (
    text.includes("solar panel") ||
    (text.includes("panel") && text.includes("mono")) ||
    /\b\d{3,4}\s*w\b/i.test(text)
  ) {
    return "panel";
  }

  if (text.includes("mccb")) return "mccb";
  if (text.includes("mcb") || text.includes("breaker")) return "mcb";
  if (text.includes("spd")) return "spd";
  if (text.includes("ats") || text.includes("mts")) return "ats_mts";

  if (
    text.includes("rail") ||
    text.includes("clamp") ||
    text.includes("lfoot") ||
    text.includes("l foot") ||
    text.includes("splice")
  ) {
    return "mounting";
  }

  if (text.includes("mc4") || text.includes("connector") || text.includes("pg") || text.includes("gland")) {
    return "connector";
  }

  if (text.includes("box") || text.includes("enclosure") || text.includes("junction")) return "enclosure";

  if (text.includes("wire") || text.includes("cable") || text.includes("thwn") || text.includes("awg")) {
    return "cable";
  }

  return "accessory";
}

function buildPreparedRow(row) {
  const normalized = row.normalized_name || normalizeMaterialName(row.material_name);
  const searchText = `${row.material_name || ""} ${row.source_section || ""}`.trim();
  return {
    ...row,
    normalized_name: normalized,
    _compact: compactNormalized(normalized),
    // Include source section context (brand/system type) for fuzzy matching.
    _tokens: tokenize(searchText),
    _models: extractModelCodes(searchText),
    _hints: extractNumberHints(searchText)
  };
}

async function getMaterialPriceIndex() {
  const [rows] = await pool.query(
    `SELECT id, material_name, normalized_name, unit, base_price, category, subgroup, source_section
     FROM material_prices`
  );

  const byExact = new Map();
  const byCompact = new Map();
  const byId = new Map();
  const byModel = new Map();
  const entries = [];

  for (const raw of rows) {
    const row = buildPreparedRow(raw);
    entries.push(row);
    byId.set(Number(row.id), row);

    if (row.normalized_name && !byExact.has(row.normalized_name)) {
      byExact.set(row.normalized_name, row);
    }

    if (row._compact && !byCompact.has(row._compact)) {
      byCompact.set(row._compact, row);
    }

    for (const code of row._models) {
      if (!byModel.has(code)) byModel.set(code, []);
      byModel.get(code).push(row);
    }
  }

  return { byExact, byCompact, byId, byModel, entries };
}

function hintScore(itemHints, rowHints) {
  let score = 0;

  if (itemHints.kw != null && rowHints.kw != null) {
    score += itemHints.kw === rowHints.kw ? 0.15 : -0.2;
  }

  if (itemHints.watt != null && rowHints.watt != null) {
    score += itemHints.watt === rowHints.watt ? 0.15 : -0.2;
  }

  if (itemHints.ah != null && rowHints.ah != null) {
    score += itemHints.ah === rowHints.ah ? 0.15 : -0.2;
  }

  if (itemHints.amp != null && rowHints.amp != null) {
    score += itemHints.amp === rowHints.amp ? 0.2 : -0.25;
  }

  if (itemHints.pole != null && rowHints.pole != null) {
    score += itemHints.pole === rowHints.pole ? 0.12 : -0.12;
  }

  if (itemHints.color && rowHints.color) {
    score += itemHints.color === rowHints.color ? 0.18 : -0.22;
  }

  return score;
}

function scoreCandidate(itemTokens, itemHints, modelSet, row, itemBasePrice) {
  if (!itemTokens.length || !row._tokens.length) return -1;

  let overlap = 0;
  const rowTokenSet = new Set(row._tokens);
  for (const token of itemTokens) {
    if (rowTokenSet.has(token)) overlap += 1;
  }
  if (overlap === 0) return -1;

  if (itemTokens.length >= 3 && overlap < 2 && modelSet.size === 0) {
    return -0.5;
  }

  const coverageItem = overlap / itemTokens.length;
  const coverageRow = overlap / row._tokens.length;
  let score = coverageItem * 0.7 + coverageRow * 0.3;

  if (modelSet.size && row._models.length) {
    let modelMatches = 0;
    for (const code of row._models) {
      if (modelSet.has(code)) modelMatches += 1;
    }
    if (modelMatches > 0) score += 0.4;
  }

  const base = Number(itemBasePrice || 0);
  const rowBase = Number(row.base_price || 0);
  if (base > 0 && rowBase > 0) {
    const rel = Math.abs(rowBase - base) / base;
    if (rel <= 0.02) score += 0.18;
    else if (rel <= 0.05) score += 0.1;
    else if (rel <= 0.1) score += 0.04;
    else if (rel >= 0.3) score -= 0.12;
  }

  score += hintScore(itemHints, row._hints);
  return score;
}

function pickBestCandidate(candidates, itemTokens, itemHints, modelSet, minScore, itemBasePrice) {
  if (!candidates.length) return null;

  let best = null;
  let bestScore = -1;

  for (const row of candidates) {
    const score = scoreCandidate(itemTokens, itemHints, modelSet, row, itemBasePrice);
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }

  if (!best) return null;
  if (bestScore < minScore) return null;
  return best;
}

const CURATED_ALIAS_RULES = [
  { pattern: /\bcanadian mono 650w\b/, target: "mono 615w cs6 2 66tb 615" },
  { pattern: /\boutdoor breaker box 18way\b/, target: "ip65 18ways" },
  { pattern: /\bspiral wrapping(?: black)? 16mm\b/, target: "spiral wrapping 16mm" },
  { pattern: /\bflexible conduit black\b/, target: "hdpe pipe ad34 5mm 50m roll" },
  { pattern: /\bac isolator\b/, target: "ac isolator 4p 63amps" },
  { pattern: /\bdc isolator\b/, target: "dc isolator 4p 32amps" }
];

function resolveCuratedAliasTarget(normalizedKey) {
  for (const rule of CURATED_ALIAS_RULES) {
    if (rule.pattern.test(normalizedKey)) return rule.target;
  }
  return null;
}

function findCatalogMatch(item, priceIndex) {
  const byIdKey = Number(item.catalog_material_id || item.catalogMaterialId || 0);
  if (byIdKey > 0 && priceIndex.byId.has(byIdKey)) {
    return priceIndex.byId.get(byIdKey);
  }

  const key = normalizeMaterialName(item.description);
  if (!key) return null;

  const exact = priceIndex.byExact.get(key);
  if (exact) return exact;

  const compact = compactNormalized(key);
  const compactHit = compact ? priceIndex.byCompact.get(compact) : null;
  if (compactHit) return compactHit;

  const aliasTarget = resolveCuratedAliasTarget(key);
  if (aliasTarget) {
    const aliasExact = priceIndex.byExact.get(aliasTarget);
    if (aliasExact) return aliasExact;

    const aliasCompact = priceIndex.byCompact.get(compactNormalized(aliasTarget));
    if (aliasCompact) return aliasCompact;
  }

  const models = extractModelCodes(item.description);
  const modelSet = new Set(models);
  const inferredSubgroup = String(item.catalog_subgroup || item.catalogSubgroup || detectItemSubgroup(item.description)).toLowerCase();
  const strictSubgroups = new Set([
    "panel",
    "inverter",
    "battery",
    "mcb",
    "mccb",
    "spd",
    "ats_mts",
    "mounting",
    "connector",
    "enclosure",
    "cable"
  ]);

  const subgroupPool = strictSubgroups.has(inferredSubgroup)
    ? priceIndex.entries.filter((row) => String(row.subgroup || "").toLowerCase() === inferredSubgroup)
    : priceIndex.entries;

  const modelCandidates = [];
  for (const code of models) {
    const group = priceIndex.byModel.get(code) || [];
    for (const row of group) {
      if (strictSubgroups.has(inferredSubgroup)) {
        if (String(row.subgroup || "").toLowerCase() !== inferredSubgroup) continue;
      }
      modelCandidates.push(row);
    }
  }

  const itemTokens = tokenize(item.description);
  const itemHints = extractNumberHints(item.description);

  const uniqueModelCandidates = Array.from(new Set(modelCandidates));
  const modelBest = pickBestCandidate(
    uniqueModelCandidates,
    itemTokens,
    itemHints,
    modelSet,
    0.65,
    item.base_price
  );
  if (modelBest) return modelBest;

  let fallbackMinScore = 0.8;
  if (inferredSubgroup === "battery" || inferredSubgroup === "mccb") fallbackMinScore = 0.5;
  if (inferredSubgroup === "mcb" || inferredSubgroup === "spd" || inferredSubgroup === "ats_mts") {
    fallbackMinScore = 0.55;
  }
  if (inferredSubgroup === "cable") fallbackMinScore = 0.7;
  if (inferredSubgroup === "mounting" || inferredSubgroup === "connector") fallbackMinScore = 0.55;

  const fallbackBest = pickBestCandidate(
    subgroupPool,
    itemTokens,
    itemHints,
    modelSet,
    fallbackMinScore,
    item.base_price
  );
  if (fallbackBest) return fallbackBest;

  return null;
}

function applyCatalogPriceToItem(item, priceIndex) {
  const hit = findCatalogMatch(item, priceIndex);
  if (!hit) {
    return {
      ...item,
      base_price: Number(item.base_price || 0),
      original_base_price: Number(item.base_price || 0),
      catalog_price_applied: 0
    };
  }

  const originalDescription = String(item.description || "").trim();
  const originalUnit = String(item.unit || "").trim();

  return {
    ...item,
    // Keep template/input wording; only enrich price and catalog metadata.
    description: originalDescription || hit.material_name || item.description,
    unit: originalUnit || hit.unit || null,
    original_base_price: Number(item.base_price || 0),
    base_price: Number(hit.base_price || 0),
    catalog_price_applied: 1,
    catalog_material_id: hit.id,
    catalog_material_name: hit.material_name || null,
    catalog_category: hit.category || null,
    catalog_subgroup: hit.subgroup || null,
    catalog_source_section: hit.source_section || null
  };
}

module.exports = {
  normalizeMaterialName,
  getMaterialPriceIndex,
  applyCatalogPriceToItem
};
