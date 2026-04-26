const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const { DEFAULT_MATERIAL_MARKUP_RATE } = require("./pricing");

function cloneStyle(style) {
  return JSON.parse(JSON.stringify(style || {}));
}

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function cleanDisplayText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLooseText(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function resolveSectionKey(value) {
  const key = String(value || "").trim().toLowerCase();
  return VALID_SECTION_KEYS.has(key) ? key : null;
}

function isPanelDescription(description) {
  const text = normalizeText(description);
  return (
    text.includes("solar panel") ||
    (text.includes("panel") && text.includes("mono")) ||
    (text.includes("mono") && /\d{3,4}\s*w/.test(text))
  );
}

function roundPeso(n) {
  return Math.round(Number(n || 0));
}

const EXPORT_VAT_RATE = 0.12;

function normalizeVatMode(value) {
  return String(value || "").trim().toLowerCase() === "excl" ? "excl" : "incl";
}

function isVatEligibleExportItem(row) {
  if (Number(row?.is_installation) === 1) return false;
  return Number(row?.catalog_material_id || 0) > 0;
}

function applyVatModeToAmount(amount, row, vatMode = "incl") {
  const numericAmount = Number(amount || 0);
  if (normalizeVatMode(vatMode) !== "incl") return numericAmount;
  if (!isVatEligibleExportItem(row)) return numericAmount;
  return numericAmount * (1 + EXPORT_VAT_RATE);
}

function isBatteryDescription(description) {
  const text = normalizeText(description);
  return (
    (text.includes("battery") || text.includes("lifepo") || text.includes("lipo4") || text.includes("ah")) &&
    !text.includes("battery cable")
  );
}

function isInverterDescription(description) {
  const text = normalizeText(description);
  return (
    text.includes("inverter") ||
    text.includes("deye") ||
    text.includes("solis") ||
    text.includes("hybrid") ||
    text.includes("grid tie") ||
    /\bsun-\d/i.test(text) ||
    /\bs[56]-[a-z0-9-]+/i.test(text)
  );
}

function buildItemSearchText(item) {
  return cleanDisplayText(
    [
      item?.description,
      item?.template_description,
      item?.catalog_material_name,
      item?.catalog_source_section
    ]
      .filter((value) => String(value || "").trim())
      .join(" ")
  );
}

function inferBrandName(subgroup, item) {
  const rawText = buildItemSearchText(item);
  const text = normalizeText(rawText);

  if (subgroup === "panel") {
    if (text.includes("canadian") || /\bcs\d/i.test(rawText)) return "Canadian Solar";
    if (text.includes("jinko") || /\bjkm/i.test(rawText)) return "Jinko Solar";
    if (text.includes("trina") || /\btsm/i.test(rawText)) return "Trina Solar";
    if (text.includes("ja solar") || /\bjam\d/i.test(rawText)) return "JA Solar";
    return null;
  }

  if (subgroup === "inverter") {
    if (text.includes("deye") || /\bsun-\d/i.test(rawText)) return "DEYE";
    if (text.includes("solis") || /\bs[56]-[a-z0-9-]+/i.test(rawText)) return "SOLIS";
    if (text.includes("srne") || text.includes("snre")) return "SRNE";
    return null;
  }

  if (subgroup === "battery") {
    if (text.includes("srne") || text.includes("snre") || /\bsr-[a-z0-9-]+/i.test(rawText)) return "SRNE";
    if (text.includes("menred") || text.includes("mendred")) return "MENRED";
    if (text.includes("pylontech")) return "Pylontech";
    return null;
  }

  return null;
}

function stripGenericProductPrefix(description, subgroup) {
  const raw = cleanDisplayText(description);
  if (!raw) return "";

  if (subgroup === "panel") {
    return cleanDisplayText(raw.replace(/^solar\s+panel\s*[-:]?\s*/i, ""));
  }

  if (subgroup === "inverter") {
    return cleanDisplayText(
      raw
        .replace(/^(hybrid|grid[\s-]*tie|off[\s-]*grid)\s+inverter\s*[-:]?\s*/i, "")
        .replace(/^inverter\s*[-:]?\s*/i, "")
    );
  }

  if (subgroup === "battery") {
    return cleanDisplayText(
      raw
        .replace(/^(lifepo4|lipo4|lithium)\s*battery\s*[-:]?\s*/i, "")
        .replace(/^battery\s*[-:]?\s*/i, "")
    );
  }

  return raw;
}

function buildProductDisplayName(item, subgroup, fallbackLabel) {
  const raw = cleanDisplayText(
    item?.description || item?.catalog_material_name || item?.template_description || fallbackLabel || ""
  );
  if (!raw) return cleanDisplayText(fallbackLabel);

  const brand = inferBrandName(subgroup, item);
  if (!brand) return raw;

  if (normalizeLooseText(raw).includes(normalizeLooseText(brand))) {
    return raw;
  }

  const stripped = stripGenericProductPrefix(raw, subgroup);
  return cleanDisplayText(`${brand} ${stripped || raw}`);
}

function isMountingDescription(description) {
  const text = normalizeText(description);
  if (text.includes("din rail")) return false;
  return (
    text.includes("rail") ||
    text.includes("l-foot") ||
    text.includes("lfoot") ||
    text.includes("l foot") ||
    text.includes("clamp") ||
    text.includes("splice") ||
    text.includes("mc4") ||
    text.includes("mounting") ||
    text.includes("conduit") ||
    text.includes("fittings connector") ||
    text.includes("grounding lug") ||
    text.includes("clip/plate")
  );
}

function isMountingItem(item) {
  const sectionKey = resolveSectionKey(item.section_key);
  if (sectionKey) return sectionKey === "mounting_structural";
  return isMountingDescription(item.description);
}

function groupQuoteItems(items) {
  const nonInstallation = items.filter((it) => Number(it.is_installation) !== 1);
  const installationTotal = roundPeso(
    items
      .filter((it) => Number(it.is_installation) === 1)
      .reduce((s, it) => s + Number(it.line_total || 0), 0)
  );

  const inverterItems = nonInstallation.filter((it) => isInverterDescription(it.description));
  const panelItems = nonInstallation.filter((it) => isPanelDescription(it.description));
  const batteryItems = nonInstallation.filter((it) => isBatteryDescription(it.description));

  const taken = new Set([
    ...inverterItems.map((x) => x.id),
    ...panelItems.map((x) => x.id),
    ...batteryItems.map((x) => x.id)
  ]);
  const remaining = nonInstallation.filter((it) => !taken.has(it.id));

  return {
    nonInstallation,
    installationTotal,
    inverterItems,
    panelItems,
    batteryItems,
    mountingItems: remaining.filter((it) => isMountingItem(it)),
    safetyItems: remaining.filter((it) => !isMountingItem(it))
  };
}

function resolveTechnicalSpecs(groups) {
  return {
    panel: groups.panelItems[0]
      ? buildProductDisplayName(groups.panelItems[0], "panel", "Solar Panel")
      : "",
    inverter: groups.inverterItems[0]
      ? buildProductDisplayName(groups.inverterItems[0], "inverter", "Inverter")
      : "",
    battery: groups.batteryItems[0]
      ? buildProductDisplayName(groups.batteryItems[0], "battery", "Battery")
      : ""
  };
}

function computeLineFromStoredTotals(rows, { description, qty, unit, vatMode = "incl" }) {
  if (!rows.length) return null;
  const lineTotal = roundPeso(
    rows.reduce((sum, row) => sum + applyVatModeToAmount(row.line_total || 0, row, vatMode), 0)
  );
  const parsedQty = Number(qty || 0);
  const unitPrice = parsedQty > 0 ? lineTotal / parsedQty : lineTotal;
  return {
    description,
    qtyDisplay: parsedQty > 0 ? parsedQty : qty,
    unit: unit || "",
    unitPrice,
    lineTotal
  };
}

function computeLineFromBaseWithMarkup(rows, { description, qty, unit, markupRate, vatMode = "incl" }) {
  if (!rows.length) return null;
  const baseSubtotal = rows.reduce(
    (sum, row) =>
      sum + applyVatModeToAmount(row.base_price || 0, row, vatMode) * Number(row.qty || 0),
    0
  );
  const lineTotal = roundPeso(baseSubtotal * (1 + Number(markupRate || 0)));
  const parsedQty = Number(qty || 0);
  const unitPrice = parsedQty > 0 ? lineTotal / parsedQty : lineTotal;
  return {
    description,
    qtyDisplay: parsedQty > 0 ? parsedQty : qty,
    unit: unit || "",
    unitPrice,
    lineTotal
  };
}

function resolveMaterialMarkupRate(quote) {
  const rate = Number(quote?.markup_rate);
  return Number.isFinite(rate) && rate >= 0 ? rate : DEFAULT_MATERIAL_MARKUP_RATE;
}

function summarizeForExport(quote, items, { vatMode = "incl" } = {}) {
  const effectiveVatMode = normalizeVatMode(vatMode);
  const groups = groupQuoteItems(items);
  const { installationTotal, inverterItems, panelItems, batteryItems, mountingItems, safetyItems } = groups;
  const specs = resolveTechnicalSpecs(groups);
  const materialMarkupRate = resolveMaterialMarkupRate(quote);

  const inverterQty = inverterItems.reduce((s, x) => s + Number(x.qty || 0), 0);
  const panelQty = panelItems.reduce((s, x) => s + Number(x.qty || 0), 0);
  const batteryQty = batteryItems.reduce((s, x) => s + Number(x.qty || 0), 0);

  const lines = [];

  const inverterLine = computeLineFromStoredTotals(inverterItems, {
    description: specs.inverter || inverterItems[0]?.description || "Inverter",
    qty: inverterQty,
    unit: inverterItems[0]?.unit || "PCS",
    vatMode: effectiveVatMode
  });
  if (inverterLine) lines.push(inverterLine);

  const panelLine = computeLineFromStoredTotals(panelItems, {
    description: specs.panel || panelItems[0]?.description || "Solar Panel",
    qty: panelQty,
    unit: panelItems[0]?.unit || "PCS",
    vatMode: effectiveVatMode
  });
  if (panelLine) lines.push(panelLine);

  const batteryLine = computeLineFromStoredTotals(batteryItems, {
    description: specs.battery || batteryItems[0]?.description || "Battery",
    qty: batteryQty,
    unit: batteryItems[0]?.unit || "PCS",
    vatMode: effectiveVatMode
  });
  if (batteryLine) lines.push(batteryLine);

  const safetyLine = computeLineFromBaseWithMarkup(safetyItems, {
    description: "Complete Safety Breakers/SPD",
    qty: 1,
    unit: "SET",
    markupRate: materialMarkupRate,
    vatMode: effectiveVatMode
  });
  if (safetyLine && safetyLine.lineTotal > 0) lines.push(safetyLine);

  const mountingLine = computeLineFromBaseWithMarkup(mountingItems, {
    description: "Complete Mounting Fixtures",
    qty: 1,
    unit: "SET",
    markupRate: materialMarkupRate,
    vatMode: effectiveVatMode
  });
  if (mountingLine && mountingLine.lineTotal > 0) lines.push(mountingLine);

  const displayedMaterialTotal = roundPeso(lines.reduce((sum, line) => sum + Number(line.lineTotal || 0), 0));
  const adjustedSubtotalFromRows = roundPeso(
    (items || []).reduce((sum, row) => sum + applyVatModeToAmount(row.line_total || 0, row, effectiveVatMode), 0)
  );
  const preDiscountTotal = adjustedSubtotalFromRows > 0
    ? adjustedSubtotalFromRows
    : Number.isFinite(Number(quote?.subtotal)) && Number(quote.subtotal) > 0
      ? roundPeso(quote.subtotal)
      : Number.isFinite(Number(quote?.total))
        ? roundPeso(quote.total)
        : null;
  const totalTarget = preDiscountTotal != null
    ? preDiscountTotal
    : displayedMaterialTotal + installationTotal;
  const reconciledInstallation = Math.max(0, roundPeso(totalTarget - displayedMaterialTotal));

  if (installationTotal > 0 || reconciledInstallation > 0) {
    lines.push({
      description: "Complete Installation",
      qtyDisplay: "1 JOB",
      unit: "JOB",
      unitPrice: reconciledInstallation,
      lineTotal: reconciledInstallation
    });
  }

  return lines.map((line, idx) => ({ ...line, itemNo: idx + 1 }));
}

function computeLineFromBase(rows, { description, qty, unit, vatMode = "incl" }) {
  if (!rows.length) return null;
  const lineTotal = roundPeso(
    rows.reduce(
      (sum, row) => sum + applyVatModeToAmount(row.base_price || 0, row, vatMode) * Number(row.qty || 0),
      0
    )
  );
  const parsedQty = Number(qty || 0);
  const unitPrice = parsedQty > 0 ? lineTotal / parsedQty : lineTotal;
  return {
    description,
    qtyDisplay: parsedQty > 0 ? parsedQty : qty,
    unit: unit || "",
    unitPrice,
    lineTotal
  };
}

function summarizeForCompany(items, { vatMode = "incl" } = {}) {
  const effectiveVatMode = normalizeVatMode(vatMode);
  const groups = groupQuoteItems(items);
  const { inverterItems, panelItems, batteryItems, mountingItems, safetyItems } = groups;
  const specs = resolveTechnicalSpecs(groups);

  const inverterQty = inverterItems.reduce((s, x) => s + Number(x.qty || 0), 0);
  const panelQty = panelItems.reduce((s, x) => s + Number(x.qty || 0), 0);
  const batteryQty = batteryItems.reduce((s, x) => s + Number(x.qty || 0), 0);

  const lines = [];

  const inverterLine = computeLineFromBase(inverterItems, {
    description: specs.inverter || inverterItems[0]?.description || "Inverter",
    qty: inverterQty,
    unit: inverterItems[0]?.unit || "PCS",
    vatMode: effectiveVatMode
  });
  if (inverterLine) lines.push(inverterLine);

  const panelLine = computeLineFromBase(panelItems, {
    description: specs.panel || panelItems[0]?.description || "Solar Panel",
    qty: panelQty,
    unit: panelItems[0]?.unit || "PCS",
    vatMode: effectiveVatMode
  });
  if (panelLine) lines.push(panelLine);

  const batteryLine = computeLineFromBase(batteryItems, {
    description: specs.battery || batteryItems[0]?.description || "Battery",
    qty: batteryQty,
    unit: batteryItems[0]?.unit || "PCS",
    vatMode: effectiveVatMode
  });
  if (batteryLine) lines.push(batteryLine);

  const safetyLine = computeLineFromBase(safetyItems, {
    description: "Complete Safety Breakers/SPD",
    qty: 1,
    unit: "SET",
    vatMode: effectiveVatMode
  });
  if (safetyLine && safetyLine.lineTotal > 0) lines.push(safetyLine);

  const mountingLine = computeLineFromBase(mountingItems, {
    description: "Complete Mounting Fixtures",
    qty: 1,
    unit: "SET",
    vatMode: effectiveVatMode
  });
  if (mountingLine && mountingLine.lineTotal > 0) lines.push(mountingLine);

  return lines.map((line, idx) => ({ ...line, itemNo: idx + 1 }));
}

function formatCurrencyPhp(value) {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 2
  }).format(Number(value || 0));
}

