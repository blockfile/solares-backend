const pool = require("../config/db");
const {
  DEFAULT_INSTALLATION_MARKUP_RATE,
  DEFAULT_MATERIAL_MARKUP_RATE,
  applyInstallationMarkup,
  applyMaterialMarkup,
  computeInstallation
} = require("../services/pricing");
const {
  buildCustomerQuotationExcel,
  buildCustomerQuotationPdf,
  buildCompanyQuotationExcel
} = require("../services/excelExport");
const { getMaterialPriceIndex, applyCatalogPriceToItem } = require("../services/materialCatalog");
const { getRequestIp, safeLogAudit } = require("../services/audit");

function resolveQuoteDateParts(value) {
  const text = String(value || "").trim();
  const directMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (directMatch) {
    return {
      year: directMatch[1],
      stamp: `${directMatch[1]}${directMatch[2]}${directMatch[3]}`
    };
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    const fallback = new Date();
    return {
      year: String(fallback.getFullYear()),
      stamp: `${fallback.getFullYear()}${String(fallback.getMonth() + 1).padStart(2, "0")}${String(
        fallback.getDate()
      ).padStart(2, "0")}`
    };
  }

  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return { year, stamp: `${year}${month}${day}` };
}

async function makeQuoteRef(connection, quoteDate) {
  const { year, stamp } = resolveQuoteDateParts(quoteDate);
  const lockName = `quotes-ref-${year}`;
  const [lockRows] = await connection.query("SELECT GET_LOCK(?, 10) AS acquired", [lockName]);
  if (Number(lockRows[0]?.acquired || 0) !== 1) {
    throw new Error("Failed to acquire quote reference lock");
  }

  try {
    const [rows] = await connection.query(
      `SELECT quote_ref
       FROM quotes
       WHERE quote_ref REGEXP ?
       ORDER BY CAST(RIGHT(quote_ref, 5) AS UNSIGNED) DESC, id DESC
       LIMIT 1`,
      [`^Q-${year}[0-9]{4}-[0-9]{5}$`]
    );

    const currentSeries = Number(String(rows[0]?.quote_ref || "").match(/-(\d{5})$/)?.[1] || 0);
    return `Q-${stamp}-${String(currentSeries + 1).padStart(5, "0")}`;
  } finally {
    await connection.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => {});
  }
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parsePanelWatt(description, fallback = 0) {
  const text = String(description || "");
  const m = text.match(/(\d{3,4})\s*w/i);
  if (!m) return toNumber(fallback, 0);
  const watt = Number(m[1]);
  return Number.isFinite(watt) ? watt : toNumber(fallback, 0);
}

function isBatteryDescription(description) {
  const text = String(description || "").toLowerCase();
  return (
    (text.includes("battery") || text.includes("lifepo") || text.includes("lipo4") || /\bah\b/.test(text)) &&
    !text.includes("battery cable")
  );
}

function extractBatteryAh(items) {
  const batteryItem = (items || []).find((item) =>
    isBatteryDescription(
      item?.description || item?.template_description || item?.catalog_material_name || ""
    )
  );
  if (!batteryItem) return "";

  const source = [
    batteryItem.description,
    batteryItem.template_description,
    batteryItem.catalog_material_name
  ]
    .filter(Boolean)
    .join(" ");

  const match = String(source).match(/(\d+(?:\.\d+)?)\s*ah\b/i);
  if (!match) return "";
  return `${match[1]}Ah`;
}

