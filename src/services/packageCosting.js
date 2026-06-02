const pool = require("../config/db");
const { getMaterialPriceIndex, applyCatalogPriceToItem } = require("./materialCatalog");
const { DEFAULT_MATERIAL_MARKUP_RATE, applyMaterialMarkup } = require("./pricing");

const PACKAGE_COSTING_VAT_RATE = 0.12;

const SECTION_DEFS = [
  { key: "main_system", label: "A. Main System Components" },
  { key: "dc_pv", label: "B. DC Protection / PV Side" },
  { key: "ac_distribution", label: "C. AC Protection / Distribution" },
  { key: "mounting_structural", label: "D. Mounting / Structural" },
  { key: "cabling_conduits", label: "E. Cabling / Conduits" },
  { key: "grounding", label: "F. Grounding System" },
  { key: "consumables", label: "G. Termination / Consumables" }
];

const SECTION_INDEX = new Map(SECTION_DEFS.map((section, index) => [section.key, index]));
const SECTION_BY_KEY = new Map(SECTION_DEFS.map((section) => [section.key, section]));

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundCurrency(value) {
  return Math.round(toNumber(value, 0) * 100) / 100;
}

function normalizeVatMode(value) {
  return String(value || "").trim().toLowerCase() === "excl" ? "excl" : "incl";
}

function toVatInclusivePrice(value) {
  const base = Math.max(0, toNumber(value, 0));
  return base * (1 + PACKAGE_COSTING_VAT_RATE);
}

function getSectionLabel(key) {
  return SECTION_BY_KEY.get(String(key || ""))?.label || "Unassigned";
}

function sortCostingItems(a, b) {
  const sectionDiff =
    (SECTION_INDEX.get(String(a.section_key || "")) ?? Number.MAX_SAFE_INTEGER) -
    (SECTION_INDEX.get(String(b.section_key || "")) ?? Number.MAX_SAFE_INTEGER);
  if (sectionDiff !== 0) return sectionDiff;

  const itemNoDiff = toNumber(a.item_no, 0) - toNumber(b.item_no, 0);
  if (itemNoDiff !== 0) return itemNoDiff;

  return String(a.description || "").localeCompare(String(b.description || ""));
}

function resolveUnitCost(item, vatMode) {
  const unitCost = Math.max(0, toNumber(item?.base_price, 0));
  const usesCatalogPrice =
    Number(item?.catalog_material_id || 0) > 0 && Number(item?.catalog_price_applied || 0) === 1;

  if (normalizeVatMode(vatMode) === "incl" && usesCatalogPrice) {
    return toVatInclusivePrice(unitCost);
  }

  return unitCost;
}

function buildSectionTotals(items) {
  const bySection = new Map();

  for (const item of items) {
    const key = String(item.section_key || "") || "unassigned";
    if (!bySection.has(key)) {
      bySection.set(key, {
        section_key: key,
        section_label: getSectionLabel(key),
        item_count: 0,
        material_cost_total: 0,
        quoted_material_total: 0
      });
    }

    const section = bySection.get(key);
    section.item_count += 1;
    section.material_cost_total += toNumber(item.line_cost, 0);
    section.quoted_material_total += toNumber(item.quoted_line_total, 0);
  }

  return Array.from(bySection.values())
    .map((section) => ({
      ...section,
      material_cost_total: roundCurrency(section.material_cost_total),
      quoted_material_total: roundCurrency(section.quoted_material_total)
    }))
    .sort((a, b) => {
      const sectionDiff =
        (SECTION_INDEX.get(String(a.section_key || "")) ?? Number.MAX_SAFE_INTEGER) -
        (SECTION_INDEX.get(String(b.section_key || "")) ?? Number.MAX_SAFE_INTEGER);
      if (sectionDiff !== 0) return sectionDiff;
      return String(a.section_label || "").localeCompare(String(b.section_label || ""));
    });
}

