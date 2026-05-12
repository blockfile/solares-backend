const fs = require("fs");
const pool = require("../config/db");
const { describeAuditChange, formatAuditValue, getRequestIp, safeLogAudit } = require("../services/audit");
const { buildBudgetRawLogsWorkbook } = require("../services/budgetExcelExport");
const { excelSerialToDate, readWorkbookRows } = require("../services/workbookReader");

const ACCOUNT_TYPES = new Set(["income", "expense", "investment", "withdrawal"]);
const ACCOUNT_TYPE_DIRECTIONS = {
  income: "in",
  investment: "in",
  expense: "out",
  withdrawal: "out"
};

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

function formatMoney(value) {
  return toNumber(value, 0);
}

function sanitizeFilenamePart(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function setDownloadFilename(res, filename) {
  const safeName = sanitizeFilenamePart(filename).replace(/"/g, "");
  const fallbackName = safeName || "financial-raw-logs.xlsx";
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(fallbackName)}`
  );
}

function roundAmount(value, fallback = 0) {
  return Math.round(toNumber(value, fallback) * 100) / 100;
}

function nullableNumber(value) {
  if (value == null || value === "") return null;
  const n = toNumber(value, NaN);
  return Number.isFinite(n) ? n : null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function normalizeTransactionDirection(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "in" || normalized === "out") return normalized;
  return ACCOUNT_TYPE_DIRECTIONS[normalized] || null;
}

function transactionDirectionForAccount(account, fallback = null) {
  return ACCOUNT_TYPE_DIRECTIONS[String(account?.type || "").toLowerCase()] || fallback;
}

function transactionLineHasValue(line) {
  return ["description", "price", "quantity", "qty", "discount", "amount", "notes"].some((field) => {
    const value = line?.[field];
    return value != null && String(value).trim() !== "";
  });
}

function normalizeTransactionLine(line, index = 0) {
  const label = index > 0 ? `Line ${index + 1}: ` : "";
  const price = hasOwn(line, "price") ? nullableNumber(line.price) : null;
  const quantity = hasOwn(line, "quantity")
    ? nullableNumber(line.quantity)
    : hasOwn(line, "qty")
      ? nullableNumber(line.qty)
      : null;
  const discount = hasOwn(line, "discount") ? nullableNumber(line.discount) : null;
  const discountAmount = discount == null ? 0 : roundAmount(discount);

  if (price != null && price < 0) return { error: `${label}price cannot be negative` };
  if (quantity != null && quantity < 0) return { error: `${label}quantity cannot be negative` };
  if (discount != null && discount < 0) return { error: `${label}discount cannot be negative` };

  const grossAmount = price != null && quantity != null && price > 0 && quantity > 0
    ? roundAmount(price * quantity)
    : null;
  if (grossAmount != null && discountAmount >= grossAmount) {
    return { error: `${label}discount must be less than price times quantity` };
  }

  const computedAmount = grossAmount != null ? roundAmount(grossAmount - discountAmount) : 0;
  const amount = grossAmount != null
    ? computedAmount
    : hasOwn(line, "amount")
      ? roundAmount(line.amount, computedAmount)
      : computedAmount;

  if (amount <= 0) return { error: `${label}amount must be greater than zero` };

  return {
    value: {
      price,
      quantity,
      discount: discount == null ? null : discountAmount,
      amount,
      description: cleanText(line.description, 500),
      notes: cleanText(line.notes, 4000)
    }
  };
}

function decimalColumnMatches(column, precision, scale, nullable) {
  const match = String(column?.Type || "").match(/^decimal\((\d+),(\d+)\)$/i);
  if (!match) return false;
  return Number(match[1]) === precision
    && Number(match[2]) === scale
    && (String(column?.Null || "").toUpperCase() === "YES") === nullable;
}

async function ensureDecimalColumn({ name, definition, precision, scale, nullable, after }) {
  const [cols] = await pool.query(`SHOW COLUMNS FROM budget_transactions LIKE '${name}'`);
  if (!cols.length) {
    await pool.query(
      `ALTER TABLE budget_transactions ADD COLUMN ${name} ${definition}${after ? ` AFTER ${after}` : ""}`
    );
    return;
  }

  if (!decimalColumnMatches(cols[0], precision, scale, nullable)) {
    await pool.query(`ALTER TABLE budget_transactions MODIFY COLUMN ${name} ${definition}`);
  }
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
    price: row.price == null ? null : formatMoney(row.price),
    quantity: row.quantity == null ? null : toNumber(row.quantity, 0),
    discount: row.discount == null ? null : formatMoney(row.discount),
    transaction_date: formatSqlDate(row.transaction_date),
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

      await ensureDecimalColumn({
        name: "amount",
        definition: "DECIMAL(14,2) NOT NULL DEFAULT 0.00",
        precision: 14,
        scale: 2,
        nullable: false
      });
      await ensureDecimalColumn({
        name: "price",
        definition: "DECIMAL(14,4) NULL",
        precision: 14,
        scale: 4,
        nullable: true,
        after: "amount"
      });
      await ensureDecimalColumn({
        name: "quantity",
        definition: "DECIMAL(12,4) NULL",
        precision: 12,
        scale: 4,
        nullable: true,
        after: "price"
      });
      await ensureDecimalColumn({
        name: "discount",
        definition: "DECIMAL(14,2) NULL",
        precision: 14,
        scale: 2,
        nullable: true,
        after: "quantity"
      });

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

function parseTransactionFilters(query = {}, { defaultLimit = 200, maxLimit = 500 } = {}) {
  const requestedLimit = Number(query.limit || defaultLimit);
  return {
    accountId: Number(query.accountId || 0),
    projectId: Number(query.projectId || 0),
    type: String(query.type || "").toLowerCase(),
    dateFrom: normalizeDate(query.dateFrom),
    dateTo: normalizeDate(query.dateTo),
    q: String(query.q || "").trim(),
    limit: Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : defaultLimit, 1), maxLimit)
  };
}

function buildTransactionWhere(filters) {
  const where = [];
  const params = [];

  if (filters.accountId > 0) { where.push("t.account_id = ?"); params.push(filters.accountId); }
  if (filters.projectId > 0) { where.push("t.project_id = ?"); params.push(filters.projectId); }
  if (ACCOUNT_TYPES.has(filters.type)) {
    where.push("a.type = ?");
    params.push(filters.type);
  } else if (filters.type === "in" || filters.type === "out") {
    where.push("t.type = ?");
    params.push(filters.type);
  }
  if (filters.dateFrom) { where.push("t.transaction_date >= ?"); params.push(filters.dateFrom); }
  if (filters.dateTo)   { where.push("t.transaction_date <= ?"); params.push(filters.dateTo); }
  if (filters.q) {
    const like = `%${filters.q}%`;
    where.push("(t.description LIKE ? OR t.reference_no LIKE ? OR t.notes LIKE ? OR a.name LIKE ? OR p.project_name LIKE ? OR c.name LIKE ?)");
    params.push(like, like, like, like, like, like);
  }

  return { where, params };
}

async function fetchTransactionRows(filters) {
  const { where, params } = buildTransactionWhere(filters);

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
      LIMIT ${filters.limit}`,
    params
  );

  return rows;
}

