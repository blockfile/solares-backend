const pool = require("../config/db");
const { importTemplateFromExcel } = require("../services/excelImport");
const { buildTemplateWorkbook, buildTemplateWorkbookBundle } = require("../services/templateExcelExport");
const { getMaterialPriceIndex, applyCatalogPriceToItem } = require("../services/materialCatalog");
const { describeAuditChange, formatAuditValue, getRequestIp, safeLogAudit } = require("../services/audit");

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const TEMPLATE_VAT_RATE = 0.12;

function normalizeVatMode(value) {
  return String(value || "").trim().toLowerCase() === "excl" ? "excl" : "incl";
}

function toVatInclusivePrice(value) {
  const base = Math.max(0, toNumber(value, 0));
  return base * (1 + TEMPLATE_VAT_RATE);
}

function resolveExportUnitPrice(item, vatMode = "incl") {
  const catalogMaterialId = Number(item?.catalog_material_id || 0);
  const catalogPriceApplied = Number(item?.catalog_price_applied || 0) === 1;
  const currentPrice = Math.max(0, toNumber(item?.base_price, 0));

  if (vatMode === "incl" && catalogMaterialId > 0 && catalogPriceApplied) {
    return toVatInclusivePrice(currentPrice);
  }

  return currentPrice;
}

function toTemplateExportItem(item, vatMode = "incl") {
  return {
    ...item,
    base_price: resolveExportUnitPrice(item, vatMode)
  };
}

const VALID_SECTION_KEYS = new Set([
  "main_system",
  "dc_pv",
  "ac_distribution",
  "mounting_structural",
  "cabling_conduits",
  "grounding",
  "consumables"
]);

function normalizeSectionKey(value) {
  const text = String(value || "").trim().toLowerCase();
  return VALID_SECTION_KEYS.has(text) ? text : null;
}

function inferPanelMeta(description) {
  const text = String(description || "").trim();
  const lower = text.toLowerCase();
  const isPanel = lower.includes("solar panel");
  const wattMatch = text.match(/(\d{3,4})\s*w/i);
  return {
    isPanelItem: isPanel ? 1 : 0,
    panelWatt: wattMatch ? Number(wattMatch[1]) : null
  };
}

function canonicalTemplateName(name) {
  let text = String(name || "")
    .replace(/\s*\(\d+\)\s*\)?\s*$/g, "")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s{2,}/g, " ")
    .trim();

  const opens = (text.match(/\(/g) || []).length;
  const closes = (text.match(/\)/g) || []).length;
  if (opens > closes) {
    text = `${text}${")".repeat(opens - closes)}`;
  }

  text = text.replace(/\(sol\)$/i, "(SOLIS)");

  return text.trim();
}

function templateSortScore(name) {
  const n = String(name || "").toLowerCase();
  const kwMatch = n.match(/(\d+(?:\.\d+)?)\s*kw/);
  const kw = kwMatch ? Number(kwMatch[1]) : Number.MAX_SAFE_INTEGER;

  let typeRank = 2;
  if (n.includes("hybrid")) typeRank = 0;
  else if (n.includes("grid tie")) typeRank = 1;

  return { typeRank, kw, text: n };
}

function templateQualityScore(row) {
  const itemCount = Number(row.item_count || 0);
  const uniqueItemNo = Number(row.unique_item_no || 0);
  const inverterHits = Number(row.inverter_hits || 0);
  const panelHits = Number(row.panel_hits || 0);
  const duplicateItemNo = Math.max(0, itemCount - uniqueItemNo);

  return uniqueItemNo * 20 + itemCount * 3 + inverterHits * 7 + panelHits * 5 - duplicateItemNo * 25;
}

