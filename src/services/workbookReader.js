const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
const JSZip = require("jszip");

const XLS_BINARY_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

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

function bufferStartsWith(buffer, signature) {
  if (!Buffer.isBuffer(buffer) || buffer.length < signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (buffer[index] !== signature[index]) return false;
  }
  return true;
}

function readFileHeader(filePath, byteCount = 8) {
  let handle;
  try {
    handle = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(byteCount);
    const bytesRead = fs.readSync(handle, buffer, 0, byteCount, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    throw new Error("Could not read the uploaded workbook file.");
  } finally {
    if (handle != null) {
      try {
        fs.closeSync(handle);
      } catch {}
    }
  }
}

function assertReadableXlsx(filePath) {
  const header = readFileHeader(filePath);

  if (bufferStartsWith(header, XLS_BINARY_SIGNATURE)) {
    throw new Error(
      "The uploaded file appears to be an old .xls workbook. Please save it as .xlsx or CSV and upload it again."
    );
  }

  if (header.length < 2 || header[0] !== 0x50 || header[1] !== 0x4b) {
    throw new Error(
      "The uploaded file is not a valid .xlsx workbook. Please export it again as .xlsx or CSV and upload it again."
    );
  }
}

function friendlyWorkbookReadError(error) {
  const message = String(error?.message || "");

  if (/Cannot read properties of undefined \(reading 'sheets'\)/i.test(message)) {
    return new Error(
      "The uploaded .xlsx file could not be read. Please open it in Excel or Google Sheets, export it again as .xlsx or CSV, and upload the new file."
    );
  }

  if (/central directory|corrupt|invalid/i.test(message)) {
    return new Error(
      "The uploaded .xlsx file looks corrupted or incomplete. Please export a fresh .xlsx or CSV file and upload it again."
    );
  }

  return new Error("Could not read the uploaded workbook. Make sure it is a valid .xlsx or CSV file.");
}

function isPrefixedWorkbookError(error) {
  return /Cannot read properties of undefined \(reading 'sheets'\)/i.test(String(error?.message || ""));
}

function normalizeXmlTagPrefixes(text) {
  return String(text || "").replace(/(<\/?)([A-Za-z_][\w.-]*):/g, "$1");
}

async function readPrefixNormalizedXlsx(filePath, originalError) {
  if (!isPrefixedWorkbookError(originalError)) throw originalError;

  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  let changed = false;

  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !/\.(xml|rels)$/i.test(entry.name)) continue;
    const content = await entry.async("string");
    let normalized = normalizeXmlTagPrefixes(content);
    if (/^xl\/worksheets\/sheet\d+[.]xml$/i.test(entry.name)) {
      normalized = normalized
        .replace(/<tableParts\b[\s\S]*?<\/tableParts>/gi, "")
        .replace(/<tableParts\b[^>]*\/>/gi, "");
    }
    if (normalized !== content) {
      zip.file(entry.name, normalized);
      changed = true;
    }
  }

  for (const entry of Object.values(zip.files)) {
    if (/^xl\/tables\//i.test(entry.name)) {
      zip.remove(entry.name);
      changed = true;
    }
  }

  if (!changed) throw originalError;

  const normalizedBuffer = await zip.generateAsync({ type: "nodebuffer" });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(normalizedBuffer);
  return workbook;
}

async function readWorkbookRows(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  let workbook = new ExcelJS.Workbook();

  if (ext === ".csv") {
    let worksheet;
    try {
      worksheet = await workbook.csv.readFile(filePath);
    } catch {
      throw new Error("Could not read the uploaded CSV file. Please export a fresh CSV file and upload it again.");
    }
    return [{ name: worksheet.name || "CSV", rows: worksheetToRows(worksheet) }];
  }

  if (ext !== ".xlsx") {
    throw new Error("Only .xlsx and .csv workbook files are supported.");
  }

  assertReadableXlsx(filePath);

  try {
    await workbook.xlsx.readFile(filePath);
  } catch (error) {
    try {
      workbook = await readPrefixNormalizedXlsx(filePath, error);
    } catch {
      throw friendlyWorkbookReadError(error);
    }
  }

  const worksheets = workbook.worksheets || [];
  if (!worksheets.length) {
    throw new Error("The uploaded workbook does not contain any sheets.");
  }

  return worksheets.map((worksheet) => ({
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