function sanitizeFilenamePart(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildQuoteExportBaseName({ quote, items }) {
  const quoteRef = sanitizeFilenamePart(quote?.quote_ref || `quote-${quote?.id || ""}`);
  const customerName = sanitizeFilenamePart(quote?.customer_name || "");
  const batteryAh = sanitizeFilenamePart(extractBatteryAh(items));

  let baseName = quoteRef || `quote-${quote?.id || ""}`;
  if (customerName) baseName += `-${customerName}`;
  if (batteryAh) baseName += ` - ${batteryAh}`;
  return baseName;
}

function setDownloadFilename(res, filename) {
  const safeName = sanitizeFilenamePart(filename).replace(/"/g, "");
  const fallbackName = safeName || "download";
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(fallbackName)}`
  );
}

exports.listQuotes = async (req, res) => {
  const query = String(req.query.q || "").trim();
  const requestedLimit = Number(req.query.limit || 25);
  const limit = Math.max(1, Math.min(100, Number.isFinite(requestedLimit) ? requestedLimit : 25));

  const params = [];
  const where = [];

  if (query) {
    where.push("(q.quote_ref LIKE ? OR q.customer_name LIKE ? OR qt.name LIKE ?)");
    const likeValue = `%${query}%`;
    params.push(likeValue, likeValue, likeValue);
  }

  params.push(limit);

  const [rows] = await pool.query(
    `SELECT
      q.id,
      q.quote_ref,
      q.customer_name,
      q.quote_date,
      q.valid_until,
      q.pricing_mode,
      q.package_price_target,
      q.total,
      q.created_at,
      q.created_by,
      qt.name AS template_name,
      u.name AS created_by_name,
      u.username AS created_by_username,
      COUNT(qi.id) AS item_count
     FROM quotes q
     LEFT JOIN quote_templates qt ON qt.id = q.template_id
     LEFT JOIN users u ON u.id = q.created_by
     LEFT JOIN quote_items qi ON qi.quote_id = q.id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     GROUP BY q.id
     ORDER BY q.created_at DESC, q.id DESC
     LIMIT ?`,
    params
  );

  return res.json(
    rows.map((row) => ({
      id: Number(row.id),
      quoteRef: row.quote_ref,
      customerName: row.customer_name,
      quoteDate: row.quote_date,
      validUntil: row.valid_until,
      pricingMode: row.pricing_mode,
      packagePriceTarget: toNumber(row.package_price_target, 0),
      total: toNumber(row.total, 0),
      createdAt: row.created_at,
      createdBy: Number(row.created_by || 0) || null,
      createdByName: row.created_by_name || "",
      createdByUsername: row.created_by_username || "",
      templateName: row.template_name || "",
      itemCount: Number(row.item_count || 0)
    }))
  );
};

exports.createQuoteFromTemplate = async (req, res) => {
  const { templateId, customerName, quoteDate, validUntil, packagePriceId, discountAmount, discountItems, items: customItems } = req.body;
  const parsedTemplateId = Number(templateId);
  const parsedPackagePriceId = Number(packagePriceId || 0);

  // Support array of discount items OR single discountAmount for backward compat
  const parsedDiscountItems = Array.isArray(discountItems) && discountItems.length > 0
    ? discountItems.map((d) => ({ label: String(d.label || "Discount").trim(), amount: Math.max(0, Number(d.amount || 0)) })).filter((d) => d.amount > 0)
    : (Number(discountAmount || 0) > 0 ? [{ label: "Promotional Discount", amount: Math.max(0, Number(discountAmount || 0)) }] : []);
  const parsedDiscount = parsedDiscountItems.reduce((s, d) => s + d.amount, 0);

  if (!parsedTemplateId) {
    return res.status(400).json({ message: "Invalid templateId" });
  }

  if (!customerName || !quoteDate || !validUntil) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  let templateName = `Template #${parsedTemplateId}`;
  let packageScenarioLabel = null;

  const [templateRows] = await pool.query("SELECT name FROM quote_templates WHERE id=? LIMIT 1", [parsedTemplateId]);
  if (templateRows.length) {
    templateName = String(templateRows[0].name || templateName);
  }

  const [templateItems] = await pool.query(
    "SELECT * FROM template_items WHERE template_id=? ORDER BY item_no",
    [parsedTemplateId]
  );
  if (!templateItems.length) return res.status(404).json({ message: "Template not found or empty" });

  let pricingMode = "formula";
  let packagePriceTarget = null;
  let packagePriceRefId = null;

  if (parsedPackagePriceId > 0) {
    const [priceRows] = await pool.query(
      `SELECT id, template_id, scenario_label, package_price, is_active
       FROM package_prices
       WHERE id=? AND template_id=?
       LIMIT 1`,
      [parsedPackagePriceId, parsedTemplateId]
    );

    if (!priceRows.length) {
      return res.status(400).json({ message: "Selected package price is invalid for this template" });
    }

    if (Number(priceRows[0].is_active) !== 1) {
      return res.status(400).json({ message: "Selected package price is inactive" });
    }

    pricingMode = "fixed_package";
    packagePriceTarget = toNumber(priceRows[0].package_price, 0);
    packagePriceRefId = Number(priceRows[0].id);
    packageScenarioLabel = String(priceRows[0].scenario_label || "").trim() || null;
  }

  const priceIndex = await getMaterialPriceIndex();

  let items = templateItems.map((it) => applyCatalogPriceToItem({
    item_no: Number(it.item_no),
    description: String(it.description || "").trim(),
    unit: it.unit || null,
    qty: toNumber(it.qty, 1),
    base_price: toNumber(it.base_price, 0),
    catalog_material_id: Number(it.catalog_material_id || 0) || null,
    is_panel_item: it.is_panel_item === 1 ? 1 : 0,
    panel_watt: toNumber(it.panel_watt, 0)
  }, priceIndex));

  if (Array.isArray(customItems) && customItems.length) {
    const templateMap = new Map(templateItems.map((it) => [Number(it.id), it]));
    const custom = [];
    let nextItemNo = templateItems.reduce((mx, it) => Math.max(mx, Number(it.item_no || 0)), 0);

    for (const input of customItems) {
      if (input?.included === false) continue;

      const templateItemId = Number(input?.templateItemId);
      const isManual = input?.isManual === true || !templateMap.has(templateItemId);

      if (isManual) {
        const description = String(input?.description || "").trim();
        if (!description) continue;
        const lowerDescription = description.toLowerCase();
        const isPanelManual =
          lowerDescription.includes("solar panel") ||
          (lowerDescription.includes("panel") && lowerDescription.includes("mono")) ||
          /\d{3,4}\s*w/i.test(description);

        const qty = Math.max(0, toNumber(input?.qty, 1));
        if (qty <= 0) continue;

        const basePrice = Math.max(0, toNumber(input?.basePrice, 0));
        const unitInput = String(input?.unit || "").trim();
        const itemNoRaw = toNumber(input?.itemNo, 0);
        const itemNo = itemNoRaw > 0 ? itemNoRaw : nextItemNo + 1;

        custom.push({
          item_no: itemNo,
          description,
          unit: unitInput || null,
          qty,
          base_price: basePrice,
          catalog_material_id: Number(input?.catalogMaterialId || input?.catalog_material_id || 0) || null,
          is_panel_item: isPanelManual ? 1 : 0,
          panel_watt: isPanelManual ? parsePanelWatt(description, 0) : 0
        });

        if (itemNo > nextItemNo) nextItemNo = itemNo;
        continue;
      }

      const base = templateMap.get(templateItemId);
      const qty = Math.max(0, toNumber(input?.qty, toNumber(base.qty, 1)));
      if (qty <= 0) continue;

      const basePrice = Math.max(0, toNumber(input?.basePrice, toNumber(base.base_price, 0)));
      const itemNo = toNumber(input?.itemNo, toNumber(base.item_no, custom.length + 1));
      const description = String(input?.description ?? base.description ?? "").trim();
      const unitInput = String(input?.unit ?? base.unit ?? "").trim();

      custom.push({
        item_no: itemNo,
        description,
        unit: unitInput || null,
        qty,
        base_price: basePrice,
        catalog_material_id: Number(input?.catalogMaterialId || input?.catalog_material_id || 0) || null,
        is_panel_item: base.is_panel_item === 1 ? 1 : 0,
        panel_watt:
          base.is_panel_item === 1
            ? parsePanelWatt(description, toNumber(base.panel_watt, 0))
            : toNumber(base.panel_watt, 0)
      });

      if (itemNo > nextItemNo) nextItemNo = itemNo;
    }

    if (!custom.length) {
      return res.status(400).json({ message: "No valid selected items in customization payload" });
    }

    items = custom
      .map((x) => applyCatalogPriceToItem(x, priceIndex))
      .sort((a, b) => Number(a.item_no) - Number(b.item_no));
  }

  // Find panel item qty and watt for installation formula
  const panelItem = items.find((x) => x.is_panel_item === 1);
  const panelQty = panelItem ? Number(panelItem.qty) : 0;
  const panelWatt = panelItem ? Number(panelItem.panel_watt || 0) : 0;

  const markupRate = DEFAULT_MATERIAL_MARKUP_RATE;
  const installationMarkupRate = DEFAULT_INSTALLATION_MARKUP_RATE;
  const installationRatePerWatt = 9;

  let subtotal = 0;
  const connection = await pool.getConnection();
  let quoteRef = "";
  let quoteId = 0;
  let finalTotal = 0;

  try {
    await connection.beginTransaction();
    quoteRef = await makeQuoteRef(connection, quoteDate);

    const [q] = await connection.query(
      `INSERT INTO quotes(quote_ref,customer_name,quote_date,valid_until,template_id,markup_rate,installation_rate_per_kw,pricing_mode,package_price_target,package_price_id,subtotal,total,discount_amount,discount_items,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        quoteRef,
        customerName,
        quoteDate,
        validUntil,
        parsedTemplateId,
        markupRate,
        installationRatePerWatt,
        pricingMode,
        packagePriceTarget,
        packagePriceRefId,
        0,
        0,
        parsedDiscount,
        parsedDiscountItems.length > 0 ? JSON.stringify(parsedDiscountItems) : null,
        req.user.id
      ]
    );
    quoteId = q.insertId;

    for (const it of items) {
      const unitPrice = applyMaterialMarkup(Number(it.base_price), markupRate);
      const lineTotal = unitPrice * Number(it.qty);
      subtotal += lineTotal;

      await connection.query(
        `INSERT INTO quote_items(quote_id,item_no,description,unit,qty,base_price,unit_price,line_total,is_installation)
         VALUES (?,?,?,?,?,?,?,?,0)`,
        [quoteId, it.item_no, it.description, it.unit, it.qty, it.base_price, unitPrice, lineTotal]
      );
    }

    const materialsSubtotal = subtotal;
    const installationBasePrice = computeInstallation(panelQty, panelWatt, installationRatePerWatt);
    let installation = applyInstallationMarkup(installationBasePrice, installationMarkupRate);
    if (pricingMode === "fixed_package" && packagePriceTarget != null) {
      installation = Math.round(packagePriceTarget - materialsSubtotal);
      if (installation < 0) installation = 0;
    }

    subtotal = materialsSubtotal + installation;

    await connection.query(
      `INSERT INTO quote_items(quote_id,item_no,description,unit,qty,base_price,unit_price,line_total,is_installation)
       VALUES (?,?,?,?,?,?,?,?,1)`,
      [quoteId, 999, "Complete Installation", "JOB", 1, installationBasePrice, installation, installation]
    );

    finalTotal = subtotal - parsedDiscount;
    await connection.query(
      "UPDATE quotes SET subtotal=?, total=?, discount_amount=?, discount_items=? WHERE id=?",
      [subtotal, finalTotal, parsedDiscount, parsedDiscountItems.length > 0 ? JSON.stringify(parsedDiscountItems) : null, quoteId]
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    console.error(error);
    return res.status(500).json({ message: "Failed to create quote" });
  } finally {
    connection.release();
  }

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "QUOTES",
    action: "QUOTE_CREATED",
    details: `${quoteRef} created for ${customerName} from ${templateName}. Pricing mode: ${pricingMode}.${packageScenarioLabel ? ` Package: ${packageScenarioLabel}.` : ""} Total: ${subtotal}.`,
    ipAddress: getRequestIp(req)
  });

  res.json({
    success: true,
    quoteId,
    quoteRef,
    subtotal,
    discountAmount: parsedDiscount,
    discountItems: parsedDiscountItems,
    total: finalTotal,
    itemCount: items.length + 1,
    pricingMode,
    packagePriceTarget
  });
};

exports.getQuote = async (req, res) => {
  const [q] = await pool.query("SELECT * FROM quotes WHERE id=?", [req.params.id]);
  const [items] = await pool.query("SELECT * FROM quote_items WHERE quote_id=? ORDER BY item_no", [
    req.params.id
  ]);
  res.json({ quote: q[0], items });
};

exports.deleteQuote = async (req, res) => {
  const quoteId = Number(req.params.id);
  if (!quoteId) {
    return res.status(400).json({ message: "Invalid quote id" });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [quoteRows] = await connection.query(
      `SELECT
        q.id,
        q.quote_ref,
        q.customer_name,
        q.total,
        q.created_by,
        u.name AS created_by_name,
        u.username AS created_by_username
       FROM quotes q
       LEFT JOIN users u ON u.id = q.created_by
       WHERE q.id=?
       LIMIT 1`,
      [quoteId]
    );

    if (!quoteRows.length) {
      await connection.rollback();
      return res.status(404).json({ message: "Quote not found" });
    }

    const quote = quoteRows[0];
    const [itemCountRows] = await connection.query(
      "SELECT COUNT(*) AS item_count FROM quote_items WHERE quote_id=?",
      [quoteId]
    );
    const itemCount = Number(itemCountRows[0]?.item_count || 0);

    await connection.query("DELETE FROM quote_items WHERE quote_id=?", [quoteId]);
    await connection.query("DELETE FROM quotes WHERE id=?", [quoteId]);
    await connection.commit();

    await safeLogAudit({
      userId: req.user.id,
      actorName: req.user.name,
      module: "QUOTES",
      action: "QUOTE_DELETED",
      details: `${quote.quote_ref} for ${quote.customer_name || "N/A"} deleted. Removed ${itemCount} items. Created by ${quote.created_by_name || quote.created_by_username || "unknown"}. Total: ${toNumber(quote.total, 0)}.`,
      ipAddress: getRequestIp(req)
    });

    return res.json({
      success: true,
      quoteId,
      quoteRef: quote.quote_ref
    });
  } catch (error) {
    await connection.rollback();
    console.error(error);
    return res.status(500).json({ message: "Failed to delete quote" });
  } finally {
    connection.release();
  }
};

async function loadQuoteForExport(quoteId) {
  const [q] = await pool.query("SELECT * FROM quotes WHERE id=?", [quoteId]);
  if (!q.length) return null;

  const quote = q[0];
  const [items] = await pool.query("SELECT * FROM quote_items WHERE quote_id=? ORDER BY item_no", [quoteId]);

  if (!quote.template_id) {
    return { quote, items };
  }

  const [templateItems] = await pool.query(
    `SELECT
      ti.item_no,
      ti.section_key,
      ti.description AS template_description,
      ti.catalog_material_id,
      mp.material_name AS catalog_material_name,
      mp.source_section AS catalog_source_section,
      mp.subgroup AS catalog_subgroup
     FROM template_items ti
     LEFT JOIN material_prices mp ON mp.id = ti.catalog_material_id
     WHERE ti.template_id=?
     ORDER BY ti.item_no, ti.id`,
    [quote.template_id]
  );

  const sectionByItemNo = new Map();
  const templateMetaByItemNo = new Map();
  for (const item of templateItems) {
    const itemNo = Number(item.item_no || 0);
    if (!itemNo || sectionByItemNo.has(itemNo)) continue;
    sectionByItemNo.set(itemNo, item.section_key || null);
    templateMetaByItemNo.set(itemNo, {
      template_description: item.template_description || null,
      catalog_material_id: Number(item.catalog_material_id || 0) || null,
      catalog_material_name: item.catalog_material_name || null,
      catalog_source_section: item.catalog_source_section || null,
      catalog_subgroup: item.catalog_subgroup || null
    });
  }

  return {
    quote,
    items: items.map((item) => ({
      ...item,
      section_key: item.section_key || sectionByItemNo.get(Number(item.item_no || 0)) || null,
      ...(templateMetaByItemNo.get(Number(item.item_no || 0)) || {})
    }))
  };
}

exports.exportCustomerExcel = async (req, res) => {
  const payload = await loadQuoteForExport(req.params.id);
  if (!payload) return res.status(404).json({ message: "Quote not found" });

  const buffer = await buildCustomerQuotationExcel(payload);
  const baseName = buildQuoteExportBaseName(payload);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "QUOTES",
    action: "QUOTE_CUSTOMER_EXCEL_EXPORTED",
    details: `${payload.quote.quote_ref} exported as customer Excel.`,
    ipAddress: getRequestIp(req)
  });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  setDownloadFilename(res, `${baseName}.xlsx`);
  res.send(buffer);
};

exports.exportCustomerPdf = async (req, res) => {
  const payload = await loadQuoteForExport(req.params.id);
  if (!payload) return res.status(404).json({ message: "Quote not found" });

  const buffer = await buildCustomerQuotationPdf(payload);
  const baseName = buildQuoteExportBaseName(payload);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "QUOTES",
    action: "QUOTE_CUSTOMER_PDF_EXPORTED",
    details: `${payload.quote.quote_ref} exported as customer PDF.`,
    ipAddress: getRequestIp(req)
  });

  res.setHeader("Content-Type", "application/pdf");
  setDownloadFilename(res, `${baseName}.pdf`);
  res.send(buffer);
};

exports.exportCompanyExcel = async (req, res) => {
  const payload = await loadQuoteForExport(req.params.id);
  if (!payload) return res.status(404).json({ message: "Quote not found" });

  const buffer = await buildCompanyQuotationExcel(payload);
  const baseName = buildQuoteExportBaseName(payload);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "QUOTES",
    action: "QUOTE_COMPANY_EXCEL_EXPORTED",
    details: `${payload.quote.quote_ref} exported as company Excel.`,
    ipAddress: getRequestIp(req)
  });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  setDownloadFilename(res, `${baseName} - Company.xlsx`);
  res.send(buffer);
};

exports.exportQuoteExcel = async (req, res) => {
  const payload = await loadQuoteForExport(req.params.id);
  if (!payload) return res.status(404).json({ message: "Quote not found" });

  const buffer = await buildCustomerQuotationExcel(payload);
  const baseName = buildQuoteExportBaseName(payload);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "QUOTES",
    action: "QUOTE_EXPORTED",
    details: `${payload.quote.quote_ref} exported as default Excel.`,
    ipAddress: getRequestIp(req)
  });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  setDownloadFilename(res, `${baseName}.xlsx`);
  res.send(buffer);
};
