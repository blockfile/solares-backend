const fs = require("fs");
const XLSX = require("xlsx");
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
            u.name AS created_by_name
       FROM budget_transactions t
       JOIN budget_accounts a ON a.id = t.account_id
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
  const accountId = Number(req.query.accountId || 0);
  const type = String(req.query.type || "").toLowerCase();
  const dateFrom = normalizeDate(req.query.dateFrom);
  const dateTo = normalizeDate(req.query.dateTo);
  const q = String(req.query.q || "").trim();
  const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);

  const where = [];
  const params = [];

  if (accountId > 0) { where.push("t.account_id = ?"); params.push(accountId); }
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
            u.name AS created_by_name
       FROM budget_transactions t
       JOIN budget_accounts a ON a.id = t.account_id
       LEFT JOIN users u ON u.id = t.created_by
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY t.transaction_date DESC, t.id DESC
      LIMIT ${limit}`,
    params
  );

  return res.json(rows.map(serializeTransaction));
};

exports.createTransaction = async (req, res) => {
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

  const [accountRows] = await pool.query("SELECT * FROM budget_accounts WHERE id=? LIMIT 1", [accountId]);
  if (!accountRows.length) return res.status(404).json({ message: "Account not found" });

  const [result] = await pool.query(
    `INSERT INTO budget_transactions
       (account_id, type, amount, description, reference_no, transaction_date, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [accountId, type, amount, description, referenceNo, transactionDate, notes, req.user.id]
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

  await pool.query(
    `UPDATE budget_transactions
        SET account_id=?, type=?, amount=?, description=?, reference_no=?, transaction_date=?, notes=?
      WHERE id=?`,
    [accountId, type, amount, description, referenceNo, transactionDate, notes, id]
  );

  const updated = await fetchTransaction(id);
  const changes = [
    describeAuditChange("Type", existing.type, updated.type),
    describeAuditChange("Amount", existing.amount, updated.amount),
    describeAuditChange("Date", existing.transaction_date, updated.transaction_date),
    describeAuditChange("Description", existing.description, updated.description),
    describeAuditChange("Reference", existing.reference_no, updated.reference_no)
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

// ── Summary ───────────────────────────────────────────────────────────────────

exports.summary = async (req, res) => {
  const dateFrom = normalizeDate(req.query.dateFrom);
  const dateTo   = normalizeDate(req.query.dateTo);

  const where = [];
  const params = [];
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

  return res.json({
    totalIn: toNumber(rows[0]?.total_in, 0),
    totalOut: toNumber(rows[0]?.total_out, 0),
    netBalance: toNumber(rows[0]?.net_balance, 0),
    transactionCount: toNumber(rows[0]?.transaction_count, 0),
    activeAccounts: toNumber(accountRows[0]?.total, 0)
  });
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
  let colNo = -1, colDate = -1, colDesc = -1, colPrice = -1, colQty = -1;

  if (headerRowIndex >= 0) {
    const hrow = aoa[headerRowIndex].map((c) => String(c || "").toLowerCase().trim());
    hrow.forEach((h, i) => {
      if (/^no\.?$|^#$|^num/.test(h)) colNo = i;
      else if (/date/.test(h)) colDate = i;
      else if (/expense|description|item|particulars/.test(h)) colDesc = i;
      else if (/^price$|^unit.?price|^amount$/.test(h)) colPrice = i;
      else if (/^qty$|^quantity$/.test(h)) colQty = i;
    });
    // Fallback: if Price not found by name, take the first numeric-looking col after desc
    if (colPrice === -1 && colDesc >= 0) colPrice = colDesc + 1;
  }

  // If we couldn't find headers, guess by position (matches the screenshot layout):
  // Col A=No, B=Date, C=Expenses, D=Price, E=Qty
  if (colDesc === -1) {
    colNo = 0; colDate = 1; colDesc = 2; colPrice = 3; colQty = 4;
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

    const rawPrice = colPrice >= 0 ? row[colPrice] : null;
    const price = toNumber(rawPrice, 0);
    if (price <= 0) continue; // no price → skip

    const rawQty = colQty >= 0 ? row[colQty] : null;
    const qty = Math.max(1, toNumber(rawQty, 1));

    const amount = Math.round(price * qty * 100) / 100;
    results.push({ description: desc.slice(0, 500), amount, transactionDate: txDate });
  }

  return results;
}

exports.importExcel = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "Excel file is required." });
  }

  const accountId = Number(req.body.accountId || 0);
  const type = ["in", "out"].includes(req.body.type) ? req.body.type : "out";

  if (!accountId) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ message: "accountId is required." });
  }

  const [accountRows] = await pool.query("SELECT * FROM budget_accounts WHERE id=? LIMIT 1", [accountId]);
  if (!accountRows.length) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ message: "Account not found." });
  }

  let rows;
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
    for (const row of rows) {
      await connection.query(
        `INSERT INTO budget_transactions (account_id, type, amount, description, transaction_date, created_by)
         VALUES (?,?,?,?,?,?)`,
        [accountId, type, row.amount, row.description, row.transactionDate, req.user.id]
      );
    }
    await connection.commit();
  } catch (err) {
    await connection.rollback();
    connection.release();
    throw err;
  }
  connection.release();

  await safeLogAudit({
    userId: req.user.id, actorName: req.user.name, module: "BUDGET",
    action: "EXCEL_IMPORTED",
    details: `${rows.length} transaction(s) imported into "${accountRows[0].name}" from Excel.`,
    ipAddress: getRequestIp(req)
  });

  return res.status(201).json({ imported: rows.length, rows });
};
