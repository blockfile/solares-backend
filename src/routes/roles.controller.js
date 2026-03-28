const pool = require("../config/db");
const {
  SYSTEM_ROLE_KEYS,
  getAllModuleKeys,
  listModules,
  normalizeModules,
  normalizeRoleKey
} = require("../services/accessControl");
const { countUsersForRole, getRoleByKey, listRoles, normalizeStatus } = require("../services/roles");
const { getRequestIp, safeLogAudit } = require("../services/audit");

exports.list = async (_req, res) => {
  const roles = await listRoles();
  return res.json(roles);
};

exports.modules = async (_req, res) => {
  return res.json(listModules());
};

exports.create = async (req, res) => {
  const roleName = String(req.body.label || req.body.name || "").trim();
  const description = String(req.body.description || "").trim();
  const status = normalizeStatus(req.body.status);
  const roleKey = normalizeRoleKey(req.body.key || roleName);
  const modules = normalizeModules(req.body.modules);

  if (!roleName) return res.status(400).json({ message: "Role name is required" });
  if (!roleKey) return res.status(400).json({ message: "Role key is required" });
  if (!modules.length) return res.status(400).json({ message: "Select at least one module" });

  const existing = await getRoleByKey(roleKey);
  if (existing) return res.status(409).json({ message: "A role with that key already exists" });

  await pool.query(
    `INSERT INTO roles(role_key, role_name, description, modules_json, status, is_system)
     VALUES (?,?,?,?,?,0)`,
    [roleKey, roleName, description || null, JSON.stringify(modules), status]
  );

  const created = await getRoleByKey(roleKey);
  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "ROLES",
    action: "ROLE_CREATED",
    details: `${created.label} created with ${created.modules.length} module permission(s).`,
    ipAddress: getRequestIp(req)
  });

  return res.status(201).json(created);
};

exports.update = async (req, res) => {
  const roleKey = normalizeRoleKey(req.params.key);
  const existing = await getRoleByKey(roleKey, { includeInactive: true });
  if (!existing) return res.status(404).json({ message: "Role not found" });

  const roleName = Object.prototype.hasOwnProperty.call(req.body, "label") || Object.prototype.hasOwnProperty.call(req.body, "name")
    ? String(req.body.label || req.body.name || "").trim()
    : existing.label;
  const description = Object.prototype.hasOwnProperty.call(req.body, "description")
    ? String(req.body.description || "").trim()
    : existing.description;
  const requestedStatus = Object.prototype.hasOwnProperty.call(req.body, "status")
    ? normalizeStatus(req.body.status)
    : existing.status;
  const requestedModules = Object.prototype.hasOwnProperty.call(req.body, "modules")
    ? normalizeModules(req.body.modules)
    : existing.modules;

  if (!roleName) return res.status(400).json({ message: "Role name is required" });

  const status =
    roleKey === SYSTEM_ROLE_KEYS.ADMIN ? "active" : requestedStatus;
  const modules =
    roleKey === SYSTEM_ROLE_KEYS.ADMIN ? getAllModuleKeys() : requestedModules;

  if (!modules.length) return res.status(400).json({ message: "Select at least one module" });

  if (status === "inactive") {
    const assignedUsers = await countUsersForRole(roleKey);
    if (assignedUsers > 0) {
      return res.status(400).json({ message: "Reassign users before inactivating this role" });
    }
  }

  await pool.query(
    `UPDATE roles
     SET role_name=?, description=?, modules_json=?, status=?
     WHERE role_key=?`,
    [roleName, description || null, JSON.stringify(modules), status, roleKey]
  );

  const updated = await getRoleByKey(roleKey, { includeInactive: true });
  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "ROLES",
    action: "ROLE_UPDATED",
    details: `${updated.label} updated with ${updated.modules.length} module permission(s).`,
    ipAddress: getRequestIp(req)
  });

  return res.json(updated);
};
