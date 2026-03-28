const XLSX = require("xlsx");
const pool = require("../config/db");

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumber(value, fallback = 0) {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;

  const text = String(value || "").trim();
  if (!text) return fallback;

  const cleaned = text.replace(/[^0-9.-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : fallback;
}

function mapImportedSectionKey(section) {
  const text = String(section || "").trim().toLowerCase();
  if (text === "main") return "main_system";
  if (text === "mounting") return "mounting_structural";
  if (text === "pv_battery") return "cabling_conduits";
  return "consumables";
}

function findHeader(data, predicates, maxRows = 20) {
  const limit = Math.min(maxRows, data.length);
  for (let r = 0; r < limit; r++) {
    const row = data[r] || [];
    const normalized = row.map(normalize);
    if (predicates.every((p) => normalized.some(p))) return r;
  }
  return -1;
}

function findColumn(row, matcher) {
  const source = row || [];
  for (let i = 0; i < source.length; i++) {
    if (matcher(normalize(source[i]))) return i;
  }
  return -1;
}

function getMarkerValue(data, marker) {
  for (const row of data) {
    if (!row || row.length === 0) continue;
    const hasMarker = row.some((cell) => normalize(cell).includes(marker));
    if (!hasMarker) continue;

    for (let c = row.length - 1; c >= 0; c--) {
      const n = parseNumber(row[c], NaN);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function parseItemsFromSheet(data) {
  const simpleHeaderRow = findHeader(data, [
    (x) => x === "no" || x === "no.",
    (x) => x.includes("description"),
    (x) => x === "qty" || x.includes("qty"),
    (x) => x.includes("unit amount")
  ]);

  const detailedHeaderRow = findHeader(data, [
    (x) => x.includes("item description"),
    (x) => x === "u/m" || x === "unit",
    (x) => x === "qty" || x.includes("qty"),
    (x) => x.includes("unit price")
  ]);

  function parseByHeaderRow(headerRow) {
    if (headerRow === -1) return [];

    const header = data[headerRow] || [];
    const itemNoCol =
      findColumn(header, (x) => x === "no" || x === "no." || x === "item") !== -1
        ? findColumn(header, (x) => x === "no" || x === "no." || x === "item")
        : 0;
    const descCol = findColumn(header, (x) => x.includes("description") || x.includes("item description"));
    const qtyCol = findColumn(header, (x) => x === "qty" || x.includes("qty"));
    const unitCol = findColumn(header, (x) => x === "unit" || x === "u/m");
    const priceCol = findColumn(
      header,
      (x) => x.includes("unit amount") || x.includes("unit price") || x.includes("u.p")
    );

    if (descCol === -1 || qtyCol === -1 || priceCol === -1) return [];

    const items = [];
    let currentSection = "main";

    const isSectionMarker = (text) =>
      text.includes("item description") ||
      text.includes("mounting kit") ||
      text.includes("pv wire and battery cable");

    const resolveSection = (text) => {
      if (text.includes("mounting kit")) return "mounting";
      if (text.includes("pv wire and battery cable")) return "pv_battery";
      if (text.includes("item description")) return "main";
      return currentSection;
    };

    for (let r = headerRow + 1; r < data.length; r++) {
      const row = data[r] || [];
      const rawItemNo = row[itemNoCol];
      const rawDesc = row[descCol];
      const rawQty = row[qtyCol];
      const rawUnit = unitCol === -1 ? null : row[unitCol];
      const rawPrice = row[priceCol];

      const rowText = row.map(normalize).join(" ");
      if (!rowText.trim()) continue;
      currentSection = resolveSection(rowText);
      if (isSectionMarker(rowText)) continue;

      const firstText = normalize(rawItemNo);
      const descText = normalize(rawDesc);

      if (firstText.includes("package price") || firstText.includes("revenue")) {
        break;
      }
      if (descText.includes("package price") || descText.includes("revenue")) break;

      if (
        firstText.includes("total") ||
        firstText.includes("total amount") ||
        descText.includes("total") ||
        descText.includes("total amount")
      ) {
        continue;
      }

      if (!String(rawDesc || "").trim()) continue;

      const parsedItemNo = parseNumber(rawItemNo, items.length + 1);
      const parsedQty = parseNumber(rawQty, 1);
      const parsedUnitPrice = parseNumber(rawPrice, 0);
      if (parsedUnitPrice <= 0 && parsedQty <= 0) continue;

      items.push({
        itemNo: Number.isFinite(parsedItemNo) ? parsedItemNo : items.length + 1,
        description: String(rawDesc).trim(),
        qty: Number.isFinite(parsedQty) ? parsedQty : 1,
        basePrice: Number.isFinite(parsedUnitPrice) ? parsedUnitPrice : 0,
        unit: rawUnit == null ? null : String(rawUnit).trim() || null,
        sectionKey: mapImportedSectionKey(currentSection)
      });
    }

    return items;
  }

  function score(items) {
    if (!items.length) return 0;
    const hasPrice = items.filter((x) => Number(x.basePrice) > 0).length;
    const hasUnit = items.filter((x) => x.unit && String(x.unit).trim().length > 0).length;
    return items.length * 10 + hasPrice * 5 + hasUnit * 3;
  }

  const simpleItems = parseByHeaderRow(simpleHeaderRow);
  const detailedItems = parseByHeaderRow(detailedHeaderRow);

  const chosen = score(detailedItems) > score(simpleItems) ? detailedItems : simpleItems;
  if (!chosen.length) {
    throw new Error("Unable to detect a valid pricing table in the selected sheet.");
  }

  return chosen;
}

exports.importTemplateFromExcel = async ({ filePath, templateName, sheetName }) => {
  const wb = XLSX.readFile(filePath, { cellFormula: true });
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error("Sheet not found: " + sheetName);

  const data = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  const items = parseItemsFromSheet(data);
  if (!items.length) throw new Error("No item rows detected in the selected sheet.");

  const [t] = await pool.query(
    "INSERT INTO quote_templates(name, sheet_name) VALUES (?,?)",
    [templateName, sheetName]
  );
  const templateId = t.insertId;

  for (const it of items) {
    // Detect panel line by keyword "Solar Panel" and try read watt from text
    const lower = it.description.toLowerCase();
    const isPanel = lower.includes("solar panel");
    const wattMatch = it.description.match(/(\d{3,4})\s*w/i);
    const panelWatt = wattMatch ? Number(wattMatch[1]) : null;

    await pool.query(
      `INSERT INTO template_items(template_id,item_no,description,unit,qty,base_price,section_key,is_panel_item,panel_watt)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        templateId,
        it.itemNo,
        it.description,
        it.unit,
        it.qty,
        it.basePrice,
        it.sectionKey,
        isPanel ? 1 : 0,
        panelWatt
      ]
    );
  }

  return {
    success: true,
    templateId,
    imported: items.length,
    sourceTotals: {
      total: getMarkerValue(data, "total"),
      packagePrice: getMarkerValue(data, "package price"),
      revenue: getMarkerValue(data, "revenue")
    }
  };
};