async function fetchTemplateRow(id) {
  const [rows] = await pool.query(
    `SELECT
      qt.id,
      qt.name,
      qt.sheet_name,
      qt.created_at,
      COUNT(ti.id) AS item_count
     FROM quote_templates qt
     LEFT JOIN template_items ti ON ti.template_id = qt.id
     WHERE qt.id=?
     GROUP BY qt.id
     LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function validateCatalogMaterialId(materialId) {
  const id = Number(materialId || 0);
  if (!id) return null;

  const [rows] = await pool.query("SELECT id FROM material_prices WHERE id=? LIMIT 1", [id]);
  return rows.length ? id : false;
}

function sanitizeFilename(value) {
  return String(value || "template")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTemplateBatteryAh(name) {
  const match = String(name || "").match(/(\d+(?:\.\d+)?)\s*ah/i);
  return match ? Number(match[1]) : null;
}

function parseTemplateKw(name) {
  const match = String(name || "").match(/(\d+(?:\.\d+)?)\s*kw/i);
  return match ? Number(match[1]) : null;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function humanizeSectionKey(value) {
  const text = String(value || "")
    .trim()
    .replace(/_/g, " ");
  return text || "Unassigned";
}

function getTemplateExportGroupLabel(name) {
  const text = normalizeText(name);
  const batteryAh = parseTemplateBatteryAh(name);

  if (text.includes("hybrid")) {
    if (batteryAh != null) return `hybrid-${batteryAh}ah`;
    return "hybrid-no-battery";
  }

  if (text.includes("grid tie") || text.includes("grid-tie") || text.includes("grid tied")) {
    return "grid-tie";
  }

  if (batteryAh != null) return `other-${batteryAh}ah`;
  return "other";
}

function stripTemplateBatteryVariant(name) {
  const cleaned = String(name || "")
    .replace(/[-/,\s]*\(?\d+(?:\.\d+)?\s*ah(?:\s*battery)?\)?/gi, " ")
    .replace(/\bno battery\b/gi, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || String(name || "").trim() || "Template";
}

function compareBundleTemplates(a, b) {
  const kwA = parseTemplateKw(a.name);
  const kwB = parseTemplateKw(b.name);
  if (kwA != null || kwB != null) {
    if (kwA == null) return 1;
    if (kwB == null) return -1;
    if (kwA !== kwB) return kwA - kwB;
  }

  const ahA = parseTemplateBatteryAh(a.name);
  const ahB = parseTemplateBatteryAh(b.name);
  if (ahA != null || ahB != null) {
    if (ahA == null) return -1;
    if (ahB == null) return 1;
    if (ahA !== ahB) return ahA - ahB;
  }

  return String(a.name || "").localeCompare(String(b.name || ""));
}

exports.importExcel = async (req, res) => {
  const { templateName, sheetName } = req.body;
  if (!req.file) return res.status(400).json({ message: "Missing file" });

  const result = await importTemplateFromExcel({
    filePath: req.file.path,
    templateName,
    sheetName
  });

  const importedTemplate = await fetchTemplateRow(result.templateId);
  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "TEMPLATES",
    action: "TEMPLATE_IMPORTED",
    details: `${importedTemplate?.name || templateName} imported from Excel sheet ${formatAuditValue(sheetName)} with ${formatAuditValue(result.imported)} item(s).`,
    ipAddress: getRequestIp(req)
  });

  res.json(result);
};

exports.createTemplate = async (req, res) => {
  const name = String(req.body.name || "").trim();
  const sheetName = String(req.body.sheetName || name).trim() || name;

  if (!name) return res.status(400).json({ message: "name is required" });

  const [dupes] = await pool.query(
    "SELECT id FROM quote_templates WHERE LOWER(name)=LOWER(?) LIMIT 1",
    [name]
  );
  if (dupes.length) {
    return res.status(409).json({ message: "A template with this name already exists" });
  }

  const [result] = await pool.query(
    "INSERT INTO quote_templates(name, sheet_name) VALUES (?, ?)",
    [name, sheetName]
  );

  const row = await fetchTemplateRow(result.insertId);
  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "TEMPLATES",
    action: "TEMPLATE_CREATED",
    details: `${row.name} created. Sheet name: ${formatAuditValue(row.sheet_name)}.`,
    ipAddress: getRequestIp(req)
  });
  return res.status(201).json(row);
};

exports.duplicateTemplate = async (req, res) => {
  const id = Number(req.params.id || 0);
  const name = String(req.body.name || "").trim();
  if (!id) return res.status(400).json({ message: "Invalid id" });
  if (!name) return res.status(400).json({ message: "name is required" });

  const source = await fetchTemplateRow(id);
  if (!source) return res.status(404).json({ message: "Template not found" });

  const [dupes] = await pool.query(
    "SELECT id FROM quote_templates WHERE LOWER(name)=LOWER(?) LIMIT 1",
    [name]
  );
  if (dupes.length) {
    return res.status(409).json({ message: "A template with this name already exists" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [insertResult] = await conn.query(
      "INSERT INTO quote_templates(name, sheet_name) VALUES (?, ?)",
      [name, source.sheet_name || name]
    );
    const newTemplateId = insertResult.insertId;

    const [sourceItems] = await conn.query(
      `SELECT item_no, description, unit, qty, base_price, section_key, catalog_material_id, is_panel_item, panel_watt
       FROM template_items
       WHERE template_id=?
       ORDER BY item_no ASC, id ASC`,
      [id]
    );

    for (const item of sourceItems) {
      await conn.query(
        `INSERT INTO template_items(template_id, item_no, description, unit, qty, base_price, section_key, catalog_material_id, is_panel_item, panel_watt)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          newTemplateId,
          item.item_no,
          item.description,
          item.unit,
          item.qty,
          item.base_price,
          item.section_key,
          item.catalog_material_id || null,
          item.is_panel_item,
          item.panel_watt
        ]
      );
    }

    const [packageRows] = await conn.query(
      `SELECT scenario_key, scenario_label, package_price, is_active
       FROM package_prices
       WHERE template_id=?
       ORDER BY id ASC`,
      [id]
    );

    for (const row of packageRows) {
      await conn.query(
        `INSERT INTO package_prices(template_id, scenario_key, scenario_label, package_price, is_active)
         VALUES (?,?,?,?,?)`,
        [
          newTemplateId,
          row.scenario_key,
          row.scenario_label,
          row.package_price,
          row.is_active
        ]
      );
    }

    await conn.commit();

    const created = await fetchTemplateRow(newTemplateId);
    await safeLogAudit({
      userId: req.user.id,
      actorName: req.user.name,
      module: "TEMPLATES",
      action: "TEMPLATE_DUPLICATED",
      details: `${source.name} duplicated as ${created.name} with ${formatAuditValue(created.item_count)} item(s).`,
      ipAddress: getRequestIp(req)
    });
    return res.status(201).json(created);
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
};

