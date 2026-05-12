const ExcelJS = require("exceljs");
const { addLogoToWorksheet } = require("./exportBranding");

const COLORS = {
  navy: "FF17365D",
  blue: "FF1F4E78",
  lightBlue: "FFD9EAF7",
  lightGreen: "FFE2F0D9",
  lightRed: "FFFCE4D6",
  gray: "FFE7E6E6",
  grayBorder: "FFB7C3D0",
  white: "FFFFFFFF",
  black: "FF000000",
  muted: "FF667085"
};

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatGeneratedAt(value = new Date()) {
  return new Intl.DateTimeFormat("en-PH", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(value);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function accountTypeLabel(type) {
  const normalized = String(type || "").toLowerCase();
  if (normalized === "income") return "Income";
  if (normalized === "investment") return "Investment";
  if (normalized === "withdrawal") return "Withdrawal";
  return "Expense";
}

function directionLabel(type) {
  return String(type || "").toLowerCase() === "in" ? "In" : "Out";
}

function moneyStyle() {
  return {
    numFmt: '"PHP "#,##0.00;[Red]"PHP "-#,##0.00',
    alignment: { horizontal: "right", vertical: "middle" }
  };
}

function applyBorder(cell) {
  cell.border = {
    top: { style: "thin", color: { argb: COLORS.grayBorder } },
    left: { style: "thin", color: { argb: COLORS.grayBorder } },
    bottom: { style: "thin", color: { argb: COLORS.grayBorder } },
    right: { style: "thin", color: { argb: COLORS.grayBorder } }
  };
}

function applySummaryCell(cell, fillColor) {
  applyBorder(cell);
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillColor } };
  cell.font = { bold: true, color: { argb: COLORS.black } };
  cell.alignment = { horizontal: "center", vertical: "middle" };
}

function buildFilterSummary(filters = {}) {
  const parts = [];
  const type = cleanText(filters.type);
  const accountName = cleanText(filters.accountName);
  const projectName = cleanText(filters.projectName);
  const customerName = cleanText(filters.customerName);
  const q = cleanText(filters.q);

  if (type && type !== "all") parts.push(`Type: ${accountTypeLabel(type)}`);
  if (accountName) parts.push(`Category: ${accountName}`);
  if (customerName || projectName) {
    parts.push(`Project: ${[customerName, projectName].filter(Boolean).join(" - ")}`);
  }
  if (filters.dateFrom || filters.dateTo) {
    parts.push(`Date: ${filters.dateFrom || "Start"} to ${filters.dateTo || "Today"}`);
  }
  if (q) parts.push(`Search: ${q}`);
  if (filters.limit) parts.push(`Max rows: ${filters.limit}`);

  return parts.length ? parts.join(" | ") : "All raw financial logs";
}

function setCellDate(cell, value, format = "yyyy-mm-dd") {
  const parsed = parseDate(value);
  cell.value = parsed || cleanText(value);
  if (parsed) cell.numFmt = format;
}

