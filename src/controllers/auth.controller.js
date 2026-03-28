const pool = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const {
  SYSTEM_ROLE_KEYS,
  defaultModulesForRole,
  normalizeRoleKey,
  parseModulesJson,
  roleLabel
} = require("../services/accessControl");
const { getRoleByKey } = require("../services/roles");
const { getRequestIp, safeLogAudit } = require("../services/audit");
const { isValidUsername, normalizeUsername } = require("../services/userIdentity");

function serializeUser(user) {
  if (!user) return null;

  const role = normalizeRoleKey(user.role);
  const status = String(user.status || "active").toLowerCase() === "inactive" ? "inactive" : "active";
  const permissions = parseModulesJson(user.permissions ?? user.modules_json, defaultModulesForRole(role));
  const mustChangePassword = Number(user.must_change_password || 0) === 1;

  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    role,
    roleLabel: roleLabel(role, user.role_name),
    status,
    permissions,
    mustChangePassword
  };
}

async function loadUserWithRole(userId) {
  const [rows] = await pool.query(
    `SELECT u.id,
            u.name,
            u.username,
            u.email,
            u.role,
            u.status,
            u.must_change_password,
            r.role_name,
            r.modules_json
     FROM users u
     LEFT JOIN roles r ON r.role_key = u.role
     WHERE u.id = ?
     LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

exports.register = async (req, res) => {
  const name = String(req.body.name || "").trim();
  const username = normalizeUsername(req.body.username);
  const email = String(req.body.email || "").trim();
  const password = String(req.body.password || "");
  const mustChangePassword = req.body.mustChangePassword ? 1 : 0;
  const requestedRole = Object.prototype.hasOwnProperty.call(req.body, "role")
    ? normalizeRoleKey(req.body.role)
    : "field_work";

  if (!name || !username || !email || !password) {
    return res.status(400).json({ message: "name, username, email, and password are required" });
  }

  if (!isValidUsername(username)) {
    return res.status(400).json({ message: "Username must be 3-64 characters and use letters, numbers, dot, underscore, plus, or hyphen" });
  }

  const [exists] = await pool.query("SELECT id FROM users WHERE email=?", [email]);
  if (exists.length) return res.status(400).json({ message: "Email already used" });

  const [usernameExists] = await pool.query("SELECT id FROM users WHERE username=? LIMIT 1", [username]);
  if (usernameExists.length) return res.status(400).json({ message: "Username already used" });

  const selectedRole = await getRoleByKey(requestedRole, { includeInactive: false });
  if (!selectedRole) {
    return res.status(400).json({ message: "Selected role is invalid or inactive" });
  }

  const hash = await bcrypt.hash(password, 10);
  const [result] = await pool.query(
    "INSERT INTO users(name,username,email,password_hash,role,status,must_change_password) VALUES (?,?,?,?,?,?,?)",
    [name, username, email, hash, selectedRole.key, "active", mustChangePassword]
  );

  const createdUser = serializeUser(await loadUserWithRole(result.insertId));

  await safeLogAudit({
    userId: createdUser?.id || null,
    actorName: createdUser?.name || name,
    module: "AUTH",
    action: "REGISTER",
    details: `${name} (${username}) registered as ${createdUser?.roleLabel || "Field Work"}.`,
    ipAddress: getRequestIp(req)
  });

  return res.json({ success: true, user: createdUser });
};

exports.login = async (req, res) => {
  const identifier = String(req.body.identifier || req.body.email || req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!identifier || !password) {
    return res.status(400).json({ message: "Username or email and password are required" });
  }

  const identifierLower = identifier.toLowerCase();
  const prefersEmail = identifier.includes("@");
  const [rows] = await pool.query(
    `SELECT *
     FROM users
     WHERE LOWER(email)=? OR LOWER(username)=?
     ORDER BY CASE
       WHEN ${prefersEmail ? "LOWER(email)=?" : "LOWER(username)=?"} THEN 0
       ELSE 1
     END
     LIMIT 1`,
    [identifierLower, identifierLower, identifierLower]
  );
  if (!rows.length) {
    await safeLogAudit({
      actorName: identifier,
      module: "AUTH",
      action: "LOGIN_FAILED",
      details: `Failed login attempt for ${identifier}.`,
      ipAddress: getRequestIp(req)
    });
    return res.status(400).json({ message: "Invalid credentials" });
  }

  const user = rows[0];
  if (String(user.status || "active").toLowerCase() === "inactive") {
    await safeLogAudit({
      userId: user.id,
      actorName: user.name || identifier,
      module: "AUTH",
      action: "LOGIN_BLOCKED",
      details: `Inactive account login blocked for ${user.username || user.email}.`,
      ipAddress: getRequestIp(req)
    });
    return res.status(403).json({ message: "Account is inactive" });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    await safeLogAudit({
      userId: user.id,
      actorName: user.name || identifier,
      module: "AUTH",
      action: "LOGIN_FAILED",
      details: `Failed login attempt for ${user.username || user.email}.`,
      ipAddress: getRequestIp(req)
    });
    return res.status(400).json({ message: "Invalid credentials" });
  }

  const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
    expiresIn: "8h"
  });

  const joinedUser = await loadUserWithRole(user.id);
  const normalizedRoleKey = normalizeRoleKey(joinedUser?.role);
  if (!joinedUser?.role_name && ![SYSTEM_ROLE_KEYS.ADMIN, SYSTEM_ROLE_KEYS.FIELD_WORK].includes(normalizedRoleKey)) {
    return res.status(403).json({ message: "Assigned role was not found" });
  }

  const safeUser = serializeUser(joinedUser);
  await safeLogAudit({
    userId: user.id,
    actorName: user.name,
    module: "AUTH",
    action: "LOGIN_SUCCESS",
    details: safeUser.mustChangePassword
      ? `${user.name} signed in with a temporary password and must change it.`
      : `${user.name} signed in as ${safeUser.roleLabel}.`,
    ipAddress: getRequestIp(req)
  });

  return res.json({ token, user: safeUser, mustChangePassword: safeUser.mustChangePassword });
};

exports.me = async (req, res) => {
  return res.json(serializeUser(req.user));
};

exports.changePassword = async (req, res) => {
  const password = String(req.body.password || "");
  if (password.length < 8) {
    return res.status(400).json({ message: "New password must be at least 8 characters" });
  }

  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    "UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?",
    [hash, req.user.id]
  );

  const updatedUser = serializeUser(await loadUserWithRole(req.user.id));

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "AUTH",
    action: "PASSWORD_CHANGED",
    details: `${req.user.name} changed their password after login.`,
    ipAddress: getRequestIp(req)
  });

  return res.json({ success: true, user: updatedUser });
};
