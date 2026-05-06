const pool = require("../config/db");
const { describeAuditChange, formatAuditValue, getRequestIp, safeLogAudit } = require("../services/audit");

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanText(value, maxLength = 255) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : null;
}

function toFlag(value, fallback = true) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

function formatSqlDate(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ── Customers ─────────────────────────────────────────────────────────────────

async function fetchCustomer(id, connection = pool) {
  const [rows] = await connection.query(
    `SELECT c.*,
            u.name AS created_by_name,
            COALESCE(ps.project_count, 0) AS project_count,
            COALESCE(ps.total_sales, 0) AS total_sales,
            COALESCE(es.total_expenses, 0) AS total_expenses
       FROM customers c
       LEFT JOIN users u ON u.id = c.created_by
       LEFT JOIN (
         SELECT customer_id,
                COUNT(*) AS project_count,
                COALESCE(SUM(sale_amount), 0) AS total_sales
           FROM customer_projects
          GROUP BY customer_id
       ) ps ON ps.customer_id = c.id
       LEFT JOIN (
         SELECT p.customer_id,
                COALESCE(SUM(bt.amount), 0) AS total_expenses
           FROM customer_projects p
           JOIN budget_transactions bt ON bt.project_id = p.id AND bt.type = 'out'
          GROUP BY p.customer_id
       ) es ON es.customer_id = c.id
      WHERE c.id = ?
      LIMIT 1`,
    [id]
  );
  return serializeCustomer(rows[0] || null);
}

function serializeCustomer(row) {
  if (!row) return null;
  const totalSales = toNumber(row.total_sales, 0);
  const totalExpenses = toNumber(row.total_expenses, 0);
  return {
    ...row,
    is_active: Number(row.is_active) === 1 ? 1 : 0,
    project_count: toNumber(row.project_count, 0),
    total_sales: totalSales,
    total_expenses: totalExpenses,
    margin: totalSales - totalExpenses
  };
}

exports.listCustomers = async (req, res) => {
  const active = String(req.query.active || "all").toLowerCase();
  const where = [];
  const params = [];
  if (active !== "all") {
    where.push("c.is_active = ?");
    params.push(active === "0" ? 0 : 1);
  }
  const [rows] = await pool.query(
    `SELECT c.*,
            u.name AS created_by_name,
            COALESCE(ps.project_count, 0) AS project_count,
            COALESCE(ps.total_sales, 0) AS total_sales,
            COALESCE(es.total_expenses, 0) AS total_expenses
       FROM customers c
       LEFT JOIN users u ON u.id = c.created_by
       LEFT JOIN (
         SELECT customer_id,
                COUNT(*) AS project_count,
                COALESCE(SUM(sale_amount), 0) AS total_sales
           FROM customer_projects
          GROUP BY customer_id
       ) ps ON ps.customer_id = c.id
       LEFT JOIN (
         SELECT p.customer_id,
                COALESCE(SUM(bt.amount), 0) AS total_expenses
           FROM customer_projects p
           JOIN budget_transactions bt ON bt.project_id = p.id AND bt.type = 'out'
          GROUP BY p.customer_id
       ) es ON es.customer_id = c.id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY c.name ASC`,
    params
  );
  return res.json(rows.map(serializeCustomer));
};

exports.createCustomer = async (req, res) => {
  const name = cleanText(req.body.name, 160);
  const contact = cleanText(req.body.contact, 120);
  const address = cleanText(req.body.address, 500);
  const notes = cleanText(req.body.notes, 4000);
  if (!name) return res.status(400).json({ message: "name is required" });

  try {
    const [result] = await pool.query(
      "INSERT INTO customers (name, contact, address, notes, created_by) VALUES (?,?,?,?,?)",
      [name, contact, address, notes, req.user.id]
    );
    const created = await fetchCustomer(result.insertId);
    await safeLogAudit({ userId: req.user.id, actorName: req.user.name, module: "SALES", action: "CUSTOMER_CREATED", details: `Customer "${name}" created.`, ipAddress: getRequestIp(req) });
    return res.status(201).json(created);
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "A customer with that name already exists." });
    throw err;
  }
};

