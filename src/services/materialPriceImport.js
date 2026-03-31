const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const XLSX = require("xlsx");
const { normalizeMaterialName } = require("./materialCatalog");

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseLooseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const text = String(value || "").trim();
  if (!text) return null;
  const cleaned = text.replace(/[^0-9,./-]/g, "");
  if (!cleaned) return null;

  if (/^\d+pcs?\/p\d[\d,]*(?:\.\d+)?$/i.test(cleaned)) {
    const match = cleaned.match(/p(\d[\d,]*(?:\.\d+)?)$/i);
    if (!match) return null;
    const price = Number(match[1].replace(/,/g, ""));
    return Number.isFinite(price) ? price : null;
  }

  if (/^\d[\d,]*(?:\.\d+)?\/[a-z]+$/i.test(cleaned)) {
    const match = cleaned.match(/^(\d[\d,]*(?:\.\d+)?)/i);
    if (!match) return null;
    const price = Number(match[1].replace(/,/g, ""));
    return Number.isFinite(price) ? price : null;
  }

  if (!/^-?[\d,.]+$/.test(cleaned)) return null;
  const price = Number(cleaned.replace(/,/g, ""));
  return Number.isFinite(price) ? price : null;
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeSupplierName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferSubgroup(materialName, section) {
  const t = normalizeText(`${materialName} ${section}`);

  if (t.includes("battery") || t.includes("ah") || t.includes("lifepo") || t.includes("lipo4")) {
    return "battery";
  }
  if (
    t.includes("inverter") ||
    t.includes("deye") ||
    t.includes("solis") ||
    t.includes("sofar") ||
    t.includes("srne") ||
    t.includes("snat") ||
    t.includes("goodwe")
  ) {
    return "inverter";
  }
  if (t.includes("solar panel") || t.includes(" mono ") || /\b\d{3,4}\s*w\b/.test(t)) {
    return "panel";
  }
  if (t.includes("mccb")) return "mccb";
  if (t.includes("mcb") || t.includes("breaker")) return "mcb";
  if (t.includes("ats") || t.includes("mts")) return "ats_mts";
  if (t.includes("spd")) return "spd";
  if (
    t.includes("rail") ||
    t.includes("clamp") ||
    t.includes("l foot") ||
    t.includes("lfoot") ||
    t.includes("splice kit") ||
    t.includes("roof bracket") ||
    t.includes("grounding lug")
  ) {
    return "mounting";
  }
  if (t.includes("fuse") || t.includes("isolator")) return "protection";
  if (t.includes("mc4") || t.includes("connector") || t.includes("pg") || t.includes("gland")) {
    return "connector";
  }
  if (t.includes("box") || t.includes("enclosure") || t.includes("junction")) {
    return "enclosure";
  }
  if (
    t.includes("conduit") ||
    t.includes("hdpe") ||
    t.includes("pipe") ||
    t.includes("clip") ||
    t.includes("shrink")
  ) {
    return "cable_support";
  }
  if (
    t.includes("wire") ||
    t.includes("cable") ||
    t.includes("single core") ||
    t.includes("thwn") ||
    t.includes("awg")
  ) {
    return "cable";
  }

  return "accessory";
}

function inferCategory(materialName, section) {
  const t = normalizeText(`${materialName} ${section}`);

  if (t.includes("mounting accessories") || t.includes("mounting kit")) return "mounting";

  if (
    t.includes("pv cable") ||
    t.includes("pipe cables") ||
    t.includes("shrinking tube") ||
    t.includes("single core") ||
    t.includes("hdpe") ||
    t.includes("conduit") ||
    t.includes("ground wire")
  ) {
    return "pv";
  }

  if (
    t.includes("battery cable") ||
    t.includes("battery cables") ||
    t.includes("ac input") ||
    t.includes("ac output") ||
    t.includes("thwn") ||
    t.includes("ferrules") ||
    t.includes("breaker") ||
    t.includes("mcb") ||
    t.includes("mccb") ||
    t.includes("spd") ||
    t.includes("ats") ||
    t.includes("mts")
  ) {
    return "battery_ac";
  }

  if (
    t.includes("inverter") ||
    t.includes("solar panel") ||
    t.includes("battery") ||
    t.includes("lifepo") ||
    t.includes("lipo4")
  ) {
    return "main";
  }

  if (t.includes("wire") || t.includes("cable")) return "pv";
  return "other";
}

