require("dotenv").config({ quiet: true });
const XLSX = require("xlsx");
const { importTemplateFromExcel } = require("../src/services/excelImport");

function shouldSkipSheet(name) {
  const n = String(name || "").toLowerCase();
  return n.includes("wire sizing");
}

async function run() {
  const filePath = process.argv.slice(2).join(" ").trim() || process.env.COSTING_WORKBOOK_PATH;
  if (!filePath) {
    console.error("Usage: node scripts/import-costing-workbook.js <path-to-xlsx>");
    process.exit(1);
  }

  const wb = XLSX.readFile(filePath, { cellFormula: true });
  const sheetNames = wb.SheetNames.filter((name) => !shouldSkipSheet(name));
  if (!sheetNames.length) {
    console.log("No importable sheets found.");
    return;
  }

  const results = [];
  for (const sheetName of sheetNames) {
    try {
      const res = await importTemplateFromExcel({
        filePath,
        templateName: sheetName,
        sheetName
      });
      results.push({ sheetName, ok: true, templateId: res.templateId, imported: res.imported });
      console.log(`OK  ${sheetName} -> template_id=${res.templateId}, items=${res.imported}`);
    } catch (err) {
      results.push({ sheetName, ok: false, error: err.message || String(err) });
      console.log(`ERR ${sheetName} -> ${err.message || err}`);
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const errCount = results.length - okCount;
  console.log(`Done. success=${okCount}, failed=${errCount}`);
}

run().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