async function describeTransactionFilters(filters) {
  const exportFilters = {
    type: filters.type,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    q: filters.q,
    limit: filters.limit
  };

  if (filters.accountId > 0) {
    const [rows] = await pool.query("SELECT name FROM budget_accounts WHERE id=? LIMIT 1", [filters.accountId]);
    exportFilters.accountName = rows[0]?.name || `Account #${filters.accountId}`;
  }

  if (filters.projectId > 0) {
    const [rows] = await pool.query(
      `SELECT p.project_name, c.name AS customer_name
         FROM customer_projects p
         LEFT JOIN customers c ON c.id = p.customer_id
        WHERE p.id=?
        LIMIT 1`,
      [filters.projectId]
    );
    exportFilters.projectName = rows[0]?.project_name || `Project #${filters.projectId}`;
    exportFilters.customerName = rows[0]?.customer_name || "";
  }

  return exportFilters;
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
  const type = ACCOUNT_TYPES.has(req.body.type) ? req.body.type : "expense";
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
    ? (ACCOUNT_TYPES.has(req.body.type) ? req.body.type : existing.type)
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

  const filters = parseTransactionFilters(req.query, { defaultLimit: 200, maxLimit: 500 });
  const rows = await fetchTransactionRows(filters);

  return res.json(rows.map(serializeTransaction));
};