function detectFileType(filePath, mimeType = "") {
  const ext = String(path.extname(filePath || "")).toLowerCase();
  const type = String(mimeType || "").toLowerCase();

  if (ext === ".pdf" || type.includes("pdf")) return "pdf";
  if ([".xlsx", ".xls", ".csv"].includes(ext)) return "excel";
  if (ext === ".json" || type.includes("json")) return "json";
  return "unknown";
}

function mapUnit(value) {
  const unit = String(value || "").trim().toLowerCase();
  if (!unit) return null;
  if (unit === "pcs" || unit === "pc") return "pc/s";
  if (unit === "meter") return "m";
  return unit;
}

function parsePriceToken(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? { price: value, unit: null } : null;
  }

  const text = String(value || "").trim();
  if (!text) return null;

  const pack = text.match(/(\d+)pcs?\/p(\d[\d,]*(?:\.\d+)?)/i);
  if (pack) {
    return {
      price: Number(pack[2].replace(/,/g, "")),
      unit: "pack"
    };
  }

  const unitPrice = text.match(/(\d[\d,]*(?:\.\d+)?)\/([a-z]+)/i);
  if (unitPrice) {
    return {
      price: Number(unitPrice[1].replace(/,/g, "")),
      unit: mapUnit(unitPrice[2])
    };
  }

  const loose = parseLooseNumber(text);
  if (loose != null && loose > 0) {
    return { price: loose, unit: null };
  }

  return null;
}

function cellToText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return Number.isInteger(value) ? String(value) : String(value);
  }
  return String(value).trim();
}

function normalizeHeader(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, " ").trim();
}

function isLikelySectionRow(values) {
  const cells = values.map(cellToText).filter(Boolean);
  if (!cells.length || cells.length > 3) return false;
  if (cells.some((cell) => parseLooseNumber(cell) != null)) return false;
  const joined = cells.join(" ").trim();
  if (!joined) return false;
  if (joined.length > 80) return false;
  return true;
}

function isUnitLike(value) {
  const text = normalizeText(value);
  return /^(pc|pcs|pc\/s|set|roll|m|meter|meters|pack|box|pair|job|lot)$/i.test(text);
}

function findHeaderRow(data) {
  let best = null;

  for (let index = 0; index < Math.min(data.length, 20); index += 1) {
    const row = data[index] || [];
    const normalized = row.map(normalizeHeader);
    let nameCol = -1;
    let priceCols = [];
    let unitCol = -1;
    let sectionCol = -1;

    normalized.forEach((cell, cellIndex) => {
      if (nameCol === -1 && /(material|description|product|item name|item description|name)/.test(cell)) {
        nameCol = cellIndex;
      }
      if (/(price|cost|amount|dealer|unit price|unit amount|net)/.test(cell)) {
        priceCols.push(cellIndex);
      }
      if (unitCol === -1 && /(^unit$|u m|uom|measure|packing)/.test(cell)) {
        unitCol = cellIndex;
      }
      if (sectionCol === -1 && /(section|category|group|type)/.test(cell)) {
        sectionCol = cellIndex;
      }
    });

    if (nameCol === -1 || !priceCols.length) continue;

    const score = 10 + priceCols.length + (unitCol !== -1 ? 2 : 0) + (sectionCol !== -1 ? 1 : 0);
    if (!best || score > best.score) {
      best = { index, nameCol, priceCols, unitCol, sectionCol, score };
    }
  }

  return best;
}