exports.listTemplates = async (req, res) => {
  const includeAll = String(req.query.includeAll || "0") === "1";
  const [rows] = await pool.query(
    `SELECT
      qt.*,
      COUNT(ti.id) AS item_count,
      COUNT(DISTINCT ti.item_no) AS unique_item_no,
      SUM(CASE WHEN LOWER(ti.description) LIKE '%inverter%' THEN 1 ELSE 0 END) AS inverter_hits,
      SUM(CASE WHEN LOWER(ti.description) LIKE '%panel%' THEN 1 ELSE 0 END) AS panel_hits
     FROM quote_templates qt
     LEFT JOIN template_items ti ON ti.template_id = qt.id
     GROUP BY qt.id
     ORDER BY qt.id DESC`
  );

  if (includeAll) {
    return res.json(
      rows.map((row) => ({
        id: row.id,
        name: String(row.name || "").trim(),
        sheet_name: row.sheet_name,
        created_at: row.created_at,
        item_count: Number(row.item_count || 0),
        source_name: row.name
      }))
    );
  }

  const byCanonicalName = new Map();
  for (const row of rows) {
    const rawName = String(row.name || "").trim();
    if (!rawName) continue;
    if (rawName.toLowerCase().startsWith("test ")) continue;

    const canonical = canonicalTemplateName(rawName);
    if (!canonical) continue;
    const next = {
      ...row,
      name: canonical,
      source_name: rawName
    };
    const existing = byCanonicalName.get(canonical);

    if (!existing) {
      byCanonicalName.set(canonical, next);
      continue;
    }

    const nextScore = templateQualityScore(next);
    const existingScore = templateQualityScore(existing);

    if (nextScore > existingScore || (nextScore === existingScore && Number(next.id) > Number(existing.id))) {
      byCanonicalName.set(canonical, next);
    }
  }

  const cleaned = Array.from(byCanonicalName.values())
    .filter((row) => Number(row.item_count || 0) > 0)
    .sort((a, b) => {
      const sa = templateSortScore(a.name);
      const sb = templateSortScore(b.name);
      if (sa.typeRank !== sb.typeRank) return sa.typeRank - sb.typeRank;
      if (sa.kw !== sb.kw) return sa.kw - sb.kw;
      return sa.text.localeCompare(sb.text);
    })
    .map((row) => ({
      id: row.id,
      name: row.name,
      sheet_name: row.sheet_name,
      created_at: row.created_at,
      item_count: Number(row.item_count || 0),
      source_name: row.source_name
    }));

  res.json(cleaned);
};