exports.exportRawLogsExcel = async (req, res) => {
  await ensureImportTrackingSchema();

  const filters = parseTransactionFilters(req.query, { defaultLimit: 50000, maxLimit: 50000 });
  const rows = await fetchTransactionRows(filters);
  const exportFilters = await describeTransactionFilters(filters);
  const transactions = rows.map(serializeTransaction);
  const buffer = await buildBudgetRawLogsWorkbook({
    transactions,
    filters: exportFilters,
    exportedBy: req.user.name || req.user.username || ""
  });

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "BUDGET",
    action: "RAW_LOGS_EXPORTED",
    details: `${transactions.length} financial raw log transaction(s) exported to Excel.`,
    ipAddress: getRequestIp(req)
  });

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  setDownloadFilename(res, `financial-raw-logs-${stamp}.xlsx`);
  res.send(buffer);
};

exports.createTransaction = async (req, res) => {
  await ensureImportTrackingSchema();

  const accountId = Number(req.body.accountId || 0);
  if (!accountId) return res.status(400).json({ message: "accountId is required" });

  const [accountRows] = await pool.query("SELECT * FROM budget_accounts WHERE id=? LIMIT 1", [accountId]);
  if (!accountRows.length) return res.status(404).json({ message: "Account not found" });

  const type = transactionDirectionForAccount(accountRows[0], normalizeTransactionDirection(req.body.type));
  if (!type) return res.status(400).json({ message: "type must be 'in' or 'out'" });

  const transactionDate = normalizeDate(req.body.transactionDate) || normalizeDate(new Date().toISOString());
  if (!transactionDate) return res.status(400).json({ message: "Invalid transactionDate" });

  const referenceNo = cleanText(req.body.referenceNo, 100);
  const projectId = Number(req.body.projectId || 0) || null;
  const requestedLines = Array.isArray(req.body.items)
    ? req.body.items.filter(transactionLineHasValue).slice(0, 100)
    : [req.body];

  if (!requestedLines.length) {
    return res.status(400).json({ message: "Add at least one transaction line." });
  }

  const lines = [];
  for (let index = 0; index < requestedLines.length; index += 1) {
    const normalized = normalizeTransactionLine(requestedLines[index], index);
    if (normalized.error) return res.status(400).json({ message: normalized.error });
    lines.push(normalized.value);
  }

  if (projectId) {
    const [projectRows] = await pool.query("SELECT id FROM customer_projects WHERE id=? LIMIT 1", [projectId]);
    if (!projectRows.length) return res.status(404).json({ message: "Project not found" });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const createdTransactions = [];

    for (const line of lines) {
      const [result] = await connection.query(
        `INSERT INTO budget_transactions
           (account_id, type, amount, price, quantity, discount, description, reference_no, transaction_date, notes, project_id, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [accountId, type, line.amount, line.price, line.quantity, line.discount, line.description, referenceNo, transactionDate, line.notes, projectId, req.user.id]
      );
      const created = await fetchTransaction(result.insertId, connection);
      if (created) createdTransactions.push(created);
    }

    await connection.commit();
    connection.release();

    const totalAmount = lines.reduce((sum, line) => sum + toNumber(line.amount, 0), 0);
    await safeLogAudit({
      userId: req.user.id, actorName: req.user.name, module: "BUDGET",
      action: lines.length > 1 ? "TRANSACTIONS_CREATED" : "TRANSACTION_CREATED",
      details: lines.length > 1
        ? `${lines.length} ${type === "in" ? "income" : "expense"} transaction(s) totaling ${formatAuditValue(totalAmount)} recorded under "${accountRows[0].name}". Ref: ${formatAuditValue(referenceNo)}.`
        : `${type === "in" ? "Income" : "Expense"} of ${formatAuditValue(totalAmount)} recorded under "${accountRows[0].name}". Ref: ${formatAuditValue(referenceNo)}.`,
      ipAddress: getRequestIp(req)
    });

    if (Array.isArray(req.body.items)) {
      return res.status(201).json({
        created: createdTransactions.length,
        transactions: createdTransactions,
        totalAmount
      });
    }

    return res.status(201).json(createdTransactions[0]);
  } catch (error) {
    await connection.rollback();
    connection.release();
    throw error;
  }
};

exports.updateTransaction = async (req, res) => {
  await ensureImportTrackingSchema();

  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid id" });

  const existing = await fetchTransaction(id);
  if (!existing) return res.status(404).json({ message: "Transaction not found" });

  const accountId = Object.prototype.hasOwnProperty.call(req.body, "accountId")
    ? Number(req.body.accountId || existing.account_id)
    : existing.account_id;
  const [accountRows] = await pool.query("SELECT * FROM budget_accounts WHERE id=? LIMIT 1", [accountId]);
  if (!accountRows.length) return res.status(404).json({ message: "Account not found" });

  const requestedType = Object.prototype.hasOwnProperty.call(req.body, "type")
    ? normalizeTransactionDirection(req.body.type)
    : existing.type;
  const type = transactionDirectionForAccount(accountRows[0], requestedType) || existing.type;
  const price = Object.prototype.hasOwnProperty.call(req.body, "price")
    ? nullableNumber(req.body.price)
    : existing.price;
  const quantity = Object.prototype.hasOwnProperty.call(req.body, "quantity")
    ? nullableNumber(req.body.quantity)
    : Object.prototype.hasOwnProperty.call(req.body, "qty")
      ? nullableNumber(req.body.qty)
      : existing.quantity;
  const discount = Object.prototype.hasOwnProperty.call(req.body, "discount")
    ? nullableNumber(req.body.discount)
    : existing.discount;
  if (price != null && price < 0) return res.status(400).json({ message: "price cannot be negative" });
  if (quantity != null && quantity < 0) return res.status(400).json({ message: "quantity cannot be negative" });
  if (discount != null && discount < 0) return res.status(400).json({ message: "discount cannot be negative" });

  const grossAmount = price != null && quantity != null && price > 0 && quantity > 0
    ? roundAmount(price * quantity)
    : null;
  const discountAmount = discount == null ? 0 : roundAmount(discount);
  if (grossAmount != null && discountAmount >= grossAmount) {
    return res.status(400).json({ message: "discount must be less than price times quantity" });
  }
  const amount = grossAmount != null
    ? roundAmount(grossAmount - discountAmount)
    : Object.prototype.hasOwnProperty.call(req.body, "amount")
      ? roundAmount(req.body.amount)
      : roundAmount(existing.amount);
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
  const projectId = Object.prototype.hasOwnProperty.call(req.body, "projectId")
    ? (Number(req.body.projectId || 0) || null)
    : (Number(existing.project_id || 0) || null);

  if (projectId) {
    const [projectRows] = await pool.query("SELECT id FROM customer_projects WHERE id=? LIMIT 1", [projectId]);
    if (!projectRows.length) return res.status(404).json({ message: "Project not found" });
  }

  await pool.query(
    `UPDATE budget_transactions
        SET account_id=?, type=?, amount=?, price=?, quantity=?, discount=?, description=?, reference_no=?, transaction_date=?, notes=?, project_id=?
      WHERE id=?`,
    [accountId, type, amount, price, quantity, discount == null ? null : discountAmount, description, referenceNo, transactionDate, notes, projectId, id]
  );

  const updated = await fetchTransaction(id);
  const changes = [
    describeAuditChange("Type", existing.type, updated.type),
    describeAuditChange("Amount", existing.amount, updated.amount),
    describeAuditChange("Price", existing.price, updated.price),
    describeAuditChange("Qty", existing.quantity, updated.quantity),
    describeAuditChange("Discount", existing.discount, updated.discount),
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
         LEFT JOIN customers c ON c.id = p.customer_id
        WHERE p.id=?
        LIMIT 1`,
      [projectId]
    );
    if (!projectRows.length) return res.status(404).json({ message: "Project not found" });
    projectName = projectRows[0].customer_name ? `${projectRows[0].customer_name} - ${projectRows[0].project_name}` : projectRows[0].project_name;
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
         LEFT JOIN customers c ON c.id = p.customer_id
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
      payload.collectedIncome = collectedIncome;
      payload.balanceDue = Math.max(0, projectBudget - collectedIncome);
      payload.contractMargin = projectBudget - payload.totalOut;
      payload.netBalance = collectedIncome - payload.totalOut;
    }
  } else {
    payload.projectedRevenue = payload.totalBudget;
    // netBalance = actual collected cash minus actual expenses
    payload.netBalance = payload.totalIn - payload.totalOut;
  }

  return res.json(payload);
};

