const pool = require("../config/db");
const { normalizeMaterialName } = require("../services/materialCatalog");
const { describeAuditChange, formatAuditValue, getRequestIp, safeLogAudit } = require("../services/audit");

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isDuplicateEntryError(error) {
  return error?.code === "ER_DUP_ENTRY";
}

async function getMaterialByNormalizedName(normalizedName) {
  const [rows] = await pool.query(
    "SELECT * FROM material_prices WHERE normalized_name=? LIMIT 1",
    [normalizedName]
  );
  return rows[0] || null;
}

exports.list = async (req, res) => {
  const q = String(req.query.q || "").trim();
  const category = String(req.query.category || "").trim();
  const where = [];
  const params = [];

  if (q) {
    const like = `%${q}%`;
    where.push("(material_name LIKE ? OR normalized_name LIKE ?)");
    params.push(like, like);
  }

  if (category) {
    where.push("category = ?");
    params.push(category);
  }

  const sql = `SELECT * FROM material_prices ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY category ASC, subgroup ASC, material_name ASC`;
  const [rows] = await pool.query(sql, params);
  return res.json(rows);
};

exports.create = async (req, res) => {
  const materialName = String(req.body.materialName || "").trim();
  const unit = String(req.body.unit || "").trim();
  const basePrice = Math.max(0, toNumber(req.body.basePrice, 0));
  const category = String(req.body.category || "").trim().toLowerCase() || "other";
  const subgroup = String(req.body.subgroup || "").trim() || null;
  const sourceSection = String(req.body.sourceSection || "").trim() || null;

  if (!materialName) return res.status(400).json({ message: "materialName is required" });

  const normalizedName = normalizeMaterialName(materialName);
  if (!normalizedName) return res.status(400).json({ message: "Invalid materialName" });

  const existing = await getMaterialByNormalizedName(normalizedName);
  if (existing) {
    return res.status(409).json({
      message: `Material already exists in the catalog as "${existing.material_name}".`,
      existing
    });
  }

  try {
    await pool.query(
      `INSERT INTO material_prices(material_name, normalized_name, unit, base_price, category, subgroup, source_section)
       VALUES (?,?,?,?,?,?,?)`,
      [materialName, normalizedName, unit || null, basePrice, category, subgroup, sourceSection]
    );
  } catch (error) {
    if (!isDuplicateEntryError(error)) throw error;

    const duplicate = await getMaterialByNormalizedName(normalizedName);
    return res.status(409).json({
      message: duplicate
        ? `Material already exists in the catalog as "${duplicate.material_name}".`
        : "Material already exists in the catalog.",
      existing: duplicate
    });
  }

  const created = await getMaterialByNormalizedName(normalizedName);
  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "MATERIALS",
    action: "MATERIAL_CREATED",
    details: `${created.material_name} created. Category: ${formatAuditValue(created.category)}. Base price: ${formatAuditValue(created.base_price)}. Unit: ${formatAuditValue(created.unit)}.`,
    ipAddress: getRequestIp(req)
  });
  return res.status(201).json(created);
};

exports.update = async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid id" });

  const [existingRows] = await pool.query("SELECT * FROM material_prices WHERE id=? LIMIT 1", [id]);
  if (!existingRows.length) return res.status(404).json({ message: "Material not found" });
  const existing = existingRows[0];

  const materialName = String(req.body.materialName || "").trim();
  const unit = String(req.body.unit || "").trim();
  const basePrice = Math.max(0, toNumber(req.body.basePrice, 0));
  const category =
    Object.prototype.hasOwnProperty.call(req.body, "category")
      ? String(req.body.category || "").trim().toLowerCase() || "other"
      : String(existing.category || "other");
  const subgroup =
    Object.prototype.hasOwnProperty.call(req.body, "subgroup")
      ? String(req.body.subgroup || "").trim() || null
      : existing.subgroup;
  const sourceSection =
    Object.prototype.hasOwnProperty.call(req.body, "sourceSection")
      ? String(req.body.sourceSection || "").trim() || null
      : existing.source_section;

  if (!materialName) return res.status(400).json({ message: "materialName is required" });

  const normalizedName = normalizeMaterialName(materialName);
  const duplicate = await getMaterialByNormalizedName(normalizedName);
  if (duplicate && Number(duplicate.id) !== id) {
    return res.status(409).json({
      message: `Another material already uses this name: "${duplicate.material_name}".`,
      existing: duplicate
    });
  }

  try {
    await pool.query(
      `UPDATE material_prices
       SET material_name=?, normalized_name=?, unit=?, base_price=?, category=?, subgroup=?, source_section=?
       WHERE id=?`,
      [materialName, normalizedName, unit || null, basePrice, category, subgroup, sourceSection, id]
    );
  } catch (error) {
    if (!isDuplicateEntryError(error)) throw error;

    const existingDuplicate = await getMaterialByNormalizedName(normalizedName);
    return res.status(409).json({
      message: existingDuplicate
        ? `Another material already uses this name: "${existingDuplicate.material_name}".`
        : "Another material already uses this name.",
      existing: existingDuplicate
    });
  }

  const [rows] = await pool.query("SELECT * FROM material_prices WHERE id=? LIMIT 1", [id]);
  const updated = rows[0];

  const changes = [
    describeAuditChange("Name", existing.material_name, updated.material_name),
    describeAuditChange("Unit", existing.unit, updated.unit),
    describeAuditChange("Base price", existing.base_price, updated.base_price),
    describeAuditChange("Category", existing.category, updated.category),
    describeAuditChange("Subgroup", existing.subgroup, updated.subgroup),
    describeAuditChange("Source section", existing.source_section, updated.source_section)
  ].filter(Boolean);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "MATERIALS",
    action: "MATERIAL_UPDATED",
    details: changes.length
      ? `${updated.material_name} updated. ${changes.join("; ")}.`
      : `${updated.material_name} was saved with no material field changes.`,
    ipAddress: getRequestIp(req)
  });

  return res.json(updated);
};

exports.remove = async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid id" });

  const [rows] = await pool.query("SELECT * FROM material_prices WHERE id=? LIMIT 1", [id]);
  await pool.query("DELETE FROM material_prices WHERE id=?", [id]);

  if (rows.length) {
    await safeLogAudit({
      userId: req.user.id,
      actorName: req.user.name,
      module: "MATERIALS",
      action: "MATERIAL_DELETED",
      details: `${rows[0].material_name} deleted. Category: ${formatAuditValue(rows[0].category)}. Base price: ${formatAuditValue(rows[0].base_price)}.`,
      ipAddress: getRequestIp(req)
    });
  }

  return res.json({ success: true });
};
