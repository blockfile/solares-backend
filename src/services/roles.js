const pool = require("../config/db");
const {
  SYSTEM_ROLE_KEYS,
  defaultModulesForRole,
  getAllModuleKeys,
  normalizeModules,
  normalizeRoleKey,
  roleLabel
} = require("./accessControl");

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase() === "inactive" ? "inactive" : "active";
}

function serializeRole(row) {
  if (!row) return null;

  const key = normalizeRoleKey(row.role_key || row.key);
  const modules =
    key === SYSTEM_ROLE_KEYS.ADMIN
      ? getAllModuleKeys()
      : normalizeModules(row.modules_json, defaultModulesForRole(key));

  return {
    id: row.id,
    key,
    label: roleLabel(key, row.role_name),
    description: String(row.description || "").trim(),
    modules,
    status: normalizeStatus(row.status),
    isSystem: Boolean(row.is_system),
    totalUsers: Number(row.total_users || 0),
    activeUsers: Number(row.active_users || 0),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

async function getRoleByKey(roleKey, { includeInactive = true } = {}) {
  const key = normalizeRoleKey(roleKey);
  const params = [key];
  const where = ["role_key = ?"];

  if (!includeInactive) {
    where.push("status = 'active'");
  }

  const [rows] = await pool.query(
    `SELECT id, role_key, role_name, description, modules_json, status, is_system, created_at, updated_at
     FROM roles
     WHERE ${where.join(" AND ")}
     LIMIT 1`,
    params
  );

  return serializeRole(rows[0]);
}

async function listRoles({ includeInactive = true } = {}) {
  const where = includeInactive ? "" : "WHERE r.status = 'active'";
  const [rows] = await pool.query(
    `SELECT r.id,
            r.role_key,
            r.role_name,
            r.description,
            r.modules_json,
            r.status,
            r.is_system,
            r.created_at,
            r.updated_at,
            COUNT(u.id) AS total_users,
            SUM(CASE WHEN u.status = 'active' THEN 1 ELSE 0 END) AS active_users
     FROM roles r
     LEFT JOIN users u ON u.role = r.role_key
     ${where}
     GROUP BY r.id, r.role_key, r.role_name, r.description, r.modules_json, r.status, r.is_system, r.created_at, r.updated_at
     ORDER BY r.is_system DESC, r.role_name ASC`
  );

  return rows.map(serializeRole);
}

async function countUsersForRole(roleKey, { activeOnly = false } = {}) {
  const params = [normalizeRoleKey(roleKey)];
  let sql = "SELECT COUNT(*) AS count FROM users WHERE role = ?";
  if (activeOnly) {
    sql += " AND status = 'active'";
  }
  const [rows] = await pool.query(sql, params);
  return Number(rows[0]?.count || 0);
}

module.exports = {
  countUsersForRole,
  getRoleByKey,
  listRoles,
  normalizeStatus,
  serializeRole
};
