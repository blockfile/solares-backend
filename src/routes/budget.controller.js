const fs = require("fs");
const XLSX = require("xlsx");
const pool = require("../config/db");
const { describeAuditChange, formatAuditValue, getRequestIp, safeLogAudit } = require("../services/audit");

function toNumber(value, fallback = 0) {
  if (typeof value === "string") {
    const cleaned = value
      .trim()
      .replace(/^(php|php\.|peso|pesos)\s*/i, "")
      .replace(/[,\s₱$]/g, "");
    if (!cleaned) return fallback;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
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
  if (["1", "true", "yes", "on", "active"].includes(text)) return true;
  if (["0", "false", "no", "off", "inactive"].includes(text)) return false;
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

function formatMoney(value) {
  return toNumber(value, 0);
}

function serializeAccount(row) {
  if (!row) return null;
  return {
    ...row,
    is_active: Number(row.is_active) === 1 ? 1 : 0,
    total_in: formatMoney(row.total_in),
    total_out: formatMoney(row.total_out),
    balance: formatMoney(row.balance),
    transaction_count: toNumber(row.transaction_count, 0)
  };
}

function serializeTransaction(row) {
  if (!row) return null;
  return {
    ...row,
    amount: formatMoney(row.amount),
    running_balance: row.running_balance != null ? formatMoney(row.running_balance) : null
  };
}

let ensureImportTrackingSchemaPromise = null;

async function ensureImportTrackingSchema() {
  if (!ensureImportTrackingSchemaPromise) {
    ensureImportTrackingSchemaPromise = (async () => {
      const [batchCols] = await pool.query("SHOW COLUMNS FROM budget_transactions LIKE 'import_batch_id'");
      if (!batchCols.length) {
        await pool.query(
          "ALTER TABLE budget_transactions ADD COLUMN import_batch_id VARCHAR(64) NULL AFTER project_id"
        );
      }

      const [sourceCols] = await pool.query("SHOW COLUMNS FROM budget_transactions LIKE 'import_source_name'");
      if (!sourceCols.length) {
        await pool.query(
          "ALTER TABLE budget_transactions ADD COLUMN import_source_name VARCHAR(255) NULL AFTER import_batch_id"
        );
      }

      const [indexRows] = await pool.query("SHOW INDEX FROM budget_transactions WHERE Key_name = 'idx_budget_transactions_import_batch'");
      if (!indexRows.length) {
        await pool.query(
          "ALTER TABLE budget_transactions ADD INDEX idx_budget_transactions_import_batch (import_batch_id)"
        );
      }
    })().catch((error) => {
      ensureImportTrackingSchemaPromise = null;
      throw error;
    });
  }

  return ensureImportTrackingSchemaPromise;
}

async function fetchAccount(id, connection = pool) {
  const [rows] = await connection.query(
    `SELECT a.*,
            u.name AS created_by_name,
            COALESCE(SUM(CASE WHEN t.type='in'  THEN t.amount ELSE 0 END), 0) AS total_in,
            COALESCE(SUM(CASE WHEN t.type='out' THEN t.amount ELSE 0 END), 0) AS total_out,
            COALESCE(SUM(CASE WHEN t.type='in'  THEN t.amount ELSE -t.amount END), 0) AS balance,
            COUNT(t.id) AS transaction_count
       FROM budget_accounts a
       LEFT JOIN users u ON u.id = a.created_by
       LEFT JOIN budget_transactions t ON t.account_id = a.id
      WHERE a.id = ?
      GROUP BY a.id
      LIMIT 1`,
    [id]
  );
  return serializeAccount(rows[0] || null);
}

async function fetchTransaction(id, connection = pool) {
  const [rows] = await connection.query(
    `SELECT t.*,
            a.name AS account_name,
            a.type AS account_type,
            p.project_name,
            c.name AS customer_name,
            u.name AS created_by_name
       FROM budget_transactions t
       JOIN budget_accounts a ON a.id = t.account_id
       LEFT JOIN customer_projects p ON p.id = t.project_id
       LEFT JOIN customers c ON c.id = p.customer_id
       LEFT JOIN users u ON u.id = t.created_by
      WHERE t.id = ?
      LIMIT 1`,
    [id]
  );
  return serializeTransaction(rows[0] || null);
}

// ── Accounts ─────────────────────────────────────────────────────────────────

exports.listAccounts = async (req, res) => {
  const active = String(req.query.active || "all").toLowerCase();
  const where = [];
  const params = [];

  if (active !== "all") {
    where.push("a.is_active = ?");
    params.push(active === "0" || active === "inactive" ? 0 : 1);
  }

  const [rows] = await pool.query(
    `SELECT a.*,
            u.name AS created_by_name,
            COALESCE(SUM(CASE WHEN t.type='in'  THEN t.amount ELSE 0 END), 0) AS total_in,
            COALESCE(SUM(CASE WHEN t.type='out' THEN t.amount ELSE -t.amount END), 0) AS balance,
            COALESCE(SUM(CASE WHEN t.type='out' THEN t.amount ELSE 0 END), 0) AS total_out,
            COUNT(t.id) AS transaction_count
       FROM budget_accounts a
       LEFT JOIN users u ON u.id = a.created_by
       LEFT JOIN budget_transactions t ON t.account_id = a.id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY a.id
      ORDER BY a.type ASC, a.name ASC`,
    params
  );

  return res.json(rows.map(serializeAccount));
};

exports.createAccount = async (req, res) => {
  const name = cleanText(req.body.name, 120);
  const type = ["income", "expense"].includes(req.body.type) ? req.body.type : "expense";
  const description = cleanText(req.body.description, 500);
  const isActive = toFlag(req.body.isActive, true) ? 1 : 0;

  if (!name) return res.status(400).json({ message: "name is required" });

  try {
    const [result] = await pool.query(
      "INSERT INTO budget_accounts (name, type, description, is_active, created_by) VALUES (?,?,?,?,?)",
      [name, type, description, isActive, req.user.id]
    );
    const created = await fetchAccount(result.insertId);
    await safeLogAudit({
      userId: req.user.id, actorName: req.user.name, module: "BUDGET",
      action: "ACCOUNT_CREATED",
      details: `Account "${name}" (${type}) created.`,
      ipAddress: getRequestIp(req)
    });
    return res.status(201).json(created);
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "An account with that name already exists." });
    }
    throw error;
  }
};