exports.updateCustomer = async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid id" });
  const existing = await fetchCustomer(id);
  if (!existing) return res.status(404).json({ message: "Customer not found" });

  const name = Object.prototype.hasOwnProperty.call(req.body, "name") ? cleanText(req.body.name, 160) : existing.name;
  const contact = Object.prototype.hasOwnProperty.call(req.body, "contact") ? cleanText(req.body.contact, 120) : existing.contact;
  const address = Object.prototype.hasOwnProperty.call(req.body, "address") ? cleanText(req.body.address, 500) : existing.address;
  const notes = Object.prototype.hasOwnProperty.call(req.body, "notes") ? cleanText(req.body.notes, 4000) : existing.notes;
  const isActive = Object.prototype.hasOwnProperty.call(req.body, "isActive") ? (toFlag(req.body.isActive) ? 1 : 0) : Number(existing.is_active);

  if (!name) return res.status(400).json({ message: "name is required" });

  try {
    await pool.query("UPDATE customers SET name=?, contact=?, address=?, notes=?, is_active=? WHERE id=?", [name, contact, address, notes, isActive, id]);
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "A customer with that name already exists." });
    throw err;
  }

  const updated = await fetchCustomer(id);
  const changes = [
    describeAuditChange("Name", existing.name, updated.name),
    describeAuditChange("Contact", existing.contact, updated.contact),
  ].filter(Boolean);
  await safeLogAudit({ userId: req.user.id, actorName: req.user.name, module: "SALES", action: "CUSTOMER_UPDATED", details: changes.length ? `Customer "${updated.name}" updated. ${changes.join("; ")}.` : `Customer "${updated.name}" saved.`, ipAddress: getRequestIp(req) });
  return res.json(updated);
};

exports.deleteCustomer = async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid id" });
  const existing = await fetchCustomer(id);
  if (!existing) return res.status(404).json({ message: "Customer not found" });

  if (existing.project_count > 0) {
    await pool.query("UPDATE customers SET is_active=0 WHERE id=?", [id]);
    await safeLogAudit({ userId: req.user.id, actorName: req.user.name, module: "SALES", action: "CUSTOMER_DEACTIVATED", details: `Customer "${existing.name}" deactivated (has ${existing.project_count} project(s)).`, ipAddress: getRequestIp(req) });
    return res.json({ success: true, deactivated: true });
  }
  await pool.query("DELETE FROM customers WHERE id=?", [id]);
  await safeLogAudit({ userId: req.user.id, actorName: req.user.name, module: "SALES", action: "CUSTOMER_DELETED", details: `Customer "${existing.name}" deleted.`, ipAddress: getRequestIp(req) });
  return res.json({ success: true, deactivated: false });
};

// ── Projects ──────────────────────────────────────────────────────────────────

async function fetchProject(id, connection = pool) {
  const [rows] = await connection.query(
    `SELECT p.*,
            c.name AS customer_name,
            u.name AS created_by_name,
            COALESCE(SUM(CASE WHEN bt.type='out' THEN bt.amount ELSE 0 END), 0) AS total_expenses,
            COALESCE(SUM(CASE WHEN bt.type='in'  THEN bt.amount ELSE 0 END), 0) AS total_income,
            COUNT(bt.id) AS transaction_count
       FROM customer_projects p
       JOIN customers c ON c.id = p.customer_id
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN budget_transactions bt ON bt.project_id = p.id
      WHERE p.id = ?
      GROUP BY p.id
      LIMIT 1`,
    [id]
  );
  return serializeProject(rows[0] || null);
}

