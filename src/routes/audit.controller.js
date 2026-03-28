const pool = require("../config/db");

exports.list = async (req, res) => {
  const q = String(req.query.q || "").trim();
  const moduleName = String(req.query.module || "").trim().toUpperCase();
  const action = String(req.query.action || "").trim().toUpperCase();
  const where = [];
  const params = [];

  if (q) {
    const like = `%${q}%`;
    where.push(
      "(COALESCE(u.name, al.actor_name, '') LIKE ? OR COALESCE(u.email, '') LIKE ? OR COALESCE(al.details, '') LIKE ? OR al.module LIKE ? OR al.action LIKE ?)"
    );
    params.push(like, like, like, like, like);
  }

  if (moduleName) {
    where.push("al.module = ?");
    params.push(moduleName);
  }

  if (action) {
    where.push("al.action = ?");
    params.push(action);
  }

  const sql = `SELECT al.id,
                      al.user_id,
                      COALESCE(u.name, al.actor_name, 'System') AS actor_name,
                      u.email,
                      al.module,
                      al.action,
                      al.details,
                      al.ip_address,
                      al.created_at
               FROM audit_logs al
               LEFT JOIN users u ON u.id = al.user_id
               ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY al.created_at DESC, al.id DESC
               LIMIT 250`;

  const [rows] = await pool.query(sql, params);
  return res.json(rows);
};