exports.updateAccount = async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid id" });

  const existing = await fetchAccount(id);
  if (!existing) return res.status(404).json({ message: "Account not found" });

  const name = Object.prototype.hasOwnProperty.call(req.body, "name")
    ? cleanText(req.body.name, 120)
    : existing.name;
  const type = Object.prototype.hasOwnProperty.call(req.body, "type")
    ? (["income", "expense"].includes(req.body.type) ? req.body.type : existing.type)
    : existing.type;
  const description = Object.prototype.hasOwnProperty.call(req.body, "description")
    ? cleanText(req.body.description, 500)
    : existing.description;
  const isActive = Object.prototype.hasOwnProperty.call(req.body, "isActive")
    ? (toFlag(req.body.isActive, true) ? 1 : 0)
    : Number(existing.is_active) === 1 ? 1 : 0;

  if (!name) return res.status(400).json({ message: "name is required" });

  try {
    await pool.query(
      "UPDATE budget_accounts SET name=?, type=?, description=?, is_active=? WHERE id=?",
      [name, type, description, isActive, id]
    );
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "An account with that name already exists." });
    }
    throw error;
  }

  const updated = await fetchAccount(id);
  const changes = [
    describeAuditChange("Name", existing.name, updated.name),
    describeAuditChange("Type", existing.type, updated.type),
    describeAuditChange("Description", existing.description, updated.description),
    describeAuditChange("Status", existing.is_active ? "active" : "inactive", updated.is_active ? "active" : "inactive")
  ].filter(Boolean);

  await safeLogAudit({
    userId: req.user.id, actorName: req.user.name, module: "BUDGET",
    action: "ACCOUNT_UPDATED",
    details: changes.length ? `Account "${updated.name}" updated. ${changes.join("; ")}.` : `Account "${updated.name}" saved with no changes.`,
    ipAddress: getRequestIp(req)
  });

  return res.json(updated);
};

