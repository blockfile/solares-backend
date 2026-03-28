const pool = require("../config/db");

function getRequestIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return forwarded || req.ip || req.socket?.remoteAddress || null;
}

function formatAuditValue(value) {
  if (value == null) return "(blank)";

  if (Array.isArray(value)) {
    const items = value.map((item) => formatAuditValue(item)).filter(Boolean);
    return items.length ? items.join(", ") : "(blank)";
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "(blank)";
    return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.00$/, "");
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  if (typeof value === "object") {
    try {
      const text = JSON.stringify(value);
      return text && text !== "{}" ? text : "(blank)";
    } catch {
      return "(blank)";
    }
  }

  const text = String(value).trim();
  return text || "(blank)";
}

function describeAuditChange(label, before, after) {
  const previous = formatAuditValue(before);
  const next = formatAuditValue(after);
  if (previous === next) return null;
  return `${label}: ${previous} -> ${next}`;
}

async function logAudit({ userId = null, actorName = null, module, action, details = null, ipAddress = null }) {
  if (!module || !action) return;

  await pool.query(
    `INSERT INTO audit_logs(user_id, actor_name, module, action, details, ip_address)
     VALUES (?,?,?,?,?,?)`,
    [
      userId || null,
      actorName ? String(actorName).trim().slice(0, 100) : null,
      String(module).trim().toUpperCase().slice(0, 100),
      String(action).trim().toUpperCase().slice(0, 100),
      details ? String(details).trim().slice(0, 4000) : null,
      ipAddress ? String(ipAddress).trim().slice(0, 64) : null
    ]
  );
}

async function safeLogAudit(entry) {
  try {
    await logAudit(entry);
  } catch (error) {
    console.error("Failed to write audit log:", error.message);
  }
}

module.exports = {
  describeAuditChange,
  formatAuditValue,
  getRequestIp,
  logAudit,
  safeLogAudit
};