function styleHeaderRow(row) {
  row.height = 22;
  row.eachCell((cell) => {
    applyBorder(cell);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navy } };
    cell.font = { bold: true, color: { argb: COLORS.white } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
}

function styleBodyRow(row, index, columnCount = 18) {
  for (let column = 1; column <= columnCount; column += 1) {
    const cell = row.getCell(column);
    applyBorder(cell);
    cell.alignment = { vertical: "top", wrapText: true };
    if (index % 2 === 1) {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FBFD" } };
    }
  }
}

async function buildBudgetRawLogsWorkbook({ transactions = [], filters = {}, exportedBy = "" }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "SOLARES";
  workbook.company = "SOLARES";
  workbook.created = new Date();
  workbook.modified = new Date();

  const worksheet = workbook.addWorksheet("Raw Logs", {
    views: [{ state: "frozen", ySplit: 8 }]
  });

  worksheet.columns = [
    { key: "id", width: 11 },
    { key: "date", width: 14 },
    { key: "category", width: 22 },
    { key: "accountType", width: 16 },
    { key: "direction", width: 11 },
    { key: "description", width: 36 },
    { key: "reference", width: 18 },
    { key: "customer", width: 24 },
    { key: "project", width: 28 },
    { key: "price", width: 16 },
    { key: "quantity", width: 12 },
    { key: "discount", width: 16 },
    { key: "amount", width: 16 },
    { key: "importSource", width: 24 },
    { key: "importBatch", width: 22 },
    { key: "createdBy", width: 20 },
    { key: "createdAt", width: 20 },
    { key: "notes", width: 36 }
  ];

  worksheet.getRow(1).height = 26;
  worksheet.getRow(2).height = 22;
  worksheet.getRow(3).height = 20;
  worksheet.getRow(4).height = 20;
  worksheet.getRow(5).height = 8;
  worksheet.getRow(6).height = 24;
  worksheet.getRow(7).height = 8;
  worksheet.getColumn(1).width = 13;

  addLogoToWorksheet(workbook, worksheet, { col: 0.15, row: 0.15, width: 64, height: 64 });

  worksheet.mergeCells("B1:R1");
  worksheet.getCell("B1").value = "SOLARES Energy Solutions";
  worksheet.getCell("B1").font = { bold: true, size: 18, color: { argb: COLORS.navy } };
  worksheet.getCell("B1").alignment = { horizontal: "left", vertical: "middle" };

  worksheet.mergeCells("B2:R2");
  worksheet.getCell("B2").value = "Financial Management - Raw Logs Export";
  worksheet.getCell("B2").font = { bold: true, size: 13, color: { argb: COLORS.blue } };
  worksheet.getCell("B2").alignment = { horizontal: "left", vertical: "middle" };

  worksheet.mergeCells("B3:R3");
  worksheet.getCell("B3").value = `Generated: ${formatGeneratedAt()}${exportedBy ? ` | Exported by: ${exportedBy}` : ""}`;
  worksheet.getCell("B3").font = { size: 10, color: { argb: COLORS.muted } };

  worksheet.mergeCells("B4:R4");
  worksheet.getCell("B4").value = buildFilterSummary(filters);
  worksheet.getCell("B4").font = { italic: true, size: 10, color: { argb: COLORS.muted } };
  worksheet.getCell("B4").alignment = { wrapText: true, vertical: "middle" };

  const totalIn = transactions
    .filter((row) => String(row.type || "").toLowerCase() === "in")
    .reduce((sum, row) => sum + toNumber(row.amount, 0), 0);
  const totalOut = transactions
    .filter((row) => String(row.type || "").toLowerCase() === "out")
    .reduce((sum, row) => sum + toNumber(row.amount, 0), 0);
  const net = totalIn - totalOut;

  worksheet.mergeCells("A6:C6");
  worksheet.getCell("A6").value = `Rows: ${transactions.length}`;
  applySummaryCell(worksheet.getCell("A6"), COLORS.gray);

  worksheet.mergeCells("D6:F6");
  worksheet.getCell("D6").value = `Total In: PHP ${totalIn.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  applySummaryCell(worksheet.getCell("D6"), COLORS.lightGreen);

  worksheet.mergeCells("G6:I6");
  worksheet.getCell("G6").value = `Total Out: PHP ${totalOut.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  applySummaryCell(worksheet.getCell("G6"), COLORS.lightRed);

  worksheet.mergeCells("J6:R6");
  worksheet.getCell("J6").value = `Net Balance: PHP ${net.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  applySummaryCell(worksheet.getCell("J6"), net >= 0 ? COLORS.lightGreen : COLORS.lightRed);

  const headerRow = worksheet.getRow(8);
  headerRow.values = [
    "Transaction ID",
    "Date",
    "Category",
    "Account Type",
    "Direction",
    "Description",
    "Reference No.",
    "Customer",
    "Project",
    "Price",
    "Qty",
    "Discount",
    "Amount",
    "Import Source",
    "Import Batch",
    "Created By",
    "Created At",
    "Notes"
  ];
  styleHeaderRow(headerRow);

  if (!transactions.length) {
    worksheet.mergeCells("A9:R9");
    worksheet.getCell("A9").value = "No financial raw logs match the selected filters.";
    worksheet.getCell("A9").font = { italic: true, color: { argb: COLORS.muted } };
    worksheet.getCell("A9").alignment = { horizontal: "center", vertical: "middle" };
    applyBorder(worksheet.getCell("A9"));
  }

  transactions.forEach((tx, index) => {
    const rowNumber = 9 + index;
    const row = worksheet.getRow(rowNumber);
    row.values = [
      tx.id,
      null,
      cleanText(tx.account_name),
      accountTypeLabel(tx.account_type),
      directionLabel(tx.type),
      cleanText(tx.description),
      cleanText(tx.reference_no),
      cleanText(tx.customer_name),
      cleanText(tx.project_name),
      tx.price == null ? null : toNumber(tx.price, 0),
      tx.quantity == null ? null : toNumber(tx.quantity, 0),
      tx.discount == null ? null : toNumber(tx.discount, 0),
      toNumber(tx.amount, 0),
      cleanText(tx.import_source_name),
      cleanText(tx.import_batch_id),
      cleanText(tx.created_by_name),
      null,
      cleanText(tx.notes)
    ];

    setCellDate(worksheet.getCell(rowNumber, 2), tx.transaction_date);
    setCellDate(worksheet.getCell(rowNumber, 17), tx.created_at, "yyyy-mm-dd hh:mm");
    worksheet.getCell(rowNumber, 10).numFmt = '"PHP "#,##0.00';
    worksheet.getCell(rowNumber, 11).numFmt = "#,##0.####";
    worksheet.getCell(rowNumber, 12).numFmt = '"PHP "#,##0.00';
    worksheet.getCell(rowNumber, 13).numFmt = '"PHP "#,##0.00';
    worksheet.getCell(rowNumber, 10).alignment = moneyStyle().alignment;
    worksheet.getCell(rowNumber, 12).alignment = moneyStyle().alignment;
    worksheet.getCell(rowNumber, 13).alignment = moneyStyle().alignment;
    styleBodyRow(row, index);
  });

  worksheet.autoFilter = {
    from: { row: 8, column: 1 },
    to: { row: Math.max(8, 8 + transactions.length), column: 18 }
  };
  worksheet.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0
  };

  return workbook.xlsx.writeBuffer();
}

module.exports = {
  buildBudgetRawLogsWorkbook
};