exports.deleteAccount = async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid id" });

  const existing = await fetchAccount(id);
  if (!existing) return res.status(404).json({ message: "Account not found" });

  if (existing.transaction_count > 0) {
    await pool.query("UPDATE budget_accounts SET is_active=0 WHERE id=?", [id]);
    await safeLogAudit({
      userId: req.user.id, actorName: req.user.name, module: "BUDGET",
      action: "ACCOUNT_DEACTIVATED",
      details: `Account "${existing.name}" deactivated (has ${existing.transaction_count} transactions).`,
      ipAddress: getRequestIp(req)
    });
    return res.json({ success: true, deactivated: true });
  }

  await pool.query("DELETE FROM budget_accounts WHERE id=?", [id]);
  await safeLogAudit({
    userId: req.user.id, actorName: req.user.name, module: "BUDGET",
    action: "ACCOUNT_DELETED",
    details: `Account "${existing.name}" deleted.`,
    ipAddress: getRequestIp(req)
  });
  return res.json({ success: true, deactivated: false });
};

// ── Transactions ──────────────────────────────────────────────────────────────

exports.listTransactions = async (req, res) => {
  await ensureImportTrackingSchema();

  const accountId = Number(req.query.accountId || 0);
  const projectId = Number(req.query.projectId || 0);
  const type = String(req.query.type || "").toLowerCase();
  const dateFrom = normalizeDate(req.query.dateFrom);
  const dateTo = normalizeDate(req.query.dateTo);
  const q = String(req.query.q || "").trim();
  const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);

  const where = [];
  const params = [];

  if (accountId > 0) { where.push("t.account_id = ?"); params.push(accountId); }
  if (projectId > 0) { where.push("t.project_id = ?"); params.push(projectId); }
  if (type === "in" || type === "out") { where.push("t.type = ?"); params.push(type); }
  if (dateFrom) { where.push("t.transaction_date >= ?"); params.push(dateFrom); }
  if (dateTo)   { where.push("t.transaction_date <= ?"); params.push(dateTo); }
  if (q) {
    const like = `%${q}%`;
    where.push("(t.description LIKE ? OR t.reference_no LIKE ? OR t.notes LIKE ? OR a.name LIKE ?)");
    params.push(like, like, like, like);
  }

  const [rows] = await pool.query(
    `SELECT t.*,
            a.name AS account_name,
            a.type AS account_type,
            p.project_name,
            c.name AS customer_name,
            u.name AS created_by_name
       FROM budget_transactions t
       JOIN budget_accounts a ON a.id = t.account_id
       LEFT JOIN customer_projects p ON p.id = t.project_id
       LEFT JOIN customers c ON c.id = p.customer_id
       LEFT JOIN users u ON u.id = t.created_by
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY t.transaction_date DESC, t.id DESC
      LIMIT ${limit}`,
    params
  );

  return res.json(rows.map(serializeTransaction));
};