function formatDateForDoc(value) {
  const d = parseDate(value);
  if (!d) return String(value || "");
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

function parseDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function findRowContains(ws, text, from = 1, to = 300) {
  const needle = String(text || "").toLowerCase();
  for (let r = from; r <= to; r++) {
    const a = String(ws.getCell(`A${r}`).value?.result || ws.getCell(`A${r}`).value || "")
      .toLowerCase()
      .trim();
    if (a.includes(needle)) return r;
  }
  return null;
}

function clearAndHideTemplateRows(ws, rowNumbers, columnCount = 7) {
  for (const rowNumber of rowNumbers) {
    if (!Number.isInteger(rowNumber) || rowNumber <= 0) continue;
    for (let c = 1; c <= columnCount; c += 1) {
      const cell = ws.getCell(rowNumber, c);
      if (cell.master && cell.address !== cell.master.address) continue;
      cell.value = null;
    }
    ws.getRow(rowNumber).hidden = true;
  }
}

function removeTemplateNoteSection(ws, startRow = 1, endRow = 500) {
  const noteLabelRow = findRowContains(ws, "note:", startRow, endRow);
  const noteTextRow = findRowContains(
    ws,
    "base computation for the proposed solar package",
    startRow,
    endRow
  );

  const rowsToHide = new Set();
  if (noteLabelRow) rowsToHide.add(noteLabelRow);
  if (noteTextRow) {
    rowsToHide.add(noteTextRow);
    rowsToHide.add(noteTextRow + 1);
  }

  clearAndHideTemplateRows(ws, rowsToHide);
}

function populateTechnicalSpecifications(ws, items) {
  const specs = resolveTechnicalSpecs(groupQuoteItems(items));
  const rowMap = {
    panel: findRowContains(ws, "solar panel type", 1, 500),
    inverter: findRowContains(ws, "inverter type", 1, 500),
    battery: findRowContains(ws, "battery type", 1, 500)
  };

  if (rowMap.panel) ws.getCell(`C${rowMap.panel}`).value = specs.panel || "";
  if (rowMap.inverter) ws.getCell(`C${rowMap.inverter}`).value = specs.inverter || "";
  if (rowMap.battery) ws.getCell(`C${rowMap.battery}`).value = specs.battery || "";
}

async function buildFromTemplate({ quote, items, vatMode = "incl" }) {
  const effectiveVatMode = normalizeVatMode(vatMode);
  const templatePath =
    process.env.QUOTE_TEMPLATE_PATH ||
    path.join(__dirname, "../../templates/quotation-template.xlsx");

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);
  const ws = wb.getWorksheet("Sheet1") || wb.worksheets[0];
  if (!ws) throw new Error("Template workbook has no worksheet.");

  ws.getCell("A10").value = `Customer Name: ${quote.customer_name || ""}`;
  ws.getCell("F10").value = quote.quote_ref || "";

  const quoteDate = parseDate(quote.quote_date);
  const validUntil = parseDate(quote.valid_until);
  ws.getCell("F11").value = quoteDate || String(quote.quote_date || "");
  ws.getCell("F12").value = validUntil || String(quote.valid_until || "");
  if (quoteDate) ws.getCell("F11").numFmt = "d-mmm-yy";
  if (validUntil) ws.getCell("F12").numFmt = "d-mmm-yy";

  const itemStartRow = 14;
  let totalRow = findRowContains(ws, "total price in philippine peso", 14, 300) || 20;
  const exportItems = summarizeForExport(quote, items, { vatMode: effectiveVatMode });
  const templateSlots = Math.max(0, totalRow - itemStartRow);

  const itemCellStyles = Array.from({ length: 7 }, (_, i) =>
    cloneStyle(ws.getCell(itemStartRow, i + 1).style)
  );
  const totalCellStyles = Array.from({ length: 7 }, (_, i) =>
    cloneStyle(ws.getCell(totalRow, i + 1).style)
  );

  if (exportItems.length > templateSlots) {
    const extra = exportItems.length - templateSlots;
    ws.spliceRows(totalRow, 0, ...Array.from({ length: extra }, () => []));
    totalRow += extra;
  }

  for (let r = itemStartRow; r < totalRow; r++) {
    for (let c = 1; c <= 7; c++) {
      ws.getCell(r, c).value = null;
      ws.getCell(r, c).style = cloneStyle(itemCellStyles[c - 1]);
    }
  }

  exportItems.forEach((it, idx) => {
    const r = itemStartRow + idx;
    ws.getCell(`A${r}`).value = Number(it.itemNo || idx + 1);
    ws.getCell(`B${r}`).value = it.description || "";
    ws.getCell(`D${r}`).value = it.qtyDisplay;
    ws.getCell(`F${r}`).value = Number(it.unitPrice || 0);
    ws.getCell(`F${r}`).numFmt = "#,##0.00";
    ws.getCell(`G${r}`).value = Number(it.lineTotal || 0);
    ws.getCell(`G${r}`).numFmt = "#,##0.00";
  });

  for (let c = 1; c <= 7; c++) {
    ws.getCell(totalRow, c).style = cloneStyle(totalCellStyles[c - 1]);
  }

  try {
    ws.unMergeCells(`A${totalRow}:F${totalRow}`);
  } catch {}
  ws.mergeCells(`A${totalRow}:F${totalRow}`);
  ws.getCell(`A${totalRow}`).value = "TOTAL PRICE IN PHILIPPINE PESO";
  const exportSubtotal = roundPeso(
    exportItems.reduce((sum, line) => sum + Number(line.lineTotal || 0), 0)
  );
  ws.getCell(`G${totalRow}`).value = exportSubtotal;
  ws.getCell(`G${totalRow}`).numFmt = "#,##0.00";
  const yellowFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
  const totalRowHeight = ws.getRow(totalRow).height;

  function applyYellowRow(rowNum) {
    for (let c = 1; c <= 7; c++) {
      const s = cloneStyle(totalCellStyles[c - 1]);
      s.fill = yellowFill;
      ws.getCell(rowNum, c).style = s;
    }
  }

  function styleSummaryValueCell(rowNum, { fontColor = "FF000000" } = {}) {
    const valueCell = ws.getCell(`G${rowNum}`);
    valueCell.fill = yellowFill;
    valueCell.border = cloneStyle(totalCellStyles[6]?.border);
    valueCell.alignment = { horizontal: "right", vertical: "middle" };
    valueCell.font = {
      ...(cloneStyle(totalCellStyles[6]?.font) || {}),
      bold: true,
      color: { argb: fontColor }
    };
    valueCell.numFmt = "#,##0.00";
  }

  function styleSummaryLabelCell(rowNum, { fontColor = "FF000000" } = {}) {
    const labelCell = ws.getCell(`A${rowNum}`);
    labelCell.fill = yellowFill;
    labelCell.border = cloneStyle(totalCellStyles[0]?.border);
    labelCell.alignment = { horizontal: "right", vertical: "middle" };
    labelCell.font = {
      ...(cloneStyle(totalCellStyles[0]?.font) || {}),
      bold: true,
      color: { argb: fontColor }
    };
  }

  function applySummaryRow(rowNum, label, value, { fontColor = "FF000000" } = {}) {
    applyYellowRow(rowNum);
    if (totalRowHeight) ws.getRow(rowNum).height = totalRowHeight;
    try { ws.unMergeCells(`A${rowNum}:F${rowNum}`); } catch {}
    ws.mergeCells(`A${rowNum}:F${rowNum}`);
    ws.getCell(`A${rowNum}`).value = label;
    ws.getCell(`G${rowNum}`).value = value;
    styleSummaryLabelCell(rowNum, { fontColor });
    styleSummaryValueCell(rowNum, { fontColor });
  }

  // Ensure yellow fill on total row
  applySummaryRow(
    totalRow,
    "TOTAL PRICE IN PHILIPPINE PESO",
    exportSubtotal
  );

  const xlsDiscItems = parseDiscountItems(quote);
  const exportDiscountTotal = roundPeso(
    xlsDiscItems.reduce((sum, item) => sum + Number(item.amount || 0), 0)
  );

  if (xlsDiscItems.length > 0) {
    let curRow = totalRow + 1;
    for (const d of xlsDiscItems) {
      applySummaryRow(
        curRow,
        String(d.label || "Discount").toUpperCase(),
        -roundPeso(d.amount || 0),
        { fontColor: "FFC0392B" }
      );
      curRow++;
    }
    const finalRow = curRow;
    applySummaryRow(
      finalRow,
      "TOTAL PRICE (Php) after DISCOUNT",
      exportSubtotal - exportDiscountTotal
    );

    removeTemplateNoteSection(ws, finalRow + 1, 500);
  } else {
    removeTemplateNoteSection(ws, totalRow + 1, 500);
  }

  populateTechnicalSpecifications(ws, items);

  const buffer = await wb.xlsx.writeBuffer();
  return buffer;
}