function serializeProject(row) {
  if (!row) return null;
  const saleAmount = toNumber(row.sale_amount, 0);
  const totalExpenses = toNumber(row.total_expenses, 0);
  const totalIncome = toNumber(row.total_income, 0);
  const balanceDue = Math.max(0, saleAmount - totalIncome);
  return {
    ...row,
    project_date: formatSqlDate(row.project_date),
    sale_amount: saleAmount,
    total_expenses: totalExpenses,
    total_income: totalIncome,
    collected_amount: totalIncome,
    balance_due: balanceDue,
    collection_percent: saleAmount > 0 ? Math.min(100, (totalIncome / saleAmount) * 100) : 0,
    transaction_count: toNumber(row.transaction_count, 0),
    margin: saleAmount - totalExpenses
  };
}

function serializeProjectTransaction(row) {
  if (!row) return null;
  return {
    ...row,
    amount: toNumber(row.amount, 0),
    price: row.price == null ? null : toNumber(row.price, 0),
    quantity: row.quantity == null ? null : toNumber(row.quantity, 0),
    transaction_date: formatSqlDate(row.transaction_date)
  };
}

exports.listProjects = async (req, res) => {
  const customerId = Number(req.query.customerId || 0);
  const where = [];
  const params = [];
  if (customerId > 0) { where.push("p.customer_id = ?"); params.push(customerId); }

  const [rows] = await pool.query(
    `SELECT p.*,
            c.name AS customer_name,
            u.name AS created_by_name,
            COALESCE(SUM(CASE WHEN bt.type='out' THEN bt.amount ELSE 0 END), 0) AS total_expenses,
            COALESCE(SUM(CASE WHEN bt.type='in'  THEN bt.amount ELSE 0 END), 0) AS total_income,
            COUNT(bt.id) AS transaction_count
       FROM customer_projects p
       JOIN customers c ON c.id = p.customer_id
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN budget_transactions bt ON bt.project_id = p.id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY p.id
      ORDER BY p.project_date DESC, p.id DESC`,
    params
  );
  return res.json(rows.map(serializeProject));
};

exports.createProject = async (req, res) => {
  const customerId = Number(req.body.customerId || 0);
  if (!customerId) return res.status(400).json({ message: "customerId is required" });
  const projectName = cleanText(req.body.projectName, 200);
  if (!projectName) return res.status(400).json({ message: "projectName is required" });
  const saleAmount = Math.max(0, toNumber(req.body.saleAmount, 0));
  const projectDate = normalizeDate(req.body.projectDate);
  const notes = cleanText(req.body.notes, 4000);
  const status = ["active", "completed", "cancelled"].includes(req.body.status) ? req.body.status : "active";

  const [custRows] = await pool.query("SELECT id, name FROM customers WHERE id=? LIMIT 1", [customerId]);
  if (!custRows.length) return res.status(404).json({ message: "Customer not found" });

  const [result] = await pool.query(
    "INSERT INTO customer_projects (customer_id, project_name, sale_amount, project_date, status, notes, created_by) VALUES (?,?,?,?,?,?,?)",
    [customerId, projectName, saleAmount, projectDate, status, notes, req.user.id]
  );
  const created = await fetchProject(result.insertId);
  await safeLogAudit({ userId: req.user.id, actorName: req.user.name, module: "SALES", action: "PROJECT_CREATED", details: `Project "${projectName}" created for ${custRows[0].name}. Sale: ${formatAuditValue(saleAmount)}.`, ipAddress: getRequestIp(req) });
  return res.status(201).json(created);
};

