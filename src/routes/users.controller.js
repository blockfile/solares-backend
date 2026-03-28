const bcrypt = require("bcrypt");
const pool = require("../config/db");
const { normalizeRoleKey, roleLabel } = require("../services/accessControl");
const { countUsersForRole, getRoleByKey, normalizeStatus } = require("../services/roles");
const { getRequestIp, safeLogAudit } = require("../services/audit");
const { isValidUsername, normalizeUsername } = require("../services/userIdentity");

function serializeUser(user) {
  const role = normalizeRoleKey(user.role);
  const status = normalizeStatus(user.status);
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    role,
    roleLabel: roleLabel(role, user.role_name),
    status,
    roleStatus: normalizeStatus(user.role_status),
    mustChangePassword: Number(user.must_change_password || 0) === 1,
    createdAt: user.created_at
  };
}

async function countActiveAdmins(excludeUserId = null) {
  const params = [];
  let sql = "SELECT COUNT(*) AS count FROM users WHERE role='admin' AND status='active'";
  if (excludeUserId) {
    sql += " AND id <> ?";
    params.push(excludeUserId);
  }
  const [rows] = await pool.query(sql, params);
  return Number(rows[0]?.count || 0);
}

exports.list = async (req, res) => {
  const q = String(req.query.q || "").trim();
  const role = String(req.query.role || "").trim();
  const status = String(req.query.status || "").trim();
  const where = [];
  const params = [];

  if (q) {
    const like = `%${q}%`;
    where.push("(u.name LIKE ? OR u.username LIKE ? OR u.email LIKE ?)");
    params.push(like, like, like);
  }

  if (role) {
    where.push("u.role = ?");
    params.push(normalizeRoleKey(role));
  }

  if (status) {
    where.push("u.status = ?");
    params.push(normalizeStatus(status));
  }

  const sql = `SELECT u.id,
                      u.name,
                      u.username,
                      u.email,
                      u.role,
                      u.status,
                      u.must_change_password,
                      u.created_at,
                      r.role_name,
                      r.status AS role_status
               FROM users u
               LEFT JOIN roles r ON r.role_key = u.role
               ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY u.created_at DESC, u.id DESC`;
  const [rows] = await pool.query(sql, params);
  return res.json(rows.map(serializeUser));
};