exports.createTransaction = async (req, res) => {
  await ensureImportTrackingSchema();

  const accountId = Number(req.body.accountId || 0);
  if (!accountId) return res.status(400).json({ message: "accountId is required" });

  const type = ["in", "out"].includes(req.body.type) ? req.body.type : null;
  if (!type) return res.status(400).json({ message: "type must be 'in' or 'out'" });

  const amount = toNumber(req.body.amount, 0);
  if (amount <= 0) return res.status(400).json({ message: "amount must be greater than zero" });

  const transactionDate = normalizeDate(req.body.transactionDate) || normalizeDate(new Date().toISOString());
  if (!transactionDate) return res.status(400).json({ message: "Invalid transactionDate" });

  const description = cleanText(req.body.description, 500);
  const referenceNo = cleanText(req.body.referenceNo, 100);
  const notes = cleanText(req.body.notes, 4000);
  const projectId = Number(req.body.projectId || 0) || null;

  const [accountRows] = await pool.query("SELECT * FROM budget_accounts WHERE id=? LIMIT 1", [accountId]);
  if (!accountRows.length) return res.status(404).json({ message: "Account not found" });

  if (projectId) {
    const [projectRows] = await pool.query("SELECT id FROM customer_projects WHERE id=? LIMIT 1", [projectId]);
    if (!projectRows.length) return res.status(404).json({ message: "Project not found" });
  }

  const [result] = await pool.query(
    `INSERT INTO budget_transactions
       (account_id, type, amount, description, reference_no, transaction_date, notes, project_id, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [accountId, type, amount, description, referenceNo, transactionDate, notes, projectId, req.user.id]
  );

  const created = await fetchTransaction(result.insertId);
  await safeLogAudit({
    userId: req.user.id, actorName: req.user.name, module: "BUDGET",
    action: "TRANSACTION_CREATED",
    details: `${type === "in" ? "Income" : "Expense"} of ${formatAuditValue(amount)} recorded under "${accountRows[0].name}". Ref: ${formatAuditValue(referenceNo)}.`,
    ipAddress: getRequestIp(req)
  });

  return res.status(201).json(created);
};

exports.updateTransaction = async (req, res) => {
  await ensureImportTrackingSchema();

  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid id" });

  const existing = await fetchTransaction(id);
  if (!existing) return res.status(404).json({ message: "Transaction not found" });

  const type = Object.prototype.hasOwnProperty.call(req.body, "type")
    ? (["in", "out"].includes(req.body.type) ? req.body.type : existing.type)
    : existing.type;
  const amount = Object.prototype.hasOwnProperty.call(req.body, "amount")
    ? toNumber(req.body.amount, 0)
    : toNumber(existing.amount, 0);
  if (amount <= 0) return res.status(400).json({ message: "amount must be greater than zero" });

  const transactionDate = Object.prototype.hasOwnProperty.call(req.body, "transactionDate")
    ? normalizeDate(req.body.transactionDate)
    : existing.transaction_date;
  if (!transactionDate) return res.status(400).json({ message: "Invalid transactionDate" });

  const description = Object.prototype.hasOwnProperty.call(req.body, "description")
    ? cleanText(req.body.description, 500)
    : existing.description;
  const referenceNo = Object.prototype.hasOwnProperty.call(req.body, "referenceNo")
    ? cleanText(req.body.referenceNo, 100)
    : existing.reference_no;
  const notes = Object.prototype.hasOwnProperty.call(req.body, "notes")
    ? cleanText(req.body.notes, 4000)
    : existing.notes;
  const accountId = Object.prototype.hasOwnProperty.call(req.body, "accountId")
    ? Number(req.body.accountId || existing.account_id)
    : existing.account_id;
  const projectId = Object.prototype.hasOwnProperty.call(req.body, "projectId")
    ? (Number(req.body.projectId || 0) || null)
    : (Number(existing.project_id || 0) || null);

  if (projectId) {
    const [projectRows] = await pool.query("SELECT id FROM customer_projects WHERE id=? LIMIT 1", [projectId]);
    if (!projectRows.length) return res.status(404).json({ message: "Project not found" });
  }

  await pool.query(
    `UPDATE budget_transactions
        SET account_id=?, type=?, amount=?, description=?, reference_no=?, transaction_date=?, notes=?, project_id=?
      WHERE id=?`,
    [accountId, type, amount, description, referenceNo, transactionDate, notes, projectId, id]
  );

  const updated = await fetchTransaction(id);
  const changes = [
    describeAuditChange("Type", existing.type, updated.type),
    describeAuditChange("Amount", existing.amount, updated.amount),
    describeAuditChange("Date", existing.transaction_date, updated.transaction_date),
    describeAuditChange("Description", existing.description, updated.description),
    describeAuditChange("Reference", existing.reference_no, updated.reference_no),
    describeAuditChange("Project", existing.project_name, updated.project_name)
  ].filter(Boolean);

  await safeLogAudit({
    userId: req.user.id, actorName: req.user.name, module: "BUDGET",
    action: "TRANSACTION_UPDATED",
    details: changes.length ? `Transaction #${id} updated. ${changes.join("; ")}.` : `Transaction #${id} saved with no changes.`,
    ipAddress: getRequestIp(req)
  });

  return res.json(updated);
};

