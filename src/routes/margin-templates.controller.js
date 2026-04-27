const pool = require("../config/db");
const { describeAuditChange, formatAuditValue, getRequestIp, safeLogAudit } = require("../services/audit");

function normalizeRate(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function toStoredRate(value) {
  return Math.max(0, normalizeRate(value, 0));
}

function mapMarginRow(row) {
  return {
    id: Number(row.id),
    name: String(row.name || ""),
    inverterMargin: Number(row.inverter_margin || 0),
    panelMargin: Number(row.panel_margin || 0),
    batteryMargin: Number(row.battery_margin || 0),
    safetyMargin: Number(row.safety_margin || 0),
    mountingMargin: Number(row.mounting_margin || 0),
    installationMargin: Number(row.installation_margin || 0),
    isActive: Number(row.is_active) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function fetchMarginTemplate(id) {
  const [rows] = await pool.query("SELECT * FROM margin_templates WHERE id=? LIMIT 1", [id]);
  return rows[0] || null;
}

exports.list = async (req, res) => {
  const activeOnly = String(req.query.activeOnly || "1") !== "0";
  const params = [];
  const where = [];

  if (activeOnly) where.push("is_active = 1");

  const [rows] = await pool.query(
    `SELECT * FROM margin_templates
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY name ASC`,
    params
  );

  return res.json(rows.map(mapMarginRow));
};

exports.create = async (req, res) => {
  const name = String(req.body.name || "").trim();
  const inverterMargin = toStoredRate(req.body.inverterMargin);
  const panelMargin = toStoredRate(req.body.panelMargin);
  const batteryMargin = toStoredRate(req.body.batteryMargin);
  const safetyMargin = toStoredRate(req.body.safetyMargin);
  const mountingMargin = toStoredRate(req.body.mountingMargin);
  const installationMargin = toStoredRate(req.body.installationMargin);
  const isActive = req.body.isActive === false ? 0 : 1;

  if (!name) return res.status(400).json({ message: "Template name is required" });

  const [existing] = await pool.query("SELECT id FROM margin_templates WHERE LOWER(name)=LOWER(?) LIMIT 1", [name]);
  if (existing.length) {
    return res.status(400).json({ message: "Margin template name already exists" });
  }

  const [result] = await pool.query(
    `INSERT INTO margin_templates(
      name, inverter_margin, panel_margin, battery_margin, safety_margin, mounting_margin, installation_margin, is_active
    ) VALUES (?,?,?,?,?,?,?,?)`,
    [name, inverterMargin, panelMargin, batteryMargin, safetyMargin, mountingMargin, installationMargin, isActive]
  );

  const created = await fetchMarginTemplate(result.insertId);
  if (created) {
    await safeLogAudit({
      userId: req.user.id,
      actorName: req.user.name,
      module: "MARGINS",
      action: "MARGIN_TEMPLATE_CREATED",
      details: `${created.name} created. Inverter ${formatAuditValue(created.inverter_margin)}, Panel ${formatAuditValue(created.panel_margin)}, Battery ${formatAuditValue(created.battery_margin)}, Safety ${formatAuditValue(created.safety_margin)}, Mounting ${formatAuditValue(created.mounting_margin)}, Installation ${formatAuditValue(created.installation_margin)}.`,
      ipAddress: getRequestIp(req)
    });
  }

  return res.status(201).json(mapMarginRow(created));
};

exports.update = async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid id" });

  const existing = await fetchMarginTemplate(id);
  if (!existing) return res.status(404).json({ message: "Margin template not found" });

  const name = Object.prototype.hasOwnProperty.call(req.body, "name")
    ? String(req.body.name || "").trim()
    : String(existing.name || "");
  const inverterMargin = Object.prototype.hasOwnProperty.call(req.body, "inverterMargin")
    ? toStoredRate(req.body.inverterMargin)
    : Number(existing.inverter_margin || 0);
  const panelMargin = Object.prototype.hasOwnProperty.call(req.body, "panelMargin")
    ? toStoredRate(req.body.panelMargin)
    : Number(existing.panel_margin || 0);
  const batteryMargin = Object.prototype.hasOwnProperty.call(req.body, "batteryMargin")
    ? toStoredRate(req.body.batteryMargin)
    : Number(existing.battery_margin || 0);
  const safetyMargin = Object.prototype.hasOwnProperty.call(req.body, "safetyMargin")
    ? toStoredRate(req.body.safetyMargin)
    : Number(existing.safety_margin || 0);
  const mountingMargin = Object.prototype.hasOwnProperty.call(req.body, "mountingMargin")
    ? toStoredRate(req.body.mountingMargin)
    : Number(existing.mounting_margin || 0);
  const installationMargin = Object.prototype.hasOwnProperty.call(req.body, "installationMargin")
    ? toStoredRate(req.body.installationMargin)
    : Number(existing.installation_margin || 0);
  const isActive = Object.prototype.hasOwnProperty.call(req.body, "isActive")
    ? (req.body.isActive ? 1 : 0)
    : Number(existing.is_active) === 1 ? 1 : 0;

  if (!name) return res.status(400).json({ message: "Template name is required" });

  const [dupe] = await pool.query(
    "SELECT id FROM margin_templates WHERE LOWER(name)=LOWER(?) AND id<>? LIMIT 1",
    [name, id]
  );
  if (dupe.length) {
    return res.status(400).json({ message: "Margin template name already exists" });
  }

  await pool.query(
    `UPDATE margin_templates
     SET name=?, inverter_margin=?, panel_margin=?, battery_margin=?, safety_margin=?, mounting_margin=?, installation_margin=?, is_active=?
     WHERE id=?`,
    [name, inverterMargin, panelMargin, batteryMargin, safetyMargin, mountingMargin, installationMargin, isActive, id]
  );

  const updated = await fetchMarginTemplate(id);
  const changes = [
    describeAuditChange("Name", existing.name, updated.name),
    describeAuditChange("Inverter margin", existing.inverter_margin, updated.inverter_margin),
    describeAuditChange("Panel margin", existing.panel_margin, updated.panel_margin),
    describeAuditChange("Battery margin", existing.battery_margin, updated.battery_margin),
    describeAuditChange("Safety margin", existing.safety_margin, updated.safety_margin),
    describeAuditChange("Mounting margin", existing.mounting_margin, updated.mounting_margin),
    describeAuditChange("Installation margin", existing.installation_margin, updated.installation_margin),
    describeAuditChange("Status", Number(existing.is_active) === 1 ? "active" : "inactive", Number(updated.is_active) === 1 ? "active" : "inactive")
  ].filter(Boolean);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "MARGINS",
    action: "MARGIN_TEMPLATE_UPDATED",
    details: changes.length
      ? `${updated.name} updated. ${changes.join("; ")}.`
      : `${updated.name} saved with no changes.`,
    ipAddress: getRequestIp(req)
  });

  return res.json(mapMarginRow(updated));
};

exports.remove = async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid id" });

  const existing = await fetchMarginTemplate(id);
  if (!existing) return res.status(404).json({ message: "Margin template not found" });

  await pool.query("DELETE FROM margin_templates WHERE id=?", [id]);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "MARGINS",
    action: "MARGIN_TEMPLATE_DELETED",
    details: `${existing.name} deleted.`,
    ipAddress: getRequestIp(req)
  });

  return res.json({ success: true });
};
