const pool = require("../config/db");
const { describeAuditChange, formatAuditValue, getRequestIp, safeLogAudit } = require("../services/audit");

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .trim();
}

async function fetchPackagePrice(id) {
  const [rows] = await pool.query(
    `SELECT pp.*, qt.name AS template_name
     FROM package_prices pp
     JOIN quote_templates qt ON qt.id = pp.template_id
     WHERE pp.id=? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

exports.list = async (req, res) => {
  const templateId = Number(req.query.templateId || 0);
  const activeOnly = String(req.query.activeOnly || "1") !== "0";

  const where = [];
  const params = [];

  if (templateId > 0) {
    where.push("pp.template_id = ?");
    params.push(templateId);
  }

  if (activeOnly) {
    where.push("pp.is_active = 1");
  }

  const [rows] = await pool.query(
    `SELECT pp.*, qt.name AS template_name
     FROM package_prices pp
     JOIN quote_templates qt ON qt.id = pp.template_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY qt.name ASC, pp.scenario_label ASC`,
    params
  );

  return res.json(rows);
};

exports.create = async (req, res) => {
  const templateId = Number(req.body.templateId || 0);
  const scenarioLabel = String(req.body.scenarioLabel || "").trim();
  const scenarioKeyInput = String(req.body.scenarioKey || "").trim();
  const scenarioKey = slugify(scenarioKeyInput || scenarioLabel);
  const packagePrice = Math.max(0, toNumber(req.body.packagePrice, 0));
  const isActive = req.body.isActive === false ? 0 : 1;

  if (!templateId) return res.status(400).json({ message: "templateId is required" });
  if (!scenarioLabel) return res.status(400).json({ message: "scenarioLabel is required" });
  if (!scenarioKey) return res.status(400).json({ message: "Invalid scenarioLabel/scenarioKey" });

  const [tpl] = await pool.query("SELECT id FROM quote_templates WHERE id=? LIMIT 1", [templateId]);
  if (!tpl.length) return res.status(404).json({ message: "Template not found" });

  const [result] = await pool.query(
    `INSERT INTO package_prices(template_id, scenario_key, scenario_label, package_price, is_active)
     VALUES (?,?,?,?,?)`,
    [templateId, scenarioKey, scenarioLabel, packagePrice, isActive]
  );

  const created = await fetchPackagePrice(result.insertId);
  if (created) {
    await safeLogAudit({
      userId: req.user.id,
      actorName: req.user.name,
      module: "PACKAGES",
      action: "PACKAGE_PRICE_CREATED",
      details: `${created.scenario_label} created for ${created.template_name}. Package price: ${formatAuditValue(created.package_price)}. Status: ${Number(created.is_active) === 1 ? "active" : "inactive"}.`,
      ipAddress: getRequestIp(req)
    });
  }

  return res.status(201).json(created);
};

exports.update = async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid id" });

  const existing = await fetchPackagePrice(id);
  if (!existing) return res.status(404).json({ message: "Package price not found" });

  const templateId = Number(req.body.templateId || existing.template_id || 0);
  const scenarioLabel =
    Object.prototype.hasOwnProperty.call(req.body, "scenarioLabel")
      ? String(req.body.scenarioLabel || "").trim()
      : String(existing.scenario_label || "");
  const scenarioKeyRaw =
    Object.prototype.hasOwnProperty.call(req.body, "scenarioKey")
      ? String(req.body.scenarioKey || "").trim()
      : String(existing.scenario_key || "");
  const scenarioKey = slugify(scenarioKeyRaw || scenarioLabel);

  const packagePrice =
    Object.prototype.hasOwnProperty.call(req.body, "packagePrice")
      ? Math.max(0, toNumber(req.body.packagePrice, 0))
      : Math.max(0, toNumber(existing.package_price, 0));

  const isActive =
    Object.prototype.hasOwnProperty.call(req.body, "isActive")
      ? req.body.isActive
        ? 1
        : 0
      : Number(existing.is_active) === 1
        ? 1
        : 0;

  if (!templateId) return res.status(400).json({ message: "templateId is required" });
  if (!scenarioLabel) return res.status(400).json({ message: "scenarioLabel is required" });
  if (!scenarioKey) return res.status(400).json({ message: "Invalid scenarioLabel/scenarioKey" });

  await pool.query(
    `UPDATE package_prices
     SET template_id=?, scenario_key=?, scenario_label=?, package_price=?, is_active=?
     WHERE id=?`,
    [templateId, scenarioKey, scenarioLabel, packagePrice, isActive, id]
  );

  const updated = await fetchPackagePrice(id);
  const changes = [
    describeAuditChange("Template", existing.template_name, updated.template_name),
    describeAuditChange("Scenario label", existing.scenario_label, updated.scenario_label),
    describeAuditChange("Scenario key", existing.scenario_key, updated.scenario_key),
    describeAuditChange("Package price", existing.package_price, updated.package_price),
    describeAuditChange("Status", Number(existing.is_active) === 1 ? "active" : "inactive", Number(updated.is_active) === 1 ? "active" : "inactive")
  ].filter(Boolean);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "PACKAGES",
    action: "PACKAGE_PRICE_UPDATED",
    details: changes.length
      ? `${updated.scenario_label} updated for ${updated.template_name}. ${changes.join("; ")}.`
      : `${updated.scenario_label} was saved with no package price changes.`,
    ipAddress: getRequestIp(req)
  });

  return res.json(updated);
};

exports.remove = async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid id" });

  const existing = await fetchPackagePrice(id);
  await pool.query("DELETE FROM package_prices WHERE id=?", [id]);

  if (existing) {
    await safeLogAudit({
      userId: req.user.id,
      actorName: req.user.name,
      module: "PACKAGES",
      action: "PACKAGE_PRICE_DELETED",
      details: `${existing.scenario_label} deleted from ${existing.template_name}. Package price: ${formatAuditValue(existing.package_price)}.`,
      ipAddress: getRequestIp(req)
    });
  }

  return res.json({ success: true });
};