async function fetchTemplateCosting(templateId, options = {}) {
  const id = Number(templateId || 0);
  if (!id) return null;

  const vatMode = normalizeVatMode(options.vatMode);
  const includeItems = options.includeItems !== false;

  const [templateRows] = await pool.query(
    "SELECT id, name, sheet_name, created_at FROM quote_templates WHERE id=? LIMIT 1",
    [id]
  );
  const template = templateRows[0] || null;
  if (!template) return null;

  const [itemRows] = await pool.query(
    "SELECT * FROM template_items WHERE template_id=? ORDER BY item_no ASC, id ASC",
    [id]
  );
  const priceIndex = await getMaterialPriceIndex();

  const items = itemRows
    .map((row) => {
      const resolved = applyCatalogPriceToItem(row, priceIndex);
      const qty = Math.max(0, toNumber(resolved.qty, 0));
      const unitCost = resolveUnitCost(resolved, vatMode);
      const quotedUnitPrice = applyMaterialMarkup(unitCost, DEFAULT_MATERIAL_MARKUP_RATE);
      const sectionKey = String(resolved.section_key || "").trim() || "unassigned";
      const catalogPriceApplied = Number(resolved.catalog_price_applied || 0) === 1 ? 1 : 0;

      return {
        id: Number(row.id),
        template_id: Number(row.template_id),
        item_no: Number(resolved.item_no || 0),
        section_key: sectionKey,
        section_label: getSectionLabel(sectionKey),
        description: String(resolved.description || ""),
        unit: resolved.unit || null,
        qty,
        stored_unit_cost: roundCurrency(row.base_price),
        unit_cost: roundCurrency(unitCost),
        line_cost: roundCurrency(unitCost * qty),
        quoted_unit_price: roundCurrency(quotedUnitPrice),
        quoted_line_total: roundCurrency(quotedUnitPrice * qty),
        catalog_material_id: Number(resolved.catalog_material_id || 0) || null,
        catalog_material_name: resolved.catalog_material_name || null,
        catalog_category: resolved.catalog_category || null,
        catalog_subgroup: resolved.catalog_subgroup || null,
        catalog_price_applied: catalogPriceApplied,
        price_source: catalogPriceApplied ? "catalog" : "template"
      };
    })
    .sort(sortCostingItems);

  const materialCostTotal = items.reduce((sum, item) => sum + toNumber(item.line_cost, 0), 0);
  const quotedMaterialTotal = items.reduce((sum, item) => sum + toNumber(item.quoted_line_total, 0), 0);
  const linkedItemCount = items.filter((item) => Number(item.catalog_price_applied || 0) === 1).length;

  return {
    template: {
      id: Number(template.id),
      name: template.name,
      sheet_name: template.sheet_name,
      created_at: template.created_at
    },
    vat_mode: vatMode,
    material_markup_rate: DEFAULT_MATERIAL_MARKUP_RATE,
    item_count: items.length,
    linked_item_count: linkedItemCount,
    unlinked_item_count: Math.max(0, items.length - linkedItemCount),
    material_cost_total: roundCurrency(materialCostTotal),
    quoted_material_total: roundCurrency(quotedMaterialTotal),
    sections: buildSectionTotals(items),
    items: includeItems ? items : []
  };
}

function enrichPackageScenarios(packageRows, templateCosting) {
  const costing = templateCosting || {};
  const materialCostTotal = toNumber(costing.material_cost_total, 0);
  const quotedMaterialTotal = toNumber(costing.quoted_material_total, 0);

  return (packageRows || []).map((row) => {
    const packagePrice = toNumber(row.package_price, 0);
    const grossProfit = packagePrice - materialCostTotal;
    const installationAllowance = Math.max(0, packagePrice - quotedMaterialTotal);

    return {
      ...row,
      material_cost_total: roundCurrency(materialCostTotal),
      quoted_material_total: roundCurrency(quotedMaterialTotal),
      installation_allowance: roundCurrency(installationAllowance),
      gross_profit: roundCurrency(grossProfit),
      gross_margin_percent: packagePrice > 0 ? roundCurrency((grossProfit / packagePrice) * 100) : 0,
      material_cost_percent: packagePrice > 0 ? roundCurrency((materialCostTotal / packagePrice) * 100) : 0,
      costing_item_count: Number(costing.item_count || 0),
      costing_linked_item_count: Number(costing.linked_item_count || 0),
      costing_unlinked_item_count: Number(costing.unlinked_item_count || 0),
      costing_vat_mode: costing.vat_mode || "incl",
      material_markup_rate: toNumber(costing.material_markup_rate, DEFAULT_MATERIAL_MARKUP_RATE)
    };
  });
}

module.exports = {
  fetchTemplateCosting,
  enrichPackageScenarios,
  normalizeVatMode
};