exports.updateTemplate = async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid id" });

  const existing = await fetchTemplateRow(id);
  if (!existing) return res.status(404).json({ message: "Template not found" });

  const name = Object.prototype.hasOwnProperty.call(req.body, "name")
    ? String(req.body.name || "").trim()
    : String(existing.name || "");
  const sheetName = Object.prototype.hasOwnProperty.call(req.body, "sheetName")
    ? String(req.body.sheetName || "").trim() || name
    : String(existing.sheet_name || "");

  if (!name) return res.status(400).json({ message: "name is required" });

  const [dupes] = await pool.query(
    "SELECT id FROM quote_templates WHERE LOWER(name)=LOWER(?) AND id<>? LIMIT 1",
    [name, id]
  );
  if (dupes.length) {
    return res.status(409).json({ message: "A template with this name already exists" });
  }

  await pool.query("UPDATE quote_templates SET name=?, sheet_name=? WHERE id=?", [name, sheetName, id]);
  const row = await fetchTemplateRow(id);
  const changes = [
    describeAuditChange("Template name", existing.name, row.name),
    describeAuditChange("Sheet name", existing.sheet_name, row.sheet_name)
  ].filter(Boolean);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "TEMPLATES",
    action: "TEMPLATE_UPDATED",
    details: changes.length
      ? `${row.name} updated. ${changes.join("; ")}.`
      : `${row.name} was saved with no template header changes.`,
    ipAddress: getRequestIp(req)
  });
  return res.json(row);
};

exports.deleteTemplate = async (req, res) => {
  const id = Number(req.params.id || 0);
  const force = String(req.query.force || "0") === "1";
  if (!id) return res.status(400).json({ message: "Invalid id" });

  const existing = await fetchTemplateRow(id);
  if (!existing) return res.status(404).json({ message: "Template not found" });

  const [quoteRefs] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM quotes q
     LEFT JOIN package_prices pp ON pp.id = q.package_price_id
     WHERE q.template_id = ? OR pp.template_id = ?`,
    [id, id]
  );

  if (Number(quoteRefs[0]?.total || 0) > 0) {
    if (!force) {
      return res.status(409).json({
        message:
          "This template is already used by saved quotes. Delete with force to remove the template and all related quote data."
      });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [quoteRows] = await conn.query(
        "SELECT id FROM quotes WHERE template_id=? OR package_price_id IN (SELECT id FROM package_prices WHERE template_id=?)",
        [id, id]
      );
      const quoteIds = quoteRows.map((row) => Number(row.id)).filter(Boolean);

      if (quoteIds.length) {
        await conn.query(
          `DELETE FROM quote_items WHERE quote_id IN (${quoteIds.map(() => "?").join(",")})`,
          quoteIds
        );
        await conn.query(
          `DELETE FROM quotes WHERE id IN (${quoteIds.map(() => "?").join(",")})`,
          quoteIds
        );
      }

      await conn.query("DELETE FROM package_prices WHERE template_id=?", [id]);
      await conn.query("DELETE FROM template_items WHERE template_id=?", [id]);
      await conn.query("DELETE FROM quote_templates WHERE id=?", [id]);
      await conn.commit();

      await safeLogAudit({
        userId: req.user.id,
        actorName: req.user.name,
        module: "TEMPLATES",
        action: "TEMPLATE_DELETED",
        details: `${existing.name} deleted with force. Removed ${formatAuditValue(existing.item_count)} template item(s) and ${formatAuditValue(quoteIds.length)} related quote(s).`,
        ipAddress: getRequestIp(req)
      });

      return res.json({
        success: true,
        force: true,
        deletedQuotes: quoteIds.length
      });
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM package_prices WHERE template_id=?", [id]);
    await conn.query("DELETE FROM template_items WHERE template_id=?", [id]);
    await conn.query("DELETE FROM quote_templates WHERE id=?", [id]);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "TEMPLATES",
    action: "TEMPLATE_DELETED",
    details: `${existing.name} deleted. Removed ${formatAuditValue(existing.item_count)} template item(s).`,
    ipAddress: getRequestIp(req)
  });

  return res.json({ success: true, force: false, deletedQuotes: 0 });
};

exports.listTemplateItems = async (req, res) => {
  const templateId = Number(req.params.id || 0);
  if (!templateId) return res.status(400).json({ message: "Invalid template id" });

  const [rows] = await pool.query(
    "SELECT * FROM template_items WHERE template_id=? ORDER BY item_no",
    [templateId]
  );
  const priceIndex = await getMaterialPriceIndex();
  const resolved = rows.map((row) => applyCatalogPriceToItem(row, priceIndex));
  res.json(resolved);
};

exports.exportTemplateExcel = async (req, res) => {
  const templateId = Number(req.params.id || 0);
  if (!templateId) return res.status(400).json({ message: "Invalid template id" });
  const vatMode = normalizeVatMode(req.query.vatMode);

  const template = await fetchTemplateRow(templateId);
  if (!template) return res.status(404).json({ message: "Template not found" });

  const [itemRows, packageRows, priceIndex] = await Promise.all([
    pool.query("SELECT * FROM template_items WHERE template_id=? ORDER BY item_no ASC, id ASC", [templateId]),
    pool.query(
      `SELECT scenario_label, package_price, is_active
       FROM package_prices
       WHERE template_id=?
       ORDER BY is_active DESC, scenario_label ASC`,
      [templateId]
    ),
    getMaterialPriceIndex()
  ]);

  const items = itemRows[0]
    .map((row) => applyCatalogPriceToItem(row, priceIndex))
    .map((row) => toTemplateExportItem(row, vatMode));
  const packageScenarios = packageRows[0] || [];
  const buffer = await buildTemplateWorkbook({
    template,
    items,
    packageScenarios,
    vatMode
  });

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "TEMPLATES",
    action: "TEMPLATE_EXPORTED",
    details: `${template.name} exported to costing workbook (${vatMode === "incl" ? "VAT included" : "VAT excluded"}).`,
    ipAddress: getRequestIp(req)
  });

  const baseName = sanitizeFilename(template.name || `template-${templateId}`) || `template-${templateId}`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${baseName}-costing.xlsx"`);
  res.send(buffer);
};