exports.create = async (req, res) => {
  const name = String(req.body.name || "").trim();
  const username = normalizeUsername(req.body.username);
  const email = String(req.body.email || "").trim();
  const password = String(req.body.password || "");
  const mustChangePassword = req.body.mustChangePassword ? 1 : 0;
  const role = normalizeRoleKey(req.body.role);
  const status = normalizeStatus(req.body.status);

  if (!name || !username || !email || !password) {
    return res.status(400).json({ message: "name, username, email, and password are required" });
  }

  if (!isValidUsername(username)) {
    return res.status(400).json({ message: "Username must be 3-64 characters and use letters, numbers, dot, underscore, plus, or hyphen" });
  }

  const [exists] = await pool.query("SELECT id FROM users WHERE email=? LIMIT 1", [email]);
  if (exists.length) return res.status(409).json({ message: "Email already used" });

  const [usernameRows] = await pool.query("SELECT id FROM users WHERE username=? LIMIT 1", [username]);
  if (usernameRows.length) return res.status(409).json({ message: "Username already used" });

  const selectedRole = await getRoleByKey(role, { includeInactive: false });
  if (!selectedRole) {
    return res.status(400).json({ message: "Selected role is invalid or inactive" });
  }

  const hash = await bcrypt.hash(password, 10);
  const [result] = await pool.query(
    "INSERT INTO users(name,username,email,password_hash,role,status,must_change_password) VALUES (?,?,?,?,?,?,?)",
    [name, username, email, hash, selectedRole.key, status, mustChangePassword]
  );

  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.username, u.email, u.role, u.status, u.must_change_password, u.created_at, r.role_name, r.status AS role_status
     FROM users u
     LEFT JOIN roles r ON r.role_key = u.role
     WHERE u.id=? LIMIT 1`,
    [result.insertId]
  );
  const created = serializeUser(rows[0]);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "USERS",
    action: "USER_CREATED",
    details: `${created.name} (${created.username}) was created as ${created.roleLabel} with a generated temporary password.`,
    ipAddress: getRequestIp(req)
  });

  return res.status(201).json(created);
};

exports.update = async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid user id" });

  const [rows] = await pool.query("SELECT * FROM users WHERE id=? LIMIT 1", [id]);
  if (!rows.length) return res.status(404).json({ message: "User not found" });

  const existing = rows[0];
  const name = Object.prototype.hasOwnProperty.call(req.body, "name")
    ? String(req.body.name || "").trim()
    : String(existing.name || "").trim();
  const username = Object.prototype.hasOwnProperty.call(req.body, "username")
    ? normalizeUsername(req.body.username)
    : normalizeUsername(existing.username);
  const email = Object.prototype.hasOwnProperty.call(req.body, "email")
    ? String(req.body.email || "").trim()
    : String(existing.email || "").trim();
  const role = Object.prototype.hasOwnProperty.call(req.body, "role")
    ? normalizeRoleKey(req.body.role)
    : normalizeRoleKey(existing.role);
  const status = Object.prototype.hasOwnProperty.call(req.body, "status")
    ? normalizeStatus(req.body.status)
    : normalizeStatus(existing.status);
  const password = String(req.body.password || "");
  const mustChangePassword = req.body.mustChangePassword ? 1 : 0;

  if (!name || !username || !email) return res.status(400).json({ message: "name, username, and email are required" });

  if (!isValidUsername(username)) {
    return res.status(400).json({ message: "Username must be 3-64 characters and use letters, numbers, dot, underscore, plus, or hyphen" });
  }

  const [emailRows] = await pool.query("SELECT id FROM users WHERE email=? AND id<>? LIMIT 1", [email, id]);
  if (emailRows.length) return res.status(409).json({ message: "Email already used" });

  const [usernameRows] = await pool.query("SELECT id FROM users WHERE username=? AND id<>? LIMIT 1", [username, id]);
  if (usernameRows.length) return res.status(409).json({ message: "Username already used" });

  const selectedRole = await getRoleByKey(role, { includeInactive: true });
  if (!selectedRole) {
    return res.status(400).json({ message: "Selected role is invalid" });
  }

  if (selectedRole.status !== "active" && selectedRole.key !== normalizeRoleKey(existing.role)) {
    return res.status(400).json({ message: "Selected role is inactive" });
  }

  const wasAdmin = normalizeRoleKey(existing.role) === "admin" && normalizeStatus(existing.status) === "active";
  const willStayAdmin = selectedRole.key === "admin" && status === "active";

  if (Number(req.user.id) === id && !willStayAdmin) {
    return res.status(400).json({ message: "You cannot remove your own admin access" });
  }

  if (wasAdmin && !willStayAdmin) {
    const remainingAdmins = await countActiveAdmins(id);
    if (remainingAdmins < 1) {
      return res.status(400).json({ message: "At least one active admin account is required" });
    }
  }

  const params = [name, username, email, selectedRole.key, status];
  let sql = "UPDATE users SET name=?, username=?, email=?, role=?, status=?";
  if (password) {
    sql += ", password_hash=?, must_change_password=?";
    params.push(await bcrypt.hash(password, 10));
    params.push(mustChangePassword);
  }
  sql += " WHERE id=?";
  params.push(id);

  await pool.query(sql, params);

  const [updatedRows] = await pool.query(
    `SELECT u.id, u.name, u.username, u.email, u.role, u.status, u.must_change_password, u.created_at, r.role_name, r.status AS role_status
     FROM users u
     LEFT JOIN roles r ON r.role_key = u.role
     WHERE u.id=? LIMIT 1`,
    [id]
  );
  const updated = serializeUser(updatedRows[0]);

  const changeSummary = [
    `${updated.name} (${updated.username}) updated`,
    `role: ${updated.roleLabel}`,
    `status: ${updated.status}`
  ];
  if (password) changeSummary.push("temporary password regenerated");

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "USERS",
    action: "USER_UPDATED",
    details: changeSummary.join(", "),
    ipAddress: getRequestIp(req)
  });

  return res.json(updated);
};

exports.remove = async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid user id" });

  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.username, u.email, u.role, u.status, r.role_name
     FROM users u
     LEFT JOIN roles r ON r.role_key = u.role
     WHERE u.id=? LIMIT 1`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ message: "User not found" });

  const existing = rows[0];
  const normalizedRole = normalizeRoleKey(existing.role);
  const normalizedStatus = normalizeStatus(existing.status);

  if (Number(req.user.id) === id) {
    return res.status(400).json({ message: "You cannot delete your own account" });
  }

  if (normalizedRole === "admin" && normalizedStatus === "active") {
    const remainingAdmins = await countActiveAdmins(id);
    if (remainingAdmins < 1) {
      return res.status(400).json({ message: "At least one active admin account is required" });
    }
  }

  const [eventResult, quoteResult] = await Promise.all([
    pool.query("SELECT COUNT(*) AS count FROM events WHERE user_id=?", [id]),
    pool.query("SELECT COUNT(*) AS count FROM quotes WHERE created_by=?", [id])
  ]);

  const [eventRows] = eventResult;
  const [quoteRows] = quoteResult;
  const linkedEvents = Number(eventRows[0]?.count || 0);
  const linkedQuotes = Number(quoteRows[0]?.count || 0);

  if (linkedEvents > 0 || linkedQuotes > 0) {
    const previewLimit = 10;
    const [eventPreviewResult, quotePreviewResult] = await Promise.all([
      linkedEvents > 0
        ? pool.query(
            `SELECT id, title, start_datetime, end_datetime
             FROM events
             WHERE user_id=?
             ORDER BY start_datetime DESC, id DESC
             LIMIT ?`,
            [id, previewLimit]
          )
        : Promise.resolve([[]]),
      linkedQuotes > 0
        ? pool.query(
            `SELECT id, quote_ref, customer_name, created_at
             FROM quotes
             WHERE created_by=?
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
            [id, previewLimit]
          )
        : Promise.resolve([[]])
    ]);

    const [eventPreviewRows] = eventPreviewResult;
    const [quotePreviewRows] = quotePreviewResult;
    const blockers = [];
    if (linkedEvents > 0) blockers.push(`${linkedEvents} calendar event${linkedEvents === 1 ? "" : "s"}`);
    if (linkedQuotes > 0) blockers.push(`${linkedQuotes} quote${linkedQuotes === 1 ? "" : "s"}`);

    return res.status(400).json({
      message: `${existing.name} cannot be deleted because this account still owns ${blockers.join(" and ")}. Deactivate the account instead.`,
      linkedEvents,
      linkedQuotes,
      previewLimit,
      linkedEventItems: eventPreviewRows.map((row) => ({
        id: Number(row.id),
        title: String(row.title || ""),
        startDatetime: row.start_datetime,
        endDatetime: row.end_datetime
      })),
      linkedQuoteItems: quotePreviewRows.map((row) => ({
        id: Number(row.id),
        quoteRef: String(row.quote_ref || ""),
        customerName: String(row.customer_name || ""),
        createdAt: row.created_at
      }))
    });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE audit_logs SET user_id=NULL WHERE user_id=?", [id]);
    await conn.query("DELETE FROM users WHERE id=?", [id]);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    if (error?.code === "ER_ROW_IS_REFERENCED_2" || error?.code === "ER_ROW_IS_REFERENCED") {
      return res.status(400).json({
        message:
          "This user still has related records in the system. Deactivate the account instead of deleting it."
      });
    }
    throw error;
  } finally {
    conn.release();
  }

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "USERS",
    action: "USER_DELETED",
    details: `${existing.name} (${existing.username}) was deleted.`,
    ipAddress: getRequestIp(req)
  });

  return res.json({ success: true });
};
