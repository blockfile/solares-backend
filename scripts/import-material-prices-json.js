require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const pool = require("../src/config/db");
const { normalizeMaterialName } = require("../src/services/materialCatalog");

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
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
  if (t.includes("mccb")) {
    return "mccb";
  }
  if (t.includes("mcb") || t.includes("breaker")) {
    return "mcb";
  }
  if (t.includes("ats") || t.includes("mts")) {
    return "ats_mts";
  }
  if (t.includes("spd")) {
    return "spd";
  }
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

  // Fallback to wire detection so these won't remain in main.
  if (t.includes("wire") || t.includes("cable")) return "pv";

  return "other";
}

function inferBrand(materialName, section) {
  const t = normalizeText(`${materialName} ${section}`);

  if (t.includes("deye") || /\bsun-\d/i.test(materialName)) return "deye";
  if (t.includes("solis") || /\bs[56]-[a-z0-9-]+/i.test(materialName)) return "solis";
  if (t.includes("snre") || /\bsr-[a-z0-9-]+/i.test(materialName)) return "snre";
  if (t.includes("menred") || t.includes("mendred")) return "menred";
  if (t.includes("feeo")) return "feeo";
  if (t.includes("taixi")) return "taixi";
  if (t.includes("sunree")) return "sunree";
  return null;
}

function isPreferredEnclosure(materialName, section) {
  const name = normalizeText(materialName);
  const sec = normalizeText(section);
  if (name.includes("ip65")) return true;
  if (name.includes("breaker box")) return true;
  if (name.includes("outdoor")) return true;
  if (name.includes("metal enclosure")) return true;
  if (sec.includes("box (outdoor)")) return true;
  if (sec.includes("metal enclosure")) return true;
  return false;
}

function shouldKeepPreferredOnly(materialName, section, subgroup) {
  const brand = inferBrand(materialName, section);
  const sg = String(subgroup || "").toLowerCase();

  if (sg === "inverter") return brand === "deye" || brand === "solis";
  if (sg === "battery") return brand === "snre" || brand === "menred";
  if (["mcb", "mccb", "spd", "ats_mts", "protection"].includes(sg)) {
    return brand === "feeo" || brand === "taixi" || brand === "sunree";
  }
  if (sg === "enclosure") return isPreferredEnclosure(materialName, section);

  return true;
}

async function run() {
  const args = process.argv.slice(2);
  const jsonPath = args.find((x) => !x.startsWith("--"));
  const shouldReplace = args.includes("--replace");
  const preferredOnly = args.includes("--preferred-only");

  if (!jsonPath) {
    console.error(
      "Usage: node scripts/import-material-prices-json.js <materials.json> [--replace] [--preferred-only]"
    );
    process.exit(1);
  }

  const fullPath = path.resolve(jsonPath);
  if (!fs.existsSync(fullPath)) {
    console.error("File not found:", fullPath);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  const items = Array.isArray(raw) ? raw : [];
  if (!items.length) {
    console.error("No materials found in JSON.");
    process.exit(1);
  }

  const [existingRows] = await pool.query("SELECT id, normalized_name FROM material_prices");
  const existingSet = new Set(existingRows.map((x) => x.normalized_name));

  if (shouldReplace) {
    await pool.query("TRUNCATE TABLE material_prices");
    existingSet.clear();
  }

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let filteredOut = 0;

  for (const row of items) {
    const materialName = String(row.materialName || "").trim();
    const normalizedName = normalizeMaterialName(materialName);
    const unit = String(row.unit || "").trim() || null;
    const basePrice = Math.max(0, toNumber(row.basePrice, 0));
    const sourceSection = String(row.section || "").trim() || null;
    const subgroup = inferSubgroup(materialName, sourceSection);
    const category = inferCategory(materialName, sourceSection);

    if (!normalizedName || !materialName || basePrice <= 0) {
      skipped += 1;
      continue;
    }

    if (preferredOnly && !shouldKeepPreferredOnly(materialName, sourceSection, subgroup)) {
      filteredOut += 1;
      continue;
    }

    const existed = existingSet.has(normalizedName);

    await pool.query(
      `INSERT INTO material_prices(material_name, normalized_name, unit, base_price, category, subgroup, source_section)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         material_name=VALUES(material_name),
         unit=VALUES(unit),
         base_price=VALUES(base_price),
         category=VALUES(category),
         subgroup=VALUES(subgroup),
         source_section=VALUES(source_section),
         updated_at=CURRENT_TIMESTAMP`,
      [materialName, normalizedName, unit, basePrice, category, subgroup, sourceSection]
    );

    if (existed) {
      updated += 1;
    } else {
      inserted += 1;
      existingSet.add(normalizedName);
    }
  }

  const [countRows] = await pool.query("SELECT COUNT(*) AS c FROM material_prices");
  const total = Number(countRows?.[0]?.c || 0);

  console.log(
    JSON.stringify(
      {
        source: fullPath,
        replace: shouldReplace,
        preferredOnly,
        inserted,
        updated,
        skipped,
        filteredOut,
        total
      },
      null,
      2
    )
  );

  await pool.end();
}

run().catch(async (err) => {
  console.error(err.message || err);
  try {
    await pool.end();
  } catch {}
  process.exit(1);
});
