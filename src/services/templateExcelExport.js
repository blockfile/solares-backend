const ExcelJS = require("exceljs");

const SECTION_DEFS = [
  { key: "main_system", label: "A. Main System Components" },
  { key: "dc_pv", label: "B. DC Protection / PV Side" },
  { key: "ac_distribution", label: "C. AC Protection / Distribution" },
  { key: "mounting_structural", label: "D. Mounting / Structural" },
  { key: "cabling_conduits", label: "E. Cabling / Conduits" },
  { key: "grounding", label: "F. Grounding System" },
  { key: "consumables", label: "G. Termination / Consumables" }
];

const SECTION_INDEX = new Map(SECTION_DEFS.map((row, index) => [row.key, index]));

const COLORS = {
  navy: "FF17365D",
  navyLight: "FFDCE6F1",
  gold: "FFFFC000",
  goldLight: "FFFFF2CC",
  green: "FF92D050",
  greenDark: "FF548235",
  greenLight: "FFE2F0D9",
  yellow: "FFFFFF00",
  gray: "FFD9E2F3",
  grayBorder: "FF7F8FA6",
  white: "FFFFFFFF",
  black: "FF000000"
};

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeVatMode(value) {
  return String(value || "").trim().toLowerCase() === "excl" ? "excl" : "incl";
}

function sanitizeSheetName(value) {
  const text = String(value || "Template Export")
    .replace(/[:\\/?*\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (text || "Template Export").slice(0, 31);
}

function parseTemplateBatteryAh(name) {
  const match = String(name || "").match(/(\d+(?:\.\d+)?)\s*ah/i);
  return match ? Number(match[1]) : null;
}

function parseTemplateKw(name) {
  const match = String(name || "").match(/(\d+(?:\.\d+)?)\s*kw/i);
  return match ? Number(match[1]) : null;
}

function inferSheetLabel(name) {
  const batteryAh = parseTemplateBatteryAh(name);
  if (batteryAh != null) return `${batteryAh}Ah`;
  if (String(name || "").toLowerCase().includes("no battery")) return "No Battery";

  const kw = parseTemplateKw(name);
  if (kw != null) return `${kw}kW`;

  return String(name || "Template");
}

function makeUniqueSheetName(workbook, preferredName) {
  const base = sanitizeSheetName(preferredName) || "Template";
  let candidate = base;
  let counter = 2;

  while (workbook.getWorksheet(candidate)) {
    const suffix = `-${counter}`;
    candidate = `${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`;
    counter += 1;
  }

  return candidate;
}

function formatTimestamp(value = new Date()) {
  return new Intl.DateTimeFormat("en-PH", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(value);
}

function cloneStyle(style) {
  return JSON.parse(JSON.stringify(style || {}));
}

function applyCellStyle(cell, style) {
  cell.style = cloneStyle(style);
}

function applyRowStyle(ws, rowNumber, columns, style) {
  for (const column of columns) {
    applyCellStyle(ws.getCell(`${column}${rowNumber}`), style);
  }
}

function buildFormulaFromRefs(refs) {
  if (!refs.length) return "0";
  return refs.join("+");
}

function sortItems(a, b) {
  const sectionDiff =
    (SECTION_INDEX.get(String(a.section_key || "")) ?? Number.MAX_SAFE_INTEGER) -
    (SECTION_INDEX.get(String(b.section_key || "")) ?? Number.MAX_SAFE_INTEGER);
  if (sectionDiff !== 0) return sectionDiff;

  const itemNoDiff = toNumber(a.item_no, 0) - toNumber(b.item_no, 0);
  if (itemNoDiff !== 0) return itemNoDiff;

  return String(a.description || "").localeCompare(String(b.description || ""));
}

function groupItems(items) {
  const grouped = new Map(SECTION_DEFS.map((section) => [section.key, []]));

  for (const item of [...items].sort(sortItems)) {
    const key = grouped.has(String(item.section_key || "")) ? String(item.section_key || "") : "consumables";
    grouped.get(key).push(item);
  }

  return SECTION_DEFS.map((section) => ({
    ...section,
    items: grouped.get(section.key) || []
  }));
}

function moneyCellStyle(fillColor) {
  return {
    font: { color: { argb: COLORS.black }, bold: true },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: fillColor } },
    border: {
      top: { style: "thin", color: { argb: COLORS.grayBorder } },
      left: { style: "thin", color: { argb: COLORS.grayBorder } },
      bottom: { style: "thin", color: { argb: COLORS.grayBorder } },
      right: { style: "thin", color: { argb: COLORS.grayBorder } }
    },
    alignment: { horizontal: "right", vertical: "middle" },
    numFmt: "#,##0.00"
  };
}

function statusCellStyle(fillColor) {
  return {
    font: { color: { argb: COLORS.black }, bold: true },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: fillColor } },
    border: {
      top: { style: "thin", color: { argb: COLORS.grayBorder } },
      left: { style: "thin", color: { argb: COLORS.grayBorder } },
      bottom: { style: "thin", color: { argb: COLORS.grayBorder } },
      right: { style: "thin", color: { argb: COLORS.grayBorder } }
    },
    alignment: { horizontal: "center", vertical: "middle" }
  };
}