exports.exportTemplateExcelBundle = async (req, res) => {
  const templateId = Number(req.params.id || 0);
  if (!templateId) return res.status(400).json({ message: "Invalid template id" });
  const vatMode = normalizeVatMode(req.query.vatMode);

  const selectedTemplate = await fetchTemplateRow(templateId);
  if (!selectedTemplate) return res.status(404).json({ message: "Template not found" });

  const [allRows] = await pool.query(
    `SELECT
      qt.id,
      qt.name,
      qt.sheet_name,
      qt.created_at,
      COUNT(ti.id) AS item_count
     FROM quote_templates qt
     LEFT JOIN template_items ti ON ti.template_id = qt.id
     GROUP BY qt.id
     ORDER BY qt.id DESC`
  );

  const selectedBundleKey = getTemplateExportGroupLabel(selectedTemplate.name);
  const deduped = new Map();

  for (const row of allRows) {
    if (Number(row.item_count || 0) <= 0) continue;
    if (getTemplateExportGroupLabel(row.name) !== selectedBundleKey) continue;

    const dedupeKey = String(row.name || "").trim().toLowerCase();
    const existing = deduped.get(dedupeKey);
    if (!existing || Number(row.id) > Number(existing.id)) {
      deduped.set(dedupeKey, row);
    }
  }

  const relatedTemplates = Array.from(deduped.values()).sort(compareBundleTemplates);
  if (!relatedTemplates.length) {
    return res.status(404).json({ message: "No related templates found for export" });
  }

  const priceIndex = await getMaterialPriceIndex();
  const bundlePayload = await Promise.all(
    relatedTemplates.map(async (template) => {
      const [itemRows, packageRows] = await Promise.all([
        pool.query("SELECT * FROM template_items WHERE template_id=? ORDER BY item_no ASC, id ASC", [template.id]),
        pool.query(
          `SELECT scenario_label, package_price, is_active
           FROM package_prices
           WHERE template_id=?
           ORDER BY is_active DESC, scenario_label ASC`,
          [template.id]
        )
      ]);

      return {
        template,
        items: itemRows[0]
          .map((row) => applyCatalogPriceToItem(row, priceIndex))
          .map((row) => toTemplateExportItem(row, vatMode)),
        packageScenarios: packageRows[0] || [],
        sheetName: stripTemplateBatteryVariant(template.name)
      };
    })
  );

  const buffer = await buildTemplateWorkbookBundle({ templates: bundlePayload, vatMode });
  const selectedBatteryAh = parseTemplateBatteryAh(selectedTemplate.name);
  const selectedGroupName =
    selectedBatteryAh != null
      ? `${selectedBatteryAh}Ah-packages`
      : getTemplateExportGroupLabel(selectedTemplate.name);
  const baseName = sanitizeFilename(selectedGroupName) || `template-${templateId}`;

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "TEMPLATES",
    action: "TEMPLATE_BUNDLE_EXPORTED",
    details: `${selectedTemplate.name} exported as multi-tab workbook with ${formatAuditValue(bundlePayload.length)} related template(s) (${vatMode === "incl" ? "VAT included" : "VAT excluded"}).`,
    ipAddress: getRequestIp(req)
  });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${baseName}-all-tabs.xlsx"`);
  res.send(buffer);
};