exports.updateProject = async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid id" });
  const existing = await fetchProject(id);
  if (!existing) return res.status(404).json({ message: "Project not found" });

  const projectName = Object.prototype.hasOwnProperty.call(req.body, "projectName") ? cleanText(req.body.projectName, 200) : existing.project_name;
  const saleAmount = Object.prototype.hasOwnProperty.call(req.body, "saleAmount") ? Math.max(0, toNumber(req.body.saleAmount, 0)) : toNumber(existing.sale_amount, 0);
  const projectDate = Object.prototype.hasOwnProperty.call(req.body, "projectDate") ? normalizeDate(req.body.projectDate) : existing.project_date;
  const status = Object.prototype.hasOwnProperty.call(req.body, "status") ? (["active", "completed", "cancelled"].includes(req.body.status) ? req.body.status : existing.status) : existing.status;
  const notes = Object.prototype.hasOwnProperty.call(req.body, "notes") ? cleanText(req.body.notes, 4000) : existing.notes;

  if (!projectName) return res.status(400).json({ message: "projectName is required" });

  await pool.query(
    "UPDATE customer_projects SET project_name=?, sale_amount=?, project_date=?, status=?, notes=? WHERE id=?",
    [projectName, saleAmount, projectDate, status, notes, id]
  );

  const updated = await fetchProject(id);
  const changes = [
    describeAuditChange("Name", existing.project_name, updated.project_name),
    describeAuditChange("Sale amount", existing.sale_amount, updated.sale_amount),
    describeAuditChange("Status", existing.status, updated.status),
  ].filter(Boolean);
  await safeLogAudit({ userId: req.user.id, actorName: req.user.name, module: "SALES", action: "PROJECT_UPDATED", details: changes.length ? `Project "${updated.project_name}" updated. ${changes.join("; ")}.` : `Project "${updated.project_name}" saved.`, ipAddress: getRequestIp(req) });
  return res.json(updated);
};

exports.deleteProject = async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid id" });
  const existing = await fetchProject(id);
  if (!existing) return res.status(404).json({ message: "Project not found" });

  await pool.query("UPDATE budget_transactions SET project_id=NULL WHERE project_id=?", [id]);
  await pool.query("DELETE FROM customer_projects WHERE id=?", [id]);
  await safeLogAudit({ userId: req.user.id, actorName: req.user.name, module: "SALES", action: "PROJECT_DELETED", details: `Project "${existing.project_name}" deleted. ${existing.transaction_count} transaction(s) unlinked.`, ipAddress: getRequestIp(req) });
  return res.json({ success: true });
};

exports.listProjectTransactions = async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid id" });
  const [rows] = await pool.query(
    `SELECT bt.*, a.name AS account_name, u.name AS created_by_name
       FROM budget_transactions bt
       LEFT JOIN budget_accounts a ON a.id = bt.account_id
       LEFT JOIN users u ON u.id = bt.created_by
      WHERE bt.project_id = ?
      ORDER BY bt.transaction_date DESC, bt.id DESC`,
    [id]
  );
  return res.json(rows.map(serializeProjectTransaction));
};

// ── Summary ───────────────────────────────────────────────────────────────────

exports.summary = async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT
       (SELECT COUNT(*)
          FROM customers c
         WHERE c.is_active = 1) AS total_customers,
       (SELECT COUNT(*)
          FROM customer_projects p
          JOIN customers c ON c.id = p.customer_id
         WHERE c.is_active = 1) AS total_projects,
       (SELECT COALESCE(SUM(p.sale_amount), 0)
          FROM customer_projects p
          JOIN customers c ON c.id = p.customer_id
         WHERE c.is_active = 1) AS total_sales,
       (SELECT COALESCE(SUM(bt.amount), 0)
          FROM budget_transactions bt
          JOIN customer_projects p ON p.id = bt.project_id
          JOIN customers c ON c.id = p.customer_id
         WHERE bt.type='out' AND c.is_active = 1) AS total_expenses`
  );
  const r = rows[0] || {};
  const totalSales = toNumber(r.total_sales, 0);
  const totalExpenses = toNumber(r.total_expenses, 0);
  return res.json({
    totalCustomers: toNumber(r.total_customers, 0),
    totalProjects: toNumber(r.total_projects, 0),
    totalSales,
    totalExpenses,
    totalMargin: totalSales - totalExpenses
  });
};