function choosePriceColumn(headerInfo, row) {
  if (!headerInfo?.priceCols?.length) return -1;
  let chosen = -1;
  for (const column of headerInfo.priceCols) {
    const parsed = parsePriceToken(row[column]);
    if (parsed && parsed.price > 0) {
      chosen = column;
    }
  }
  return chosen === -1 ? headerInfo.priceCols[headerInfo.priceCols.length - 1] : chosen;
}

function buildImportedRow({ materialName, unit, basePrice, section, metadata }) {
  const cleanName = String(materialName || "").trim();
  const normalizedName = normalizeMaterialName(cleanName);
  const price = Math.max(0, toNumber(basePrice, 0));
  if (!cleanName || !normalizedName || price <= 0) return null;

  const sourceSection = String(section || "").trim() || null;
  return {
    materialName: cleanName,
    normalizedName,
    unit: String(unit || "").trim() || null,
    basePrice: price,
    category: inferCategory(cleanName, sourceSection),
    subgroup: inferSubgroup(cleanName, sourceSection),
    sourceSection,
    metadata: metadata || {}
  };
}

function parseRowsByHeader(data, sheetName) {
  const headerInfo = findHeaderRow(data);
  if (!headerInfo) return [];

  const items = [];
  let currentSection = String(sheetName || "").trim() || null;

  for (let rowIndex = headerInfo.index + 1; rowIndex < data.length; rowIndex += 1) {
    const row = data[rowIndex] || [];
    const nameCell = cellToText(row[headerInfo.nameCol]);
    const sectionCell =
      headerInfo.sectionCol !== -1 ? cellToText(row[headerInfo.sectionCol]) : "";

    if (!nameCell && isLikelySectionRow(row)) {
      currentSection = row.map(cellToText).filter(Boolean).join(" ").trim();
      continue;
    }

    const priceCol = choosePriceColumn(headerInfo, row);
    const parsedPrice = priceCol === -1 ? null : parsePriceToken(row[priceCol]);
    if (!nameCell || !parsedPrice || parsedPrice.price <= 0) continue;

    const unitCell = headerInfo.unitCol !== -1 ? cellToText(row[headerInfo.unitCol]) : "";
    const item = buildImportedRow({
      materialName: nameCell,
      unit: unitCell || parsedPrice.unit || null,
      basePrice: parsedPrice.price,
      section: sectionCell || currentSection,
      metadata: {
        sourceSheet: sheetName || null,
        sourceRow: rowIndex + 1,
        parsedBy: "header"
      }
    });
    if (item) items.push(item);
  }

  return items;
}

function parseRowsGenerically(data, sheetName) {
  const items = [];
  let currentSection = String(sheetName || "").trim() || null;

  for (let rowIndex = 0; rowIndex < data.length; rowIndex += 1) {
    const row = data[rowIndex] || [];
    const textCells = row.map(cellToText);
    const nonEmpty = textCells
      .map((cell, columnIndex) => ({ cell, columnIndex }))
      .filter((entry) => entry.cell);

    if (!nonEmpty.length) continue;

    if (isLikelySectionRow(textCells)) {
      currentSection = nonEmpty.map((entry) => entry.cell).join(" ").trim();
      continue;
    }

    let priceEntry = null;
    for (let idx = nonEmpty.length - 1; idx >= 0; idx -= 1) {
      const parsed = parsePriceToken(nonEmpty[idx].cell);
      if (parsed && parsed.price > 0) {
        priceEntry = {
          columnIndex: nonEmpty[idx].columnIndex,
          price: parsed.price,
          unit: parsed.unit
        };
        break;
      }
    }
    if (!priceEntry) continue;

    const descriptionParts = [];
    let unit = priceEntry.unit || null;

    for (const entry of nonEmpty) {
      if (entry.columnIndex === priceEntry.columnIndex) continue;
      if (entry.columnIndex > priceEntry.columnIndex) continue;

      const parsedNumber = parseLooseNumber(entry.cell);
      if (parsedNumber != null && parsedNumber > 0 && entry.cell.length <= 5) {
        continue;
      }

      if (!unit && isUnitLike(entry.cell)) {
        unit = mapUnit(entry.cell);
        continue;
      }

      descriptionParts.push(entry.cell);
    }

    const materialName = descriptionParts.join(" ").replace(/\s+/g, " ").trim();
    const item = buildImportedRow({
      materialName,
      unit,
      basePrice: priceEntry.price,
      section: currentSection,
      metadata: {
        sourceSheet: sheetName || null,
        sourceRow: rowIndex + 1,
        parsedBy: "generic"
      }
    });
    if (item) items.push(item);
  }

  return items;
}