async function buildBasic({ quote, items, vatMode = "incl" }) {
  const effectiveVatMode = normalizeVatMode(vatMode);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Quotation");

  ws.getCell("A1").value = "Quotation";
  ws.getCell("A3").value = "Customer Name:";
  ws.getCell("B3").value = quote.customer_name;
  ws.getCell("D3").value = "Quotation Ref:";
  ws.getCell("E3").value = quote.quote_ref;
  ws.getCell("D4").value = "Date:";
  ws.getCell("E4").value = String(quote.quote_date);
  ws.getCell("D5").value = "Valid Until:";
  ws.getCell("E5").value = String(quote.valid_until);

  ws.getRow(7).values = ["ITEM", "ITEM", "QTY", "U.P PESO", "T.P PESO"];
  const exportItems = summarizeForExport(quote, items, { vatMode: effectiveVatMode });

  let r = 8;
  for (const it of exportItems) {
    ws.getCell(`A${r}`).value = it.itemNo;
    ws.getCell(`B${r}`).value = it.description;
    ws.getCell(`C${r}`).value = it.qtyDisplay;
    ws.getCell(`D${r}`).value = Number(it.unitPrice || 0);
    ws.getCell(`E${r}`).value = Number(it.lineTotal || 0);
    r++;
  }

  const basicSubtotal = exportItems.reduce((s, x) => s + Number(x.lineTotal || 0), 0);
  const basicDiscount = roundPeso(quote.discount_amount || 0);
  ws.getCell(`A${r + 1}`).value = "TOTAL PRICE IN PHILIPPINE PESO";
  ws.getCell(`E${r + 1}`).value = basicSubtotal;
  if (basicDiscount > 0) {
    ws.getCell(`A${r + 2}`).value = "PROMOTIONAL DISCOUNT";
    ws.getCell(`A${r + 2}`).font = { bold: true, color: { argb: "FFC0392B" } };
    ws.getCell(`E${r + 2}`).value = -basicDiscount;
    ws.getCell(`E${r + 2}`).font = { bold: true, color: { argb: "FFC0392B" } };
    ws.getCell(`A${r + 3}`).value = "TOTAL PRICE (Php) after DISCOUNT";
    ws.getCell(`E${r + 3}`).value = basicSubtotal - basicDiscount;
  }

  return wb.xlsx.writeBuffer();
}