exports.createTemplateItem = async (req, res) => {
  const templateId = Number(req.params.id || 0);
  if (!templateId) return res.status(400).json({ message: "Invalid template id" });

  const template = await fetchTemplateRow(templateId);
  if (!template) return res.status(404).json({ message: "Template not found" });

  const description = String(req.body.description || "").trim();
  const unit = String(req.body.unit || "").trim() || null;
  const qty = Math.max(0, toNumber(req.body.qty, 1));
  const basePrice = Math.max(0, toNumber(req.body.basePrice, 0));
  const sectionKey = normalizeSectionKey(req.body.sectionKey);
  const catalogMaterialId = await validateCatalogMaterialId(
    req.body.catalogMaterialId || req.body.catalog_material_id
  );

  if (!description) return res.status(400).json({ message: "description is required" });
  if (!sectionKey) return res.status(400).json({ message: "sectionKey is required" });
  if (catalogMaterialId === false) return res.status(400).json({ message: "Invalid catalogMaterialId" });

  const inputItemNo = Math.floor(toNumber(req.body.itemNo, 0));
  let itemNo = inputItemNo;
  if (!itemNo) {
    const [maxRows] = await pool.query(
      "SELECT COALESCE(MAX(item_no), 0) AS max_item_no FROM template_items WHERE template_id=?",
      [templateId]
    );
    itemNo = Number(maxRows[0]?.max_item_no || 0) + 1;
  }

  const panelMeta = inferPanelMeta(description);
  const [result] = await pool.query(
    `INSERT INTO template_items(template_id, item_no, description, unit, qty, base_price, section_key, catalog_material_id, is_panel_item, panel_watt)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      templateId,
      itemNo,
      description,
      unit,
      qty,
      basePrice,
      sectionKey,
      catalogMaterialId,
      panelMeta.isPanelItem,
      panelMeta.panelWatt
    ]
  );

  const [rows] = await pool.query("SELECT * FROM template_items WHERE id=? LIMIT 1", [result.insertId]);
  const created = rows[0];

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "TEMPLATES",
    action: "TEMPLATE_ITEM_CREATED",
    details: `${template.name}: added item ${formatAuditValue(created.item_no)} (${created.description}) in ${humanizeSectionKey(created.section_key)}. Qty: ${formatAuditValue(created.qty)}. Base price: ${formatAuditValue(created.base_price)}.`,
    ipAddress: getRequestIp(req)
  });

  return res.status(201).json(created);
};

exports.updateTemplateItem = async (req, res) => {
  const templateId = Number(req.params.id || 0);
  const itemId = Number(req.params.itemId || 0);
  if (!templateId || !itemId) return res.status(400).json({ message: "Invalid id" });

  const template = await fetchTemplateRow(templateId);
  if (!template) return res.status(404).json({ message: "Template not found" });

  const [rows] = await pool.query(
    "SELECT * FROM template_items WHERE id=? AND template_id=? LIMIT 1",
    [itemId, templateId]
  );
  if (!rows.length) return res.status(404).json({ message: "Template item not found" });
  const existing = rows[0];

  const description = Object.prototype.hasOwnProperty.call(req.body, "description")
    ? String(req.body.description || "").trim()
    : String(existing.description || "");
  const unit = Object.prototype.hasOwnProperty.call(req.body, "unit")
    ? String(req.body.unit || "").trim() || null
    : existing.unit;
  const qty = Object.prototype.hasOwnProperty.call(req.body, "qty")
    ? Math.max(0, toNumber(req.body.qty, 0))
    : Number(existing.qty || 0);
  const basePrice = Object.prototype.hasOwnProperty.call(req.body, "basePrice")
    ? Math.max(0, toNumber(req.body.basePrice, 0))
    : Number(existing.base_price || 0);
  const sectionKey = Object.prototype.hasOwnProperty.call(req.body, "sectionKey")
    ? normalizeSectionKey(req.body.sectionKey)
    : normalizeSectionKey(existing.section_key);
  const catalogMaterialId =
    Object.prototype.hasOwnProperty.call(req.body, "catalogMaterialId") ||
    Object.prototype.hasOwnProperty.call(req.body, "catalog_material_id")
      ? await validateCatalogMaterialId(req.body.catalogMaterialId || req.body.catalog_material_id)
      : Number(existing.catalog_material_id || 0) || null;
  const itemNo = Object.prototype.hasOwnProperty.call(req.body, "itemNo")
    ? Math.max(1, Math.floor(toNumber(req.body.itemNo, existing.item_no || 1)))
    : Number(existing.item_no || 1);

  if (!description) return res.status(400).json({ message: "description is required" });
  if (!sectionKey) return res.status(400).json({ message: "sectionKey is required" });
  if (catalogMaterialId === false) return res.status(400).json({ message: "Invalid catalogMaterialId" });

  const panelMeta = inferPanelMeta(description);
  await pool.query(
    `UPDATE template_items
     SET item_no=?, description=?, unit=?, qty=?, base_price=?, section_key=?, catalog_material_id=?, is_panel_item=?, panel_watt=?
     WHERE id=? AND template_id=?`,
    [
      itemNo,
      description,
      unit,
      qty,
      basePrice,
      sectionKey,
      catalogMaterialId,
      panelMeta.isPanelItem,
      panelMeta.panelWatt,
      itemId,
      templateId
    ]
  );

  const [updatedRows] = await pool.query("SELECT * FROM template_items WHERE id=? LIMIT 1", [itemId]);
  const updated = updatedRows[0];
  const changes = [
    describeAuditChange("Item no", existing.item_no, updated.item_no),
    describeAuditChange("Description", existing.description, updated.description),
    describeAuditChange("Unit", existing.unit, updated.unit),
    describeAuditChange("Qty", existing.qty, updated.qty),
    describeAuditChange("Base price", existing.base_price, updated.base_price),
    describeAuditChange("Section", humanizeSectionKey(existing.section_key), humanizeSectionKey(updated.section_key)),
    describeAuditChange("Catalog material", existing.catalog_material_id, updated.catalog_material_id)
  ].filter(Boolean);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "TEMPLATES",
    action: "TEMPLATE_ITEM_UPDATED",
    details: changes.length
      ? `${template.name}: item ${formatAuditValue(updated.item_no)} updated. ${changes.join("; ")}.`
      : `${template.name}: item ${formatAuditValue(updated.item_no)} was saved with no template item changes.`,
    ipAddress: getRequestIp(req)
  });

  return res.json(updated);
};

exports.deleteTemplateItem = async (req, res) => {
  const templateId = Number(req.params.id || 0);
  const itemId = Number(req.params.itemId || 0);
  if (!templateId || !itemId) return res.status(400).json({ message: "Invalid id" });

  const template = await fetchTemplateRow(templateId);
  if (!template) return res.status(404).json({ message: "Template not found" });

  const [rows] = await pool.query(
    "SELECT * FROM template_items WHERE id=? AND template_id=? LIMIT 1",
    [itemId, templateId]
  );
  const existing = rows[0] || null;

  const [result] = await pool.query(
    "DELETE FROM template_items WHERE id=? AND template_id=?",
    [itemId, templateId]
  );
  if (!result.affectedRows) return res.status(404).json({ message: "Template item not found" });

  if (existing) {
    await safeLogAudit({
      userId: req.user.id,
      actorName: req.user.name,
      module: "TEMPLATES",
      action: "TEMPLATE_ITEM_DELETED",
      details: `${template.name}: deleted item ${formatAuditValue(existing.item_no)} (${existing.description}) from ${humanizeSectionKey(existing.section_key)}.`,
      ipAddress: getRequestIp(req)
    });
  }

  return res.json({ success: true });
};
