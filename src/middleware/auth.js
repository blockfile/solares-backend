const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const {
  SYSTEM_ROLE_KEYS,
  defaultModulesForRole,
  normalizeRoleKey,
  parseModulesJson,
  roleLabel
} = require("../services/accessControl");

module.exports = async function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: "Missing token" });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }

  try {
    const [rows] = await pool.query(
      `SELECT u.id,
              u.name,
              u.username,
              u.email,
              u.role,
              u.status,
              u.must_change_password,
              r.role_name,
              r.modules_json,
              r.status AS role_status
       FROM users u
       LEFT JOIN roles r ON r.role_key = u.role
       WHERE u.id = ?
       LIMIT 1`,
      [payload.id]
    );

    if (!rows.length) {
      return res.status(401).json({ message: "User not found" });
    }

    const user = rows[0];
    if (String(user.status || "active").toLowerCase() === "inactive") {
      return res.status(401).json({ message: "Account is inactive" });
    }

    const roleKey = normalizeRoleKey(user.role);
    const roleStatus = String(user.role_status || "active").toLowerCase();
    if (!user.role_name && ![SYSTEM_ROLE_KEYS.ADMIN, SYSTEM_ROLE_KEYS.FIELD_WORK].includes(roleKey)) {
      return res.status(403).json({ message: "Assigned role was not found" });
    }
    if (roleStatus === "inactive") {
      return res.status(403).json({ message: "Assigned role is inactive" });
    }

    req.user = {
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      role: roleKey,
      roleLabel: roleLabel(roleKey, user.role_name),
      status: "active",
      permissions: parseModulesJson(user.modules_json, defaultModulesForRole(roleKey)),
      must_change_password: Number(user.must_change_password || 0) === 1 ? 1 : 0
    };
    return next();
  } catch (error) {
    return next(error);
  }
};