async function buildCompanyBasic({ quote, items, vatMode = "incl" }) {
  const effectiveVatMode = normalizeVatMode(vatMode);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Company Quotation");

  ws.columns = [
    { header: "ITEM", key: "itemNo", width: 8 },
    { header: "DESCRIPTION", key: "description", width: 44 },
    { header: "QTY", key: "qtyDisplay", width: 10 },
    { header: "U.P. PHP", key: "unitPrice", width: 16 },
    { header: "T.P. PHP", key: "lineTotal", width: 16 }
  ];

  ws.mergeCells("A1:E1");
  ws.getCell("A1").value = "Company Quotation (Internal)";
  ws.getCell("A1").font = { bold: true, size: 16 };

  ws.getCell("A3").value = "Customer Name";
  ws.getCell("B3").value = quote.customer_name || "";
  ws.getCell("D3").value = "Quotation Ref";
  ws.getCell("E3").value = quote.quote_ref || "";

  ws.getCell("A4").value = "Quote Date";
  ws.getCell("B4").value = formatDateForDoc(quote.quote_date);
  ws.getCell("D4").value = "Valid Until";
  ws.getCell("E4").value = formatDateForDoc(quote.valid_until);

  const lines = summarizeForCompany(items, { vatMode: effectiveVatMode });
  let row = 7;
  ws.getRow(row).values = ["ITEM", "ITEM", "QTY", "U.P. PHP", "T.P. PHP"];
  ws.getRow(row).font = { bold: true };

  row += 1;
  for (const line of lines) {
    ws.getCell(`A${row}`).value = line.itemNo;
    ws.getCell(`B${row}`).value = line.description;
    ws.getCell(`C${row}`).value = line.qtyDisplay;
    ws.getCell(`D${row}`).value = Number(line.unitPrice || 0);
    ws.getCell(`E${row}`).value = Number(line.lineTotal || 0);
    ws.getCell(`D${row}`).numFmt = "#,##0.00";
    ws.getCell(`E${row}`).numFmt = "#,##0.00";
    row += 1;
  }

  const materialTotal = roundPeso(lines.reduce((sum, x) => sum + Number(x.lineTotal || 0), 0));
  const packagePrice = roundPeso(quote.package_price_target != null ? quote.package_price_target : quote.total);
  const revenue = roundPeso(packagePrice - materialTotal);

  row += 1;
  ws.getCell(`D${row}`).value = "";
  ws.getCell(`E${row}`).value = materialTotal;
  ws.getCell(`E${row}`).numFmt = "#,##0.00";
  ws.getCell(`D${row}`).font = { bold: true };
  ws.getCell(`E${row}`).font = { bold: true };

  row += 1;
  ws.getCell(`D${row}`).value = "Package Price";
  ws.getCell(`E${row}`).value = packagePrice;
  ws.getCell(`E${row}`).numFmt = "#,##0.00";
  ws.getCell(`D${row}`).font = { bold: true };
  ws.getCell(`E${row}`).font = { bold: true };

  row += 1;
  ws.getCell(`D${row}`).value = "Revenue vs Package";
  ws.getCell(`E${row}`).value = revenue;
  ws.getCell(`E${row}`).numFmt = "#,##0.00";
  ws.getCell(`D${row}`).font = { bold: true };
  ws.getCell(`E${row}`).font = { bold: true, color: { argb: revenue >= 0 ? "FF006100" : "FF9C0006" } };

  return wb.xlsx.writeBuffer();
}

