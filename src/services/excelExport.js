const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const { addLogoToWorksheet, drawLogoOnPdf } = require("./exportBranding");

function cloneStyle(style) {
  return JSON.parse(JSON.stringify(style || {}));
}

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function resolveCatalogSubgroup(item) {
  return String(item?.catalog_subgroup || "").trim().toLowerCase();
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

function roundMoney(n) {
  return Math.round(Number(n || 0) * 100) / 100;
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

function isPanelItem(item) {
  if (resolveCatalogSubgroup(item) === "panel") return true;
  return isPanelDescription(buildItemSearchText(item));
}

function isBatteryItem(item) {
  if (resolveCatalogSubgroup(item) === "battery") return true;
  return isBatteryDescription(buildItemSearchText(item));
}

function isInverterItem(item) {
  if (resolveCatalogSubgroup(item) === "inverter") return true;
  return isInverterDescription(buildItemSearchText(item));
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
  if (resolveCatalogSubgroup(item) === "mounting") return true;
  return isMountingDescription(buildItemSearchText(item));
}

function groupQuoteItems(items) {
  const nonInstallation = items.filter((it) => Number(it.is_installation) !== 1);
  const installationTotal = roundPeso(
    items
      .filter((it) => Number(it.is_installation) === 1)
      .reduce((s, it) => s + Number(it.line_total || 0), 0)
  );

  const inverterItems = nonInstallation.filter((it) => isInverterItem(it));
  const panelItems = nonInstallation.filter((it) => isPanelItem(it));
  const batteryItems = nonInstallation.filter((it) => isBatteryItem(it));

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

function computeLineFromStoredTotals(rows, { description, qty, unit }) {
  if (!rows.length) return null;
  const lineTotal = roundMoney(
    rows.reduce((sum, row) => sum + Number(row.unit_price || 0) * Number(row.qty || 0), 0)
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

function summarizeForExport(quote, items) {
  const groups = groupQuoteItems(items);
  const { installationTotal, inverterItems, panelItems, batteryItems, mountingItems, safetyItems } = groups;
  const specs = resolveTechnicalSpecs(groups);

  const inverterQty = inverterItems.reduce((s, x) => s + Number(x.qty || 0), 0);
  const panelQty = panelItems.reduce((s, x) => s + Number(x.qty || 0), 0);
  const batteryQty = batteryItems.reduce((s, x) => s + Number(x.qty || 0), 0);

  const lines = [];

  const inverterLine = computeLineFromStoredTotals(inverterItems, {
    description: specs.inverter || inverterItems[0]?.description || "Inverter",
    qty: inverterQty,
    unit: inverterItems[0]?.unit || "PCS"
  });
  if (inverterLine) lines.push(inverterLine);

  const panelLine = computeLineFromStoredTotals(panelItems, {
    description: specs.panel || panelItems[0]?.description || "Solar Panel",
    qty: panelQty,
    unit: panelItems[0]?.unit || "PCS"
  });
  if (panelLine) lines.push(panelLine);

  const batteryLine = computeLineFromStoredTotals(batteryItems, {
    description: specs.battery || batteryItems[0]?.description || "Battery",
    qty: batteryQty,
    unit: batteryItems[0]?.unit || "PCS"
  });
  if (batteryLine) lines.push(batteryLine);

  const safetyLine = computeLineFromStoredTotals(safetyItems, {
    description: "Complete Safety Breakers/SPD",
    qty: 1,
    unit: "SET"
  });
  if (safetyLine && safetyLine.lineTotal > 0) lines.push(safetyLine);

  const mountingLine = computeLineFromStoredTotals(mountingItems, {
    description: "Complete Mounting Fixtures",
    qty: 1,
    unit: "SET"
  });
  if (mountingLine && mountingLine.lineTotal > 0) lines.push(mountingLine);

  const displayedMaterialTotal = roundMoney(lines.reduce((sum, line) => sum + Number(line.lineTotal || 0), 0));

  const packagePriceTarget = Number(quote?.package_price_target || 0);
  const isFixedPackage = String(quote?.pricing_mode || "").trim() === "fixed_package" && packagePriceTarget > 0;

  let totalTarget;
  if (isFixedPackage) {
    totalTarget = roundMoney(packagePriceTarget);
  } else {
    const storedSubtotal = roundMoney(
      (items || []).reduce((sum, row) => sum + Number(row.unit_price || 0) * Number(row.qty || 0), 0)
    );
    const preDiscountTotal = storedSubtotal > 0
      ? storedSubtotal
      : Number.isFinite(Number(quote?.subtotal)) && Number(quote.subtotal) > 0
        ? roundMoney(quote.subtotal)
        : Number.isFinite(Number(quote?.total))
          ? roundMoney(quote.total)
          : null;
    totalTarget = preDiscountTotal != null
      ? preDiscountTotal
      : roundMoney(displayedMaterialTotal + installationTotal);
  }
  const reconciledInstallation = Math.max(0, roundMoney(totalTarget - displayedMaterialTotal));

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

function computeLineFromBase(rows, { description, qty, unit }) {
  if (!rows.length) return null;
  const lineTotal = roundPeso(
    rows.reduce(
      (sum, row) => sum + Number(row.base_price || 0) * Number(row.qty || 0),
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

function summarizeForCompany(items) {
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
    unit: inverterItems[0]?.unit || "PCS"
  });
  if (inverterLine) lines.push(inverterLine);

  const panelLine = computeLineFromBase(panelItems, {
    description: specs.panel || panelItems[0]?.description || "Solar Panel",
    qty: panelQty,
    unit: panelItems[0]?.unit || "PCS"
  });
  if (panelLine) lines.push(panelLine);

  const batteryLine = computeLineFromBase(batteryItems, {
    description: specs.battery || batteryItems[0]?.description || "Battery",
    qty: batteryQty,
    unit: batteryItems[0]?.unit || "PCS"
  });
  if (batteryLine) lines.push(batteryLine);

  const safetyLine = computeLineFromBase(safetyItems, {
    description: "Complete Safety Breakers/SPD",
    qty: 1,
    unit: "SET"
  });
  if (safetyLine && safetyLine.lineTotal > 0) lines.push(safetyLine);

  const mountingLine = computeLineFromBase(mountingItems, {
    description: "Complete Mounting Fixtures",
    qty: 1,
    unit: "SET"
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

function parseWattFromText(value) {
  const match = String(value || "").match(/(\d{3,4})\s*w/i);
  if (!match) return 0;
  const watt = Number(match[1]);
  return Number.isFinite(watt) ? watt : 0;
}

function parseKwFromText(value) {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)\s*kw/i);
  if (!match) return 0;
  const kw = Number(match[1]);
  return Number.isFinite(kw) ? kw : 0;
}

function formatKw(value) {
  const kw = Number(value || 0);
  if (!Number.isFinite(kw) || kw <= 0) return "";
  return `${kw.toFixed(1).replace(/\.0$/, "")}KW`;
}

function resolveSuggestedSetup(items) {
  const groups = groupQuoteItems(items || []);
  const panelKw = groups.panelItems.reduce((sum, item) => {
    const watt = parseWattFromText(buildItemSearchText(item));
    return sum + (watt > 0 ? watt * Number(item.qty || 0) : 0);
  }, 0) / 1000;
  if (panelKw > 0) return formatKw(panelKw);

  const inverterKw = groups.inverterItems.reduce((max, item) => {
    const kw = parseKwFromText(buildItemSearchText(item));
    return Math.max(max, kw);
  }, 0);
  return formatKw(inverterKw);
}

function safeMergeCells(ws, range) {
  try {
    ws.mergeCells(range);
  } catch {}
}

function safeUnmergeCells(ws, range) {
  try {
    ws.unMergeCells(range);
  } catch {}
}

function parseMergeRows(range) {
  const matches = String(range || "").match(/[A-Z]+(\d+)/g) || [];
  const rows = matches
    .map((part) => Number(part.match(/\d+/)?.[0] || 0))
    .filter((row) => row > 0);
  if (!rows.length) return { start: 0, end: 0 };
  return { start: Math.min(...rows), end: Math.max(...rows) };
}

function clearTemplateArea(ws, startRow, endRow, columnCount = 7) {
  for (const merge of [...(ws.model.merges || [])]) {
    const { start, end } = parseMergeRows(merge);
    if (start && end >= startRow && start <= endRow) safeUnmergeCells(ws, merge);
  }

  for (let row = startRow; row <= endRow; row += 1) {
    ws.getRow(row).hidden = false;
    for (let col = 1; col <= columnCount; col += 1) {
      const cell = ws.getCell(row, col);
      cell.value = null;
      cell.style = {};
    }
  }
}

function thinBorder(color = "FF000000") {
  return {
    top: { style: "thin", color: { argb: color } },
    left: { style: "thin", color: { argb: color } },
    bottom: { style: "thin", color: { argb: color } },
    right: { style: "thin", color: { argb: color } }
  };
}

function applyCellBox(cell, options = {}) {
  const {
    fill,
    font,
    alignment = { vertical: "middle", wrapText: true },
    border = thinBorder()
  } = options;
  cell.border = border;
  cell.alignment = alignment;
  if (fill) cell.fill = fill;
  if (font) cell.font = font;
}

function fillRange(ws, row, startCol, endCol, options = {}) {
  for (let col = startCol; col <= endCol; col += 1) {
    applyCellBox(ws.getCell(row, col), options);
  }
}

function setMergedRow(ws, row, range, value, options = {}) {
  safeMergeCells(ws, range);
  ws.getCell(row, 1).value = value;
  fillRange(ws, row, 1, 7, options);
}

function setSpecRow(ws, row, label, value) {
  safeMergeCells(ws, `A${row}:B${row}`);
  safeMergeCells(ws, `C${row}:G${row}`);
  ws.getCell(`A${row}`).value = label;
  ws.getCell(`C${row}`).value = value || "";
  fillRange(ws, row, 1, 7, {
    font: { size: 9 },
    alignment: { vertical: "middle", wrapText: true }
  });
  ws.getCell(`A${row}`).font = { bold: true, size: 9 };
}

function rebuildQuotationTail(ws, startRow, items, { vatMode = "excl" } = {}) {
  const specs = resolveTechnicalSpecs(groupQuoteItems(items || []));
  const endRow = Math.max(startRow + 18, 45);
  clearTemplateArea(ws, startRow, endRow);

  let row = startRow;
  setSpecRow(ws, row++, "Solar Panel Type", specs.panel);
  setSpecRow(ws, row++, "Inverter Type", specs.inverter);
  setSpecRow(ws, row++, "Battery Type", specs.battery);
  setSpecRow(ws, row++, "Warranty on Panels", "12 years");
  setSpecRow(ws, row++, "Warranty on Inverter", "5 years");
  setSpecRow(ws, row++, "Workmanship Warranty", "1 year");

  const yellowFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
  setMergedRow(
    ws,
    row,
    `A${row}:G${row}`,
    `Note: Prices above are VAT ${normalizeVatMode(vatMode) === "incl" ? "inclusive" : "exclusive"}`,
    {
      fill: yellowFill,
      font: { bold: true, size: 9, color: { argb: "FFFF0000" } },
      alignment: { horizontal: "center", vertical: "middle" }
    }
  );
  row += 2;

  const sectionFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9EAF7" } };
  setMergedRow(ws, row, `A${row}:G${row}`, "Delivery & Installation Timeline", {
    fill: sectionFill,
    font: { bold: true, size: 9 },
    alignment: { horizontal: "center", vertical: "middle" }
  });
  row += 1;
  setSpecRow(ws, row++, "Material Delivery", ": Day after the delivery of Materials (or depends on availability of stocks)");
  setSpecRow(ws, row++, "Installation Completion", ": 3-5 days from delivery");
  row += 1;

  setMergedRow(ws, row, `A${row}:G${row}`, "Payment Terms", {
    fill: sectionFill,
    font: { bold: true, size: 9 },
    alignment: { horizontal: "center", vertical: "middle" }
  });
  row += 1;
  const terms = [
    ": 40% Advance along with Work Order",
    ": 40% After Material Delivery",
    ": 20% After Installation & Commissioning"
  ];
  for (const term of terms) {
    safeMergeCells(ws, `A${row}:G${row}`);
    ws.getCell(`A${row}`).value = term;
    fillRange(ws, row, 1, 7, { font: { size: 9 } });
    row += 1;
  }

  return row;
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
  if (!ws.getImages().length) {
    addLogoToWorksheet(wb, ws, { col: 0.15, row: 0.15, width: 66, height: 66 });
  }

  safeMergeCells(ws, "F6:G6");
  safeMergeCells(ws, "F7:G8");
  ws.getCell("F6").value = "Suggested Solar SET-UP:";
  ws.getCell("F6").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFCCB8" } };
  ws.getCell("F6").font = { bold: true, underline: true, size: 10, color: { argb: "FFFF0000" } };
  ws.getCell("F6").alignment = { horizontal: "center", vertical: "middle" };
  ws.getCell("F7").value = resolveSuggestedSetup(items);
  ws.getCell("F7").font = { bold: true, size: 16, color: { argb: "FF000000" } };
  ws.getCell("F7").alignment = { horizontal: "center", vertical: "middle" };
  for (const cellRef of ["F6", "G6", "F7", "G7", "F8", "G8"]) {
    applyCellBox(ws.getCell(cellRef), {
      border: thinBorder("FFFFFFFF"),
      alignment: ws.getCell(cellRef).alignment || { horizontal: "center", vertical: "middle" }
    });
  }

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
  const exportItems = summarizeForExport(quote, items);
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
  const exportSubtotal = roundMoney(
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
  const exportDiscountTotal = roundMoney(
    xlsDiscItems.reduce((sum, item) => sum + Number(item.amount || 0), 0)
  );
  let finalSummaryRow = totalRow;

  if (exportDiscountTotal > 0) {
    applySummaryRow(
      totalRow + 1,
      "PROMOTIONAL DISCOUNT",
      -exportDiscountTotal,
      { fontColor: "FFFF0000" }
    );
    const finalRow = totalRow + 2;
    applySummaryRow(
      finalRow,
      "TOTAL PRICE (Php) after DISCOUNT",
      exportSubtotal - exportDiscountTotal
    );
    finalSummaryRow = finalRow;
  }

  rebuildQuotationTail(ws, finalSummaryRow + 1, items, { vatMode: "excl" });

  const buffer = await wb.xlsx.writeBuffer();
  return buffer;
}

async function buildBasic({ quote, items, vatMode = "incl" }) {
  const effectiveVatMode = normalizeVatMode(vatMode);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Quotation");

  ws.columns = [
    { key: "itemNo", width: 10 },
    { key: "description", width: 48 },
    { key: "qty", width: 12 },
    { key: "unitPrice", width: 16 },
    { key: "lineTotal", width: 16 }
  ];
  ws.getRow(1).height = 28;
  ws.getRow(2).height = 22;
  ws.getRow(3).height = 18;
  addLogoToWorksheet(wb, ws, { col: 0.1, row: 0.1, width: 62, height: 62 });

  ws.mergeCells("B1:E1");
  ws.getCell("B1").value = "SOLARES Energy Solutions";
  ws.getCell("B1").font = { bold: true, size: 18, color: { argb: "FF17365D" } };
  ws.mergeCells("B2:E2");
  ws.getCell("B2").value = "Customer Quotation";
  ws.getCell("B2").font = { bold: true, size: 12, color: { argb: "FF1F4E78" } };

  ws.getCell("A4").value = "Customer Name:";
  ws.getCell("B4").value = quote.customer_name;
  ws.getCell("D4").value = "Quotation Ref:";
  ws.getCell("E4").value = quote.quote_ref;
  ws.getCell("D5").value = "Date:";
  ws.getCell("E5").value = String(quote.quote_date);
  ws.getCell("D6").value = "Valid Until:";
  ws.getCell("E6").value = String(quote.valid_until);

  ws.getRow(8).values = ["ITEM", "ITEM", "QTY", "U.P PESO", "T.P PESO"];
  ws.getRow(8).font = { bold: true };
  const exportItems = summarizeForExport(quote, items);

  let r = 9;
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
    { key: "itemNo", width: 10 },
    { key: "description", width: 48 },
    { key: "qtyDisplay", width: 12 },
    { key: "unitPrice", width: 16 },
    { key: "lineTotal", width: 16 }
  ];

  ws.getRow(1).height = 28;
  ws.getRow(2).height = 22;
  ws.getRow(3).height = 18;
  addLogoToWorksheet(wb, ws, { col: 0.1, row: 0.1, width: 62, height: 62 });

  ws.mergeCells("B1:E1");
  ws.getCell("B1").value = "SOLARES Energy Solutions";
  ws.getCell("B1").font = { bold: true, size: 18, color: { argb: "FF17365D" } };
  ws.mergeCells("B2:E2");
  ws.getCell("B2").value = "Company Quotation (Internal)";
  ws.getCell("B2").font = { bold: true, size: 12, color: { argb: "FF1F4E78" } };

  ws.getCell("A4").value = "Customer Name";
  ws.getCell("B4").value = quote.customer_name || "";
  ws.getCell("D4").value = "Quotation Ref";
  ws.getCell("E4").value = quote.quote_ref || "";

  ws.getCell("A5").value = "Quote Date";
  ws.getCell("B5").value = formatDateForDoc(quote.quote_date);
  ws.getCell("D5").value = "Valid Until";
  ws.getCell("E5").value = formatDateForDoc(quote.valid_until);

  const lines = summarizeForCompany(items);
  let row = 8;
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

function formatPdfMoney(value) {
  return Number(value || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

async function buildCustomerPdf({ quote, items }) {
  const lines = summarizeForExport(quote, items);
  const subtotal = roundMoney(lines.reduce((sum, row) => sum + Number(row.lineTotal || 0), 0));
  const discountItems = parseDiscountItems(quote);
  const discountAmount = roundMoney(discountItems.reduce((s, d) => s + Number(d.amount || 0), 0));
  const total = subtotal - discountAmount;
  const specs = resolveTechnicalSpecs(groupQuoteItems(items || []));
  const suggestedSetup = resolveSuggestedSetup(items || []);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 20 });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const COLORS = {
      navy: "#082866",
      lightBlue: "#D9EAF7",
      yellow: "#FFFF00",
      red: "#FF0000",
      setup: "#FFCCB8",
      black: "#000000",
      blue: "#0066FF"
    };
    const left = 20;
    const tableWidth = 552;
    const widths = { no: 48, item: 260, qty: 86, up: 79, tp: 79 };

    function setFont({ bold = false, size = 8, color = COLORS.black } = {}) {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(color);
    }

    function drawCell(x, y, w, h, text = "", options = {}) {
      const {
        fill,
        color = COLORS.black,
        bold = false,
        size = 8,
        align = "left",
        valign = "middle",
        padding = 3,
        borderColor = COLORS.black
      } = options;
      doc.lineWidth(0.7);
      if (fill) doc.rect(x, y, w, h).fillAndStroke(fill, borderColor);
      else doc.rect(x, y, w, h).stroke(borderColor);
      setFont({ bold, size, color });
      const content = String(text ?? "");
      const textWidth = Math.max(1, w - padding * 2);
      const textHeight = doc.heightOfString(content, { width: textWidth, align });
      const textY = valign === "top" ? y + padding : y + Math.max(padding, (h - textHeight) / 2);
      doc.text(content, x + padding, textY, {
        width: textWidth,
        align,
        height: Math.max(1, h - padding * 2)
      });
    }

    function rowHeightFor(text, width, baseHeight = 19, size = 8) {
      setFont({ size });
      return Math.max(baseHeight, doc.heightOfString(String(text || ""), { width: width - 8 }) + 8);
    }

    function drawMergedRow(y, h, label, value, options = {}) {
      drawCell(left, y, widths.no + widths.item + widths.qty + widths.up, h, label, {
        fill: COLORS.yellow,
        bold: true,
        size: 8.5,
        align: "right",
        color: options.color || COLORS.black
      });
      drawCell(left + widths.no + widths.item + widths.qty + widths.up, y, widths.tp, h, value, {
        fill: COLORS.yellow,
        bold: true,
        size: 8.5,
        align: "right",
        color: options.color || COLORS.black
      });
    }

    drawLogoOnPdf(doc, { x: 48, y: 28, width: 70, height: 70 });
    setFont({ bold: true, size: 16 });
    doc.text("SOLARES Energy Solutions", 145, 32);
    setFont({ size: 8 });
    doc.text("Sumacab Norte, Cabanatuan City", 145, 52);
    doc.text("Nueva Ecija, 3100", 145, 64);
    setFont({ bold: true, size: 8 });
    doc.text("Email Address:", 145, 88);
    setFont({ size: 8, color: COLORS.blue });
    doc.text(" solares.energysolutions@gmail.com", 207, 88);
    setFont({ bold: true, size: 8 });
    doc.text("Cellphone No.:", 145, 101);
    setFont({ size: 8 });
    doc.text(" 0967-886-7909", 210, 101);

    drawCell(412, 87, 140, 16, "Suggested Solar SET-UP:", {
      fill: COLORS.setup,
      bold: true,
      color: COLORS.red,
      size: 8,
      align: "center"
    });
    drawCell(412, 103, 140, 28, suggestedSetup || "", {
      fill: "#FFFFFF",
      bold: true,
      size: 16,
      align: "center"
    });

    let y = 123;
    drawCell(left, y, tableWidth, 15, "Quotation", {
      fill: COLORS.lightBlue,
      bold: true,
      size: 11,
      align: "center"
    });
    y += 15;

    const leftInfoWidth = widths.no + widths.item;
    const labelWidth = widths.qty;
    const rightInfoWidth = widths.up + widths.tp;
    drawCell(left, y, leftInfoWidth, 17, `Customer Name: ${quote.customer_name || ""}`, { bold: true, size: 7.5 });
    drawCell(left + leftInfoWidth, y, labelWidth, 17, "Quotation Ref:", { bold: true, size: 7.5 });
    drawCell(left + leftInfoWidth + labelWidth, y, rightInfoWidth, 17, quote.quote_ref || "", { size: 7.5, align: "center" });
    y += 17;
    drawCell(left, y, leftInfoWidth, 17, "", { size: 7.5 });
    drawCell(left + leftInfoWidth, y, labelWidth, 17, "Date", { bold: true, size: 7.5 });
    drawCell(left + leftInfoWidth + labelWidth, y, rightInfoWidth, 17, formatDateForDoc(quote.quote_date), { size: 7.5, align: "center" });
    y += 17;
    drawCell(left, y, leftInfoWidth, 17, "", { size: 7.5 });
    drawCell(left + leftInfoWidth, y, labelWidth, 17, "Valid  Until", { bold: true, size: 7.5 });
    drawCell(left + leftInfoWidth + labelWidth, y, rightInfoWidth, 17, formatDateForDoc(quote.valid_until), { size: 7.5, align: "center" });
    y += 17;

    drawCell(left, y, widths.no, 27, "ITEM", { fill: COLORS.navy, color: "#FFFFFF", bold: true, align: "center" });
    drawCell(left + widths.no, y, widths.item, 27, "ITEM", { fill: COLORS.navy, color: "#FFFFFF", bold: true, align: "center" });
    drawCell(left + widths.no + widths.item, y, widths.qty, 27, "QTY", { fill: COLORS.navy, color: "#FFFFFF", bold: true, align: "center" });
    drawCell(left + widths.no + widths.item + widths.qty, y, widths.up, 27, "U.P.\nPESO", { fill: COLORS.navy, color: "#FFFFFF", bold: true, align: "center" });
    drawCell(left + widths.no + widths.item + widths.qty + widths.up, y, widths.tp, 27, "T.P\nPESO", { fill: COLORS.navy, color: "#FFFFFF", bold: true, align: "center" });
    y += 27;

    for (const row of lines) {
      const h = rowHeightFor(row.description, widths.item, 23, 8);
      drawCell(left, y, widths.no, h, row.itemNo || "", { align: "center", size: 8 });
      drawCell(left + widths.no, y, widths.item, h, row.description || "", { size: 8, valign: "top" });
      drawCell(left + widths.no + widths.item, y, widths.qty, h, row.qtyDisplay || "", { align: "center", size: 8 });
      drawCell(left + widths.no + widths.item + widths.qty, y, widths.up, h, formatPdfMoney(row.unitPrice), { align: "right", size: 8 });
      drawCell(left + widths.no + widths.item + widths.qty + widths.up, y, widths.tp, h, formatPdfMoney(row.lineTotal), { align: "right", size: 8 });
      y += h;
      if (y > 720) {
        doc.addPage();
        y = 30;
      }
    }

    drawMergedRow(y, 19, "TOTAL PRICE IN PHILIPPINE PESO", formatPdfMoney(subtotal));
    y += 19;

    if (discountAmount > 0) {
      drawMergedRow(y, 19, "PROMOTIONAL DISCOUNT", `-${formatPdfMoney(discountAmount)}`, { color: COLORS.red });
      y += 19;
      drawMergedRow(y, 19, "TOTAL PRICE (Php) after DISCOUNT", formatPdfMoney(total));
      y += 19;
    }

    function drawSpecRow(label, value, minHeight = 15) {
      const h = rowHeightFor(value, tableWidth - 148, minHeight, 7.2);
      drawCell(left, y, 148, h, label, { bold: true, size: 7.2 });
      drawCell(left + 148, y, tableWidth - 148, h, value || "", { size: 7.2, valign: "top" });
      y += h;
    }

    drawSpecRow("Solar Panel Type", specs.panel);
    drawSpecRow("Inverter Type", specs.inverter);
    drawSpecRow("Battery Type", specs.battery, 20);
    drawSpecRow("Warranty on Panels", "12 years");
    drawSpecRow("Warranty on Inverter", "5 years");
    drawSpecRow("Workmanship Warranty", "1 year");

    drawCell(left, y, tableWidth, 18, "Note: Prices above are VAT exclusive", {
      fill: COLORS.yellow,
      bold: true,
      color: COLORS.red,
      align: "center",
      size: 8
    });
    y += 28;

    drawCell(left, y, tableWidth, 16, "Delivery & Installation Timeline", {
      fill: COLORS.lightBlue,
      bold: true,
      align: "center",
      size: 8
    });
    y += 16;
    drawSpecRow("Material Delivery", ": Day after the delivery of Materials (or depends on availability of stocks)");
    drawSpecRow("Installation Completion", ": 3-5 days from delivery");
    y += 12;

    drawCell(left, y, tableWidth, 16, "Payment Terms", {
      fill: COLORS.lightBlue,
      bold: true,
      align: "center",
      size: 8
    });
    y += 16;
    for (const term of [
      ": 40% Advance along with Work Order",
      ": 40% After Material Delivery",
      ": 20% After Installation & Commissioning"
    ]) {
      drawCell(left, y, tableWidth, 15, term, { size: 7.5 });
      y += 15;
    }

    doc.end();
  });
}

function buildCustomerQuotationPreviewData({ quote, items }) {
  const lines = summarizeForExport(quote, items || []);
  const subtotal = roundMoney(lines.reduce((sum, row) => sum + Number(row.lineTotal || 0), 0));
  const discountItems = parseDiscountItems(quote || {});
  const discountTotal = roundMoney(discountItems.reduce((sum, item) => sum + Number(item.amount || 0), 0));
  const specs = resolveTechnicalSpecs(groupQuoteItems(items || []));

  return {
    lines,
    subtotal,
    discountItems,
    discountTotal,
    total: roundMoney(subtotal - discountTotal),
    specs,
    suggestedSetup: resolveSuggestedSetup(items || []),
    quoteRef: quote?.quote_ref || "",
    customerName: quote?.customer_name || "",
    quoteDate: quote?.quote_date || "",
    validUntil: quote?.valid_until || ""
  };
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
  buildCustomerQuotationPreviewData,
  buildCustomerQuotationExcel,
  buildCustomerQuotationPdf,
  buildCompanyQuotationExcel,
  // backward compatible export name
  buildQuotationExcel: buildCustomerQuotationExcel
};