exports.deleteTransaction = async (req, res) => {
  await ensureImportTrackingSchema();

  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid id" });

  const existing = await fetchTransaction(id);
  if (!existing) return res.status(404).json({ message: "Transaction not found" });

  await pool.query("DELETE FROM budget_transactions WHERE id=?", [id]);

  await safeLogAudit({
    userId: req.user.id, actorName: req.user.name, module: "BUDGET",
    action: "TRANSACTION_DELETED",
    details: `Transaction #${id} (${existing.type === "in" ? "income" : "expense"} of ${formatAuditValue(existing.amount)}) deleted from "${existing.account_name}".`,
    ipAddress: getRequestIp(req)
  });

  return res.json({ success: true });
};

exports.bulkDeleteTransactions = async (req, res) => {
  await ensureImportTrackingSchema();

  const ids = Array.from(new Set(
    (Array.isArray(req.body.transactionIds) ? req.body.transactionIds : [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)
  )).slice(0, 500);

  if (!ids.length) {
    return res.status(400).json({ message: "Select at least one transaction." });
  }

  const placeholders = ids.map(() => "?").join(",");
  const [existingRows] = await pool.query(
    `SELECT t.id, t.type, t.amount, a.name AS account_name
       FROM budget_transactions t
       JOIN budget_accounts a ON a.id = t.account_id
      WHERE t.id IN (${placeholders})`,
    ids
  );

  if (!existingRows.length) {
    return res.status(404).json({ message: "No matching transactions found." });
  }

  const [result] = await pool.query(
    `DELETE FROM budget_transactions WHERE id IN (${placeholders})`,
    ids
  );

  await safeLogAudit({
    userId: req.user.id, actorName: req.user.name, module: "BUDGET",
    action: "TRANSACTIONS_BULK_DELETED",
    details: `${result.affectedRows} transaction(s) deleted. IDs: ${existingRows.map((row) => row.id).join(", ")}.`,
    ipAddress: getRequestIp(req)
  });

  return res.json({ success: true, deleted: result.affectedRows });
};

exports.bulkAssignProject = async (req, res) => {
  await ensureImportTrackingSchema();

  const ids = Array.from(new Set(
    (Array.isArray(req.body.transactionIds) ? req.body.transactionIds : [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)
  )).slice(0, 500);

  if (!ids.length) {
    return res.status(400).json({ message: "Select at least one transaction." });
  }

  const projectId = Number(req.body.projectId || 0) || null;
  let projectName = null;

  if (projectId) {
    const [projectRows] = await pool.query(
      `SELECT p.id, p.project_name, c.name AS customer_name
         FROM customer_projects p
         JOIN customers c ON c.id = p.customer_id
        WHERE p.id=?
        LIMIT 1`,
      [projectId]
    );
    if (!projectRows.length) return res.status(404).json({ message: "Project not found" });
    projectName = `${projectRows[0].customer_name} - ${projectRows[0].project_name}`;
  }

  const placeholders = ids.map(() => "?").join(",");
  const [result] = await pool.query(
    `UPDATE budget_transactions
        SET project_id=?
      WHERE id IN (${placeholders})`,
    [projectId, ...ids]
  );

  await safeLogAudit({
    userId: req.user.id, actorName: req.user.name, module: "BUDGET",
    action: "TRANSACTIONS_PROJECT_ASSIGNED",
    details: `${result.affectedRows} transaction(s) ${projectId ? `assigned to ${formatAuditValue(projectName)}` : "unassigned from project"}.`,
    ipAddress: getRequestIp(req)
  });

  return res.json({ success: true, updated: result.affectedRows, projectId });
};

// ── Summary ───────────────────────────────────────────────────────────────────

exports.summary = async (req, res) => {
  await ensureImportTrackingSchema();

  const projectId = Number(req.query.projectId || 0);
  const dateFrom = normalizeDate(req.query.dateFrom);
  const dateTo   = normalizeDate(req.query.dateTo);

  const where = [];
  const params = [];
  if (projectId > 0) { where.push("t.project_id = ?"); params.push(projectId); }
  if (dateFrom) { where.push("t.transaction_date >= ?"); params.push(dateFrom); }
  if (dateTo)   { where.push("t.transaction_date <= ?"); params.push(dateTo); }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rows] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN t.type='in'  THEN t.amount ELSE 0 END), 0) AS total_in,
       COALESCE(SUM(CASE WHEN t.type='out' THEN t.amount ELSE 0 END), 0) AS total_out,
       COALESCE(SUM(CASE WHEN t.type='in'  THEN t.amount ELSE -t.amount END), 0) AS net_balance,
       COUNT(t.id) AS transaction_count
     FROM budget_transactions t
     ${whereClause}`,
    params
  );

  const [accountRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM budget_accounts WHERE is_active=1"
  );
  const [budgetRows] = await pool.query(
    "SELECT COALESCE(SUM(sale_amount), 0) AS total_budget FROM customer_projects"
  );

  const payload = {
    totalIn: toNumber(rows[0]?.total_in, 0),
    totalOut: toNumber(rows[0]?.total_out, 0),
    netBalance: toNumber(rows[0]?.net_balance, 0),
    transactionCount: toNumber(rows[0]?.transaction_count, 0),
    activeAccounts: toNumber(accountRows[0]?.total, 0),
    totalBudget: toNumber(budgetRows[0]?.total_budget, 0)
  };

  if (projectId > 0) {
    const [projectRows] = await pool.query(
      `SELECT p.sale_amount, p.project_name, c.name AS customer_name
         FROM customer_projects p
         JOIN customers c ON c.id = p.customer_id
        WHERE p.id=?
        LIMIT 1`,
      [projectId]
    );
    if (projectRows.length) {
      const projectBudget = toNumber(projectRows[0].sale_amount, 0);
      const collectedIncome = payload.totalIn;
      payload.projectId = projectId;
      payload.projectName = projectRows[0].project_name;
      payload.customerName = projectRows[0].customer_name;
      payload.projectBudget = projectBudget;
      payload.projectedIncome = projectBudget;
      payload.collectedIncome = collectedIncome;
      payload.balanceDue = Math.max(0, projectBudget - collectedIncome);
      payload.contractMargin = projectBudget - payload.totalOut;
      payload.totalIn = projectBudget;
      payload.netBalance = collectedIncome - payload.totalOut;
    }
  } else {
    payload.totalIn = payload.totalBudget;
    payload.netBalance = payload.totalIn - payload.totalOut;
  }

  return res.json(payload);
};

// ── Excel Import ──────────────────────────────────────────────────────────────

function parseExcelDate(value) {
  if (!value && value !== 0) return null;
  // Excel serial number
  if (typeof value === "number") {
    const date = XLSX.SSF.parse_date_code(value);
    if (!date) return null;
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.y}-${pad(date.m)}-${pad(date.d)}`;
  }
  // String date
  const text = String(value).trim();
  if (!text) return null;
  // Try MM/DD/YYYY or M/D/YYYY
  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, m, d, y] = slash;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // Try YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
  }
  return null;
}