function parseDiscountItems(quote) {
  if (quote.discount_items) {
    try {
      const parsed = typeof quote.discount_items === "string" ? JSON.parse(quote.discount_items) : quote.discount_items;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {}
  }
  const amt = roundPeso(quote.discount_amount || 0);
  if (amt > 0) return [{ label: "Promotional Discount", amount: amt }];
  return [];
}

async function buildCustomerPdf({ quote, items, vatMode = "incl" }) {
  const effectiveVatMode = normalizeVatMode(vatMode);
  const lines = summarizeForExport(quote, items, { vatMode: effectiveVatMode });
  const subtotal = roundPeso(lines.reduce((sum, row) => sum + Number(row.lineTotal || 0), 0));
  const discountItems = parseDiscountItems(quote);
  const discountAmount = discountItems.reduce((s, d) => s + Number(d.amount || 0), 0);
  const total = subtotal - discountAmount;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).font("Helvetica-Bold").text("SOLARES Energy Solutions");
    doc.moveDown(0.25);
    doc.fontSize(10).font("Helvetica").text("Customer Quotation");
    doc.moveDown(0.6);
    doc.fontSize(10).text(`Customer Name: ${quote.customer_name || ""}`);
    doc.text(`Quotation Ref: ${quote.quote_ref || ""}`);
    doc.text(`Date: ${formatDateForDoc(quote.quote_date)}`);
    doc.text(`Valid Until: ${formatDateForDoc(quote.valid_until)}`);

    let y = doc.y + 12;
    const col = { no: 40, item: 90, qty: 360, up: 430, tp: 500 };

    doc.font("Helvetica-Bold").fontSize(10);
    doc.text("ITEM", col.no, y);
    doc.text("DESCRIPTION", col.item, y);
    doc.text("QTY", col.qty, y);
    doc.text("U.P. PHP", col.up, y);
    doc.text("T.P. PHP", col.tp, y);

    y += 16;
    doc.moveTo(40, y - 4).lineTo(555, y - 4).strokeColor("#23364d").stroke();

    doc.font("Helvetica").fontSize(9);
    for (const row of lines) {
      doc.text(String(row.itemNo || ""), col.no, y, { width: 40 });
      doc.text(String(row.description || ""), col.item, y, { width: 260 });
      doc.text(String(row.qtyDisplay || ""), col.qty, y, { width: 55 });
      doc.text(formatCurrencyPhp(row.unitPrice), col.up, y, { width: 65, align: "right" });
      doc.text(formatCurrencyPhp(row.lineTotal), col.tp, y, { width: 65, align: "right" });
      y += 18;
      if (y > 760) {
        doc.addPage();
        y = 50;
      }
    }

    y += 8;
    doc.moveTo(40, y).lineTo(555, y).strokeColor("#23364d").stroke();
    y += 8;
    doc.font("Helvetica-Bold").fontSize(11);

    doc.text("TOTAL PRICE IN PHILIPPINE PESO", 280, y, { width: 180, align: "right" });
    doc.text(formatCurrencyPhp(subtotal), col.tp, y, { width: 65, align: "right" });

    if (discountItems.length > 0) {
      for (const d of discountItems) {
        y += 20;
        if (y > 760) { doc.addPage(); y = 50; }
        doc.fillColor("#c0392b").text(String(d.label || "Discount").toUpperCase(), 280, y, { width: 180, align: "right" });
        doc.text(`-${formatCurrencyPhp(Number(d.amount || 0))}`, col.tp, y, { width: 65, align: "right" });
        doc.fillColor("#000000");
      }
      y += 20;
      doc.moveTo(40, y).lineTo(555, y).strokeColor("#23364d").stroke();
      y += 8;
      doc.font("Helvetica-Bold").fontSize(11);
      doc.text("TOTAL PRICE (Php) after DISCOUNT", 280, y, { width: 180, align: "right" });
      doc.text(formatCurrencyPhp(total), col.tp, y, { width: 65, align: "right" });
    }

    doc.end();
  });
}

async function buildCustomerQuotationExcel({ quote, items, vatMode = "incl" }) {
  const effectiveVatMode = normalizeVatMode(vatMode);
  const templatePath =
    process.env.QUOTE_TEMPLATE_PATH ||
    path.join(__dirname, "../../templates/quotation-template.xlsx");

  if (fs.existsSync(templatePath)) {
    return buildFromTemplate({ quote, items, vatMode: effectiveVatMode });
  }

  return buildBasic({ quote, items, vatMode: effectiveVatMode });
}

async function buildCustomerQuotationPdf({ quote, items, vatMode = "incl" }) {
  const effectiveVatMode = normalizeVatMode(vatMode);
  return buildCustomerPdf({ quote, items, vatMode: effectiveVatMode });
}

async function buildCompanyQuotationExcel({ quote, items, vatMode = "incl" }) {
  const effectiveVatMode = normalizeVatMode(vatMode);
  return buildCompanyBasic({ quote, items, vatMode: effectiveVatMode });
}

module.exports = {
  buildCustomerQuotationExcel,
  buildCustomerQuotationPdf,
  buildCompanyQuotationExcel,
  // backward compatible export name
  buildQuotationExcel: buildCustomerQuotationExcel
};
