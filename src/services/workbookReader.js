const path = require("path");
const ExcelJS = require("exceljs");

function cellValueToPlain(value) {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value !== "object") return value;

  if (Object.prototype.hasOwnProperty.call(value, "result")) {
    return cellValueToPlain(value.result);
  }
  if (Array.isArray(value.richText)) {
    return value.richText.map((part) => part?.text || "").join("");
  }
  if (Object.prototype.hasOwnProperty.call(value, "text")) {
    return value.text;
  }
  if (Object.prototype.hasOwnProperty.call(value, "hyperlink")) {
    return value.hyperlink;
  }
  if (Object.prototype.hasOwnProperty.call(value, "formula")) {
    return value.formula;
  }

  return String(value);
}

function worksheetToRows(worksheet) {
  const rows = [];
  const maxRow = worksheet.rowCount || 0;

  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values = [];
    const maxCell = row.cellCount || row.actualCellCount || 0;

    for (let columnNumber = 1; columnNumber <= maxCell; columnNumber += 1) {
      values.push(cellValueToPlain(row.getCell(columnNumber).value));
    }

    while (values.length && (values[values.length - 1] == null || values[values.length - 1] === "")) {
      values.pop();
    }
    rows.push(values);
  }

  return rows;
}

async function readWorkbookRows(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  const workbook = new ExcelJS.Workbook();

  if (ext === ".csv") {
    const worksheet = await workbook.csv.readFile(filePath);
    return [{ name: worksheet.name || "CSV", rows: worksheetToRows(worksheet) }];
  }

  if (ext !== ".xlsx") {
    throw new Error("Only .xlsx and .csv workbook files are supported.");
  }

  await workbook.xlsx.readFile(filePath);
  return workbook.worksheets.map((worksheet) => ({
    name: worksheet.name,
    rows: worksheetToRows(worksheet)
  }));
}

function excelSerialToDate(value) {
  const serial = Number(value);
  if (!Number.isFinite(serial)) return null;

  const wholeDays = Math.floor(serial);
  const milliseconds = Math.round((serial - wholeDays) * 24 * 60 * 60 * 1000);
  return new Date(Date.UTC(1899, 11, 30 + wholeDays, 0, 0, 0, milliseconds));
}

module.exports = {
  excelSerialToDate,
  readWorkbookRows
};