function parseRows(sheet) {
  // Convert sheet to array-of-arrays (raw values, no headers)
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

  // Find the header row — look for a row containing "expense" or "description" or "price"
  let headerRowIndex = -1;
  for (let i = 0; i < Math.min(aoa.length, 10); i++) {
    const row = aoa[i];
    if (!Array.isArray(row)) continue;
    const joined = row.map((c) => String(c || "").toLowerCase()).join("|");
    if (joined.includes("expense") || joined.includes("description") || joined.includes("price")) {
      headerRowIndex = i;
      break;
    }
  }

  // Detect column indices from header row
  let colNo = -1, colDate = -1, colDesc = -1, colPrice = -1, colQty = -1, colSubtotal = -1, colAmount = -1;

  if (headerRowIndex >= 0) {
    const hrow = aoa[headerRowIndex].map((c) => String(c || "").toLowerCase().trim());
    hrow.forEach((h, i) => {
      if (/^no\.?$|^#$|^num/.test(h)) colNo = i;
      else if (/date/.test(h)) colDate = i;
      else if (/expense|description|item|particulars/.test(h)) colDesc = i;
      else if (/^sub\s*total$|^subtotal$|^line\s*total$|^line\s*amount$/.test(h)) colSubtotal = i;
      else if (/^price$|^unit.?price/.test(h)) colPrice = i;
      else if (/^amount$|^cost$/.test(h)) colAmount = i;
      else if (/^qty$|^quantity$/.test(h)) colQty = i;
    });
    if (colPrice === -1 && colAmount >= 0) colPrice = colAmount;
    // Fallback: if no amount-like column was found, take the first numeric-looking col after desc.
    if (colSubtotal === -1 && colPrice === -1 && colDesc >= 0) colPrice = colDesc + 1;
  }

  // If we couldn't find headers, guess by position (matches the screenshot layout):
  // Col A=No, B=Date, C=Expenses, D=Price, E=Qty, F=Sub Total
  if (colDesc === -1) {
    colNo = 0; colDate = 1; colDesc = 2; colPrice = 3; colQty = 4; colSubtotal = 5;
  }

  const dataStart = headerRowIndex >= 0 ? headerRowIndex + 1 : 1;
  const results = [];
  let lastDate = null;

  for (let i = dataStart; i < aoa.length; i++) {
    const row = aoa[i];
    if (!Array.isArray(row)) continue;

    const rawDesc = colDesc >= 0 ? row[colDesc] : null;
    const desc = String(rawDesc || "").trim();
    if (!desc) continue; // blank description row → skip

    const rawDate = colDate >= 0 ? row[colDate] : null;
    const parsedDate = parseExcelDate(rawDate);
    if (parsedDate) lastDate = parsedDate;
    const txDate = lastDate || new Date().toISOString().slice(0, 10);

    const subtotal = colSubtotal >= 0 ? toNumber(row[colSubtotal], 0) : 0;
    const rawPrice = colPrice >= 0 ? row[colPrice] : null;
    const price = toNumber(rawPrice, 0);
    const rawQty = colQty >= 0 ? row[colQty] : null;
    const qty = Math.max(1, toNumber(rawQty, 1));

    const amount = Math.round((subtotal > 0 ? subtotal : price * qty) * 100) / 100;
    if (amount <= 0) continue; // no amount -> skip

    results.push({ description: desc.slice(0, 500), amount, transactionDate: txDate });
  }

  return results;
}

exports.importExcel = async (req, res) => {
  await ensureImportTrackingSchema();

  if (!req.file) {
    return res.status(400).json({ message: "Excel file is required." });
  }

  const accountId = Number(req.body.accountId || 0);
  const type = ["in", "out"].includes(req.body.type) ? req.body.type : "out";
  const projectId = Number(req.body.projectId || 0) || null;

  if (!accountId) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ message: "accountId is required." });
  }

  const [accountRows] = await pool.query("SELECT * FROM budget_accounts WHERE id=? LIMIT 1", [accountId]);
  if (!accountRows.length) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ message: "Account not found." });
  }

  if (projectId) {
    const [projRows] = await pool.query("SELECT id FROM customer_projects WHERE id=? LIMIT 1", [projectId]);
    if (!projRows.length) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      return res.status(404).json({ message: "Project not found." });
    }
  }

  let rows;
  const importBatchId = `imp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const importSourceName = cleanText(req.file.originalname, 255) || req.file.filename || "Imported Excel";
  try {
    const workbook = XLSX.readFile(req.file.path, { cellDates: false });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    rows = parseRows(sheet);
  } catch (err) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ message: "Could not read the Excel file. Make sure it is a valid .xlsx or .xls file." });
  } finally {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
  }

  if (!rows.length) {
    return res.status(400).json({ message: "No valid rows were found in the file. Make sure it has Description, Price, and Qty columns." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const createdTransactions = [];
    for (const row of rows) {
      const [result] = await connection.query(
        `INSERT INTO budget_transactions
           (account_id, type, amount, description, transaction_date, project_id, import_batch_id, import_source_name, created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [accountId, type, row.amount, row.description, row.transactionDate, projectId, importBatchId, importSourceName, req.user.id]
      );
      const created = await fetchTransaction(result.insertId, connection);
      if (created) createdTransactions.push(created);
    }
    await connection.commit();

    await safeLogAudit({
      userId: req.user.id, actorName: req.user.name, module: "BUDGET",
      action: "EXCEL_IMPORTED",
      details: `${createdTransactions.length} transaction(s) imported into "${accountRows[0].name}" from Excel.`,
      ipAddress: getRequestIp(req)
    });

    connection.release();
    return res.status(201).json({
      importBatchId,
      importSourceName,
      imported: createdTransactions.length,
      rows,
      transactions: createdTransactions
    });
  } catch (err) {
    await connection.rollback();
    connection.release();
    throw err;
  }
};