async function buildTemplateWorkbook({ template, items, packageScenarios = [], vatMode = "incl" }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Codex";
  workbook.company = "SOLARES";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  await addTemplateWorksheet(workbook, {
    template,
    items,
    packageScenarios,
    sheetName: `${template.name} Costing`,
    vatMode
  });
  return workbook.xlsx.writeBuffer();
}

async function addTemplateWorksheet(
  workbook,
  { template, items, packageScenarios = [], sheetName = null, vatMode = "incl" }
) {
  const effectiveVatMode = normalizeVatMode(vatMode);
  const worksheet = workbook.addWorksheet(makeUniqueSheetName(workbook, sheetName || inferSheetLabel(template.name)), {
    views: [{ state: "frozen", ySplit: 6 }]
  });

  worksheet.columns = [
    { key: "no", width: 8 },
    { key: "description", width: 56 },
    { key: "unit", width: 12 },
    { key: "qty", width: 12 },
    { key: "unitPrice", width: 16 },
    { key: "total", width: 18 }
  ];

  const titleStyle = {
    font: { bold: true, size: 18, color: { argb: COLORS.white } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navy } },
    alignment: { horizontal: "center", vertical: "middle" }
  };
  const subtitleStyle = {
    font: { bold: true, size: 12, color: { argb: COLORS.navy } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navyLight } },
    alignment: { horizontal: "center", vertical: "middle" }
  };
  const infoStyle = {
    font: { size: 10, color: { argb: COLORS.black } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.white } },
    alignment: { horizontal: "left", vertical: "middle" }
  };
  const sectionStyle = {
    font: { bold: true, size: 11, color: { argb: COLORS.black } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.green } },
    border: {
      top: { style: "thin", color: { argb: COLORS.greenDark } },
      left: { style: "thin", color: { argb: COLORS.greenDark } },
      bottom: { style: "thin", color: { argb: COLORS.greenDark } },
      right: { style: "thin", color: { argb: COLORS.greenDark } }
    },
    alignment: { horizontal: "center", vertical: "middle" }
  };
  const headerStyle = {
    font: { bold: true, color: { argb: COLORS.white } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navy } },
    border: {
      top: { style: "thin", color: { argb: COLORS.grayBorder } },
      left: { style: "thin", color: { argb: COLORS.grayBorder } },
      bottom: { style: "thin", color: { argb: COLORS.grayBorder } },
      right: { style: "thin", color: { argb: COLORS.grayBorder } }
    },
    alignment: { horizontal: "center", vertical: "middle" }
  };
  const bodyStyle = {
    font: { size: 10, color: { argb: COLORS.black } },
    border: {
      top: { style: "thin", color: { argb: COLORS.grayBorder } },
      left: { style: "thin", color: { argb: COLORS.grayBorder } },
      bottom: { style: "thin", color: { argb: COLORS.grayBorder } },
      right: { style: "thin", color: { argb: COLORS.grayBorder } }
    },
    alignment: { vertical: "middle" }
  };
  const totalLabelStyle = {
    font: { bold: true, color: { argb: COLORS.black } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.greenLight } },
    border: {
      top: { style: "thin", color: { argb: COLORS.grayBorder } },
      left: { style: "thin", color: { argb: COLORS.grayBorder } },
      bottom: { style: "thin", color: { argb: COLORS.grayBorder } },
      right: { style: "thin", color: { argb: COLORS.grayBorder } }
    },
    alignment: { horizontal: "right", vertical: "middle" }
  };
  const noteStyle = {
    font: { italic: true, color: { argb: "FF666666" } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.white } },
    border: {
      top: { style: "thin", color: { argb: COLORS.grayBorder } },
      left: { style: "thin", color: { argb: COLORS.grayBorder } },
      bottom: { style: "thin", color: { argb: COLORS.grayBorder } },
      right: { style: "thin", color: { argb: COLORS.grayBorder } }
    },
    alignment: { horizontal: "center", vertical: "middle" }
  };
  const scenarioHeaderStyle = {
    font: { bold: true, color: { argb: COLORS.black } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.gold } },
    border: {
      top: { style: "thin", color: { argb: COLORS.grayBorder } },
      left: { style: "thin", color: { argb: COLORS.grayBorder } },
      bottom: { style: "thin", color: { argb: COLORS.grayBorder } },
      right: { style: "thin", color: { argb: COLORS.grayBorder } }
    },
    alignment: { horizontal: "center", vertical: "middle" }
  };
  const revenueStyle = {
    font: { bold: true, color: { argb: COLORS.black } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.greenLight } },
    border: {
      top: { style: "thin", color: { argb: COLORS.grayBorder } },
      left: { style: "thin", color: { argb: COLORS.grayBorder } },
      bottom: { style: "thin", color: { argb: COLORS.grayBorder } },
      right: { style: "thin", color: { argb: COLORS.grayBorder } }
    },
    alignment: { horizontal: "right", vertical: "middle" },
    numFmt: '[Green]#,##0.00;[Red]-#,##0.00;0.00'
  };

  worksheet.mergeCells("A1:F1");
  worksheet.getCell("A1").value = "Template Costing Workbook";
  applyCellStyle(worksheet.getCell("A1"), titleStyle);

  worksheet.mergeCells("A2:F2");
  worksheet.getCell("A2").value = template.name || "Template";
  applyCellStyle(worksheet.getCell("A2"), subtitleStyle);

  worksheet.mergeCells("A3:C3");
  worksheet.getCell("A3").value = `Generated: ${formatTimestamp()}`;
  applyCellStyle(worksheet.getCell("A3"), infoStyle);

  worksheet.mergeCells("D3:F3");
  worksheet.getCell("D3").value = "Yellow cells are editable. Revenue formulas update automatically in Excel.";
  applyCellStyle(worksheet.getCell("D3"), infoStyle);
  worksheet.getCell("D3").alignment = { horizontal: "right", vertical: "middle" };

  worksheet.mergeCells("A4:F4");
  worksheet.getCell("A4").value = effectiveVatMode === "incl"
    ? "This export uses the latest resolved material prices (12% VAT included for catalog-linked items) and keeps live formulas for totals and revenue analysis."
    : "This export uses the latest resolved material prices with VAT excluded and keeps live formulas for totals and revenue analysis.";
  applyCellStyle(worksheet.getCell("A4"), infoStyle);

  let row = 6;
  const sectionTotals = [];
  const groupedSections = groupItems(items);

  for (const section of groupedSections) {
    worksheet.mergeCells(`A${row}:F${row}`);
    worksheet.getCell(`A${row}`).value = section.label;
    applyCellStyle(worksheet.getCell(`A${row}`), sectionStyle);
    row += 1;

    const unitPriceLabel = effectiveVatMode === "incl" ? "Unit Price (VAT Incl.)" : "Unit Price (VAT Excl.)";
    ["No.", "Description", "Unit", "Qty", unitPriceLabel, "Total"].forEach((label, index) => {
      const cell = worksheet.getCell(row, index + 1);
      cell.value = label;
      applyCellStyle(cell, headerStyle);
    });
    row += 1;

    if (!section.items.length) {
      worksheet.mergeCells(`A${row}:F${row}`);
      worksheet.getCell(`A${row}`).value = "No items configured in this section";
      applyCellStyle(worksheet.getCell(`A${row}`), noteStyle);
      row += 2;
      continue;
    }

    const dataStartRow = row;
    for (const item of section.items) {
      worksheet.getCell(`A${row}`).value = toNumber(item.item_no, row - dataStartRow + 1);
      worksheet.getCell(`B${row}`).value = String(item.description || "");
      worksheet.getCell(`C${row}`).value = String(item.unit || "PCS");
      worksheet.getCell(`D${row}`).value = toNumber(item.qty, 0);
      worksheet.getCell(`E${row}`).value = toNumber(item.base_price, 0);
      worksheet.getCell(`F${row}`).value = { formula: `D${row}*E${row}` };

      applyRowStyle(worksheet, row, ["A", "B", "C", "D", "E", "F"], bodyStyle);
      worksheet.getCell(`A${row}`).alignment = { horizontal: "center", vertical: "middle" };
      worksheet.getCell(`C${row}`).alignment = { horizontal: "center", vertical: "middle" };
      worksheet.getCell(`D${row}`).alignment = { horizontal: "center", vertical: "middle" };
      worksheet.getCell(`E${row}`).numFmt = "#,##0.00";
      worksheet.getCell(`F${row}`).numFmt = "#,##0.00";
      row += 1;
    }

    worksheet.mergeCells(`A${row}:E${row}`);
    worksheet.getCell(`A${row}`).value = `${section.label} Total`;
    worksheet.getCell(`F${row}`).value = {
      formula: `SUM(F${dataStartRow}:F${row - 1})`
    };
    applyCellStyle(worksheet.getCell(`A${row}`), totalLabelStyle);
    applyCellStyle(worksheet.getCell(`F${row}`), moneyCellStyle(COLORS.greenLight));
    applyRowStyle(worksheet, row, ["B", "C", "D", "E"], totalLabelStyle);
    worksheet.getCell(`F${row}`).numFmt = "#,##0.00";
    sectionTotals.push(`F${row}`);
    row += 2;
  }

  worksheet.mergeCells(`A${row}:E${row}`);
  worksheet.getCell(`A${row}`).value = "TOTAL AMOUNT";
  worksheet.getCell(`F${row}`).value = { formula: buildFormulaFromRefs(sectionTotals) };
  applyCellStyle(worksheet.getCell(`A${row}`), totalLabelStyle);
  applyCellStyle(worksheet.getCell(`F${row}`), moneyCellStyle(COLORS.gold));
  applyRowStyle(worksheet, row, ["B", "C", "D", "E"], totalLabelStyle);
  worksheet.getCell(`F${row}`).font = { bold: true, size: 12, color: { argb: COLORS.black } };
  const grandTotalRow = row;

  row += 2;
  worksheet.mergeCells(`A${row}:C${row}`);
  worksheet.getCell(`A${row}`).value = "Manual Pricing Summary";
  applyCellStyle(worksheet.getCell(`A${row}`), scenarioHeaderStyle);
  applyRowStyle(worksheet, row, ["D", "E", "F"], scenarioHeaderStyle);
  row += 1;

  worksheet.mergeCells(`A${row}:D${row}`);
  worksheet.getCell(`A${row}`).value = "Package Price";
  worksheet.getCell(`F${row}`).value =
    packageScenarios.length === 1 ? toNumber(packageScenarios[0].package_price, 0) : 0;
  applyCellStyle(worksheet.getCell(`A${row}`), totalLabelStyle);
  applyRowStyle(worksheet, row, ["B", "C", "D", "E"], totalLabelStyle);
  applyCellStyle(worksheet.getCell(`F${row}`), moneyCellStyle(COLORS.yellow));
  row += 1;

  worksheet.mergeCells(`A${row}:D${row}`);
  worksheet.getCell(`A${row}`).value = "Revenue";
  worksheet.getCell(`F${row}`).value = { formula: `F${row - 1}-F${grandTotalRow}` };
  applyCellStyle(worksheet.getCell(`A${row}`), totalLabelStyle);
  applyRowStyle(worksheet, row, ["B", "C", "D", "E"], totalLabelStyle);
  applyCellStyle(worksheet.getCell(`F${row}`), revenueStyle);
  const manualRevenueRow = row;
  row += 2;

  if (packageScenarios.length) {
    worksheet.mergeCells(`A${row}:F${row}`);
    worksheet.getCell(`A${row}`).value = "Saved Package Scenario Analysis";
    applyCellStyle(worksheet.getCell(`A${row}`), scenarioHeaderStyle);
    row += 1;

    ["Scenario", "Status", "Package Price", "Revenue", "Notes", ""].forEach((label, index) => {
      const cell = worksheet.getCell(row, index + 1);
      cell.value = index < 5 ? label : null;
      applyCellStyle(cell, scenarioHeaderStyle);
    });
    worksheet.mergeCells(`E${row}:F${row}`);
    row += 1;

    for (const scenario of packageScenarios) {
      worksheet.getCell(`A${row}`).value = String(scenario.scenario_label || "Scenario");
      worksheet.getCell(`B${row}`).value = Number(scenario.is_active) === 1 ? "Active" : "Inactive";
      worksheet.getCell(`C${row}`).value = toNumber(scenario.package_price, 0);
      worksheet.getCell(`D${row}`).value = { formula: `C${row}-F${grandTotalRow}` };
      worksheet.mergeCells(`E${row}:F${row}`);
      worksheet.getCell(`E${row}`).value =
        Number(scenario.is_active) === 1
          ? "Used in quotes when selected"
          : "Kept for reference only";

      applyRowStyle(worksheet, row, ["A", "B", "C", "D", "E", "F"], bodyStyle);
      worksheet.getCell(`B${row}`).alignment = { horizontal: "center", vertical: "middle" };
      worksheet.getCell(`C${row}`).numFmt = "#,##0.00";
      applyCellStyle(
        worksheet.getCell(`B${row}`),
        Number(scenario.is_active) === 1 ? statusCellStyle(COLORS.greenLight) : statusCellStyle(COLORS.gray)
      );
      applyCellStyle(worksheet.getCell(`D${row}`), revenueStyle);
      row += 1;
    }
  }

  worksheet.getCell(`A${manualRevenueRow + 2}`).value = "Currency: PHP";
  worksheet.getCell(`A${manualRevenueRow + 2}`).font = { italic: true, color: { argb: "FF666666" } };
}

async function buildTemplateWorkbookBundle({ templates, vatMode = "incl" }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Codex";
  workbook.company = "SOLARES";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  for (const entry of templates) {
    await addTemplateWorksheet(workbook, { ...entry, vatMode });
  }

  return workbook.xlsx.writeBuffer();
}

module.exports = {
  buildTemplateWorkbook,
  buildTemplateWorkbookBundle
};