function mergeImportedRows(rows) {
  const deduped = new Map();

  for (const row of rows) {
    if (!row?.normalizedName) continue;
    const current = deduped.get(row.normalizedName);
    if (!current) {
      deduped.set(row.normalizedName, row);
      continue;
    }

    const currentScore =
      (current.unit ? 2 : 0) +
      (current.sourceSection ? 1 : 0) +
      (current.metadata?.parsedBy === "header" ? 1 : 0);
    const nextScore =
      (row.unit ? 2 : 0) +
      (row.sourceSection ? 1 : 0) +
      (row.metadata?.parsedBy === "header" ? 1 : 0);

    if (nextScore > currentScore || (nextScore === currentScore && row.basePrice >= current.basePrice)) {
      deduped.set(row.normalizedName, row);
    }
  }

  return Array.from(deduped.values());
}

function parseWorkbookPriceList(filePath) {
  const workbook = XLSX.readFile(filePath, { cellFormula: false, raw: true });
  const rows = [];

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;
    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: true, defval: null });
    if (!Array.isArray(data) || !data.length) continue;

    const parsed = parseRowsByHeader(data, sheetName);
    const fallback = parsed.length ? [] : parseRowsGenerically(data, sheetName);
    rows.push(...(parsed.length ? parsed : fallback));
  }

  return mergeImportedRows(rows);
}

function parseJsonPriceList(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];

  return mergeImportedRows(
    items
      .map((row, index) =>
        buildImportedRow({
          materialName: row.materialName || row.description || row.name,
          unit: row.unit || null,
          basePrice: row.basePrice ?? row.price ?? row.amount,
          section: row.section || row.category || null,
          metadata: {
            sourceRow: index + 1,
            parsedBy: "json"
          }
        })
      )
      .filter(Boolean)
  );
}

function execFileAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        const reason = String(stderr || stdout || error.message || "Import command failed").trim();
        reject(new Error(reason));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function parsePdfPriceList(filePath) {
  const pythonBin = process.env.PYTHON_BIN || "python";
  const scriptPath = path.join(__dirname, "../../scripts/extract-price-list-pdf.py");
  const outputPath = path.join(
    os.tmpdir(),
    `supplier-price-list-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );

  try {
    await execFileAsync(pythonBin, [scriptPath, filePath, outputPath], {
      cwd: path.join(__dirname, "../.."),
      maxBuffer: 10 * 1024 * 1024
    });
    return parseJsonPriceList(outputPath);
  } finally {
    try {
      fs.unlinkSync(outputPath);
    } catch {}
  }
}

async function parseMaterialPriceFile({ filePath, mimeType }) {
  const fileType = detectFileType(filePath, mimeType);
  if (fileType === "json") {
    return { fileType, items: parseJsonPriceList(filePath) };
  }
  if (fileType === "excel") {
    return { fileType, items: parseWorkbookPriceList(filePath) };
  }
  if (fileType === "pdf") {
    return { fileType, items: await parsePdfPriceList(filePath) };
  }
  throw new Error("Unsupported price list format. Please upload PDF, Excel, CSV, or JSON.");
}

module.exports = {
  detectFileType,
  inferCategory,
  inferSubgroup,
  normalizeSupplierName,
  parseMaterialPriceFile
};