exports.listImportBatches = async (_req, res) => {
  await ensureImportTrackingSchema();

  const [rows] = await pool.query(
    `SELECT
       t.import_batch_id AS import_batch_id,
       MAX(t.import_source_name) AS import_source_name,
       COUNT(*) AS transaction_count,
       COALESCE(SUM(t.amount), 0) AS total_amount,
       MAX(t.transaction_date) AS latest_transaction_date,
       MAX(t.created_at) AS imported_at
     FROM budget_transactions t
     WHERE t.import_batch_id IS NOT NULL
     GROUP BY t.import_batch_id
     ORDER BY imported_at DESC, import_batch_id DESC
     LIMIT 30`
  );

  return res.json(rows.map((row) => ({
    import_batch_id: row.import_batch_id,
    import_source_name: row.import_source_name,
    transaction_count: toNumber(row.transaction_count, 0),
    total_amount: formatMoney(row.total_amount),
    latest_transaction_date: row.latest_transaction_date,
    imported_at: row.imported_at
  })));
};

exports.deleteImportBatch = async (req, res) => {
  await ensureImportTrackingSchema();

  const batchId = cleanText(req.params.batchId, 64);
  if (!batchId) return res.status(400).json({ message: "Invalid import batch." });

  const [existingRows] = await pool.query(
    `SELECT id, import_source_name
       FROM budget_transactions
      WHERE import_batch_id = ?`,
    [batchId]
  );

  if (!existingRows.length) {
    return res.status(404).json({ message: "Imported Excel batch not found." });
  }

  const [result] = await pool.query(
    "DELETE FROM budget_transactions WHERE import_batch_id = ?",
    [batchId]
  );

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "BUDGET",
    action: "IMPORT_BATCH_DELETED",
    details: `Imported Excel "${existingRows[0].import_source_name || batchId}" deleted with ${result.affectedRows} transaction(s).`,
    ipAddress: getRequestIp(req)
  });

  return res.json({ success: true, deleted: result.affectedRows, importBatchId: batchId });
};