// ── Excel Import ──────────────────────────────────────────────────────────────

function parseExcelDate(value) {
  if (!value && value !== 0) return null;
  // Excel serial number
  if (typeof value === "number") {
    const pad = (n) => String(n).padStart(2, "0");
    const date = excelSerialToDate(value);
    if (!date || Number.isNaN(date.getTime())) return null;
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const pad = (n) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
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

function parseRows(aoa) {
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
  let colNo = -1, colDate = -1, colDesc = -1, colPrice = -1, colQty = -1, colDiscount = -1, colSubtotal = -1, colAmount = -1;

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
      else if (/discount|^disc\.?$/.test(h)) colDiscount = i;
    });
    if (colPrice === -1 && colAmount >= 0) colPrice = colAmount;
    // Fallback: if no amount-like column was found, take the first numeric-looking col after desc.
    if (colSubtotal === -1 && colPrice === -1 && colDesc >= 0) colPrice = colDesc + 1;
  }

  // If we couldn't find headers, guess by position (matches the common expense sheet layout).
  if (colDesc === -1) {
    const guessedHasDiscount = aoa
      .slice(1, 10)
      .some((row) => Array.isArray(row) && row.length > 6 && row[6] != null && String(row[6]).trim() !== "");
    colNo = 0; colDate = 1; colDesc = 2; colPrice = 3; colQty = 4;
    colDiscount = guessedHasDiscount ? 5 : -1;
    colSubtotal = guessedHasDiscount ? 6 : 5;
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
    const rawDiscount = colDiscount >= 0 ? row[colDiscount] : null;
    const discount = Math.max(0, roundAmount(toNumber(rawDiscount, 0)));

    const amount = roundAmount(subtotal > 0 ? subtotal : price * qty - discount);
    if (amount <= 0) continue; // no amount -> skip

    results.push({
      description: desc.slice(0, 500),
      price: price > 0 ? price : null,
      quantity: qty > 0 ? qty : null,
      discount: discount > 0 ? discount : null,
      amount,
      transactionDate: txDate
    });
  }

  return results;
}

exports.importExcel = async (req, res) => {
  await ensureImportTrackingSchema();

  if (!req.file) {
    return res.status(400).json({ message: "Excel file is required." });
  }

  const accountId = Number(req.body.accountId || 0);
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
  const type = transactionDirectionForAccount(accountRows[0], normalizeTransactionDirection(req.body.type) || "out");

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
    const workbook = await readWorkbookRows(req.file.path);
    rows = parseRows(workbook[0]?.rows || []);
  } catch (err) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ message: "Could not read the Excel file. Make sure it is a valid .xlsx file." });
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
           (account_id, type, amount, price, quantity, discount, description, transaction_date, project_id, import_batch_id, import_source_name, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [accountId, type, row.amount, row.price, row.quantity, row.discount, row.description, row.transactionDate, projectId, importBatchId, importSourceName, req.user.id]
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
