const pool = require("../config/db");
const { describeAuditChange, formatAuditValue, getRequestIp, safeLogAudit } = require("../services/audit");

const PAY_TYPES = new Set(["monthly", "daily", "hourly", "project"]);
const PAYROLL_STATUSES = new Set(["draft", "approved", "paid", "void"]);

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanText(value, maxLength = 255) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : null;
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source || {}, key);
}

function isDuplicateEntryError(error) {
  return error?.code === "ER_DUP_ENTRY";
}

function normalizePayType(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return PAY_TYPES.has(key) ? key : "monthly";
}

function normalizeEmployeeStatus(value) {
  return String(value || "active").trim().toLowerCase() === "inactive" ? "inactive" : "active";
}

function normalizePayrollStatus(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return PAYROLL_STATUSES.has(key) ? key : "draft";
}

function normalizeDate(value, { nullable = false } = {}) {
  const text = String(value || "").trim();
  if (!text) return nullable ? null : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return nullable ? null : "";
  const pad = (part) => String(part).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

function formatDate(value) {
  return normalizeDate(value, { nullable: true }) || "(blank)";
}

function calculateDefaultBasicPay(employee, regularDays, regularHours) {
  const baseRate = Math.max(0, toNumber(employee?.base_rate, 0));
  const payType = normalizePayType(employee?.pay_type);
  if (payType === "daily") return regularDays * baseRate;
  if (payType === "hourly") return regularHours * baseRate;
  return baseRate;
}

function calculatePayrollAmounts(body, employee, existing = null) {
  const regularDays = hasOwn(body, "regularDays")
    ? Math.max(0, toNumber(body.regularDays, 0))
    : Math.max(0, toNumber(existing?.regular_days, 0));
  const regularHours = hasOwn(body, "regularHours")
    ? Math.max(0, toNumber(body.regularHours, 0))
    : Math.max(0, toNumber(existing?.regular_hours, 0));
  const overtimeHours = hasOwn(body, "overtimeHours")
    ? Math.max(0, toNumber(body.overtimeHours, 0))
    : Math.max(0, toNumber(existing?.overtime_hours, 0));

  const basicPay = hasOwn(body, "basicPay")
    ? Math.max(0, toNumber(body.basicPay, 0))
    : existing
      ? Math.max(0, toNumber(existing.basic_pay, 0))
      : calculateDefaultBasicPay(employee, regularDays, regularHours);
  const overtimePay = hasOwn(body, "overtimePay")
    ? Math.max(0, toNumber(body.overtimePay, 0))
    : Math.max(0, toNumber(existing?.overtime_pay, 0));
  const allowances = hasOwn(body, "allowances")
    ? Math.max(0, toNumber(body.allowances, 0))
    : Math.max(0, toNumber(existing?.allowances, 0));
  const bonus = hasOwn(body, "bonus")
    ? Math.max(0, toNumber(body.bonus, 0))
    : Math.max(0, toNumber(existing?.bonus, 0));
  const deductions = hasOwn(body, "deductions")
    ? Math.max(0, toNumber(body.deductions, 0))
    : Math.max(0, toNumber(existing?.deductions, 0));
  const advances = hasOwn(body, "advances")
    ? Math.max(0, toNumber(body.advances, 0))
    : Math.max(0, toNumber(existing?.advances, 0));
  const otherDeductions = hasOwn(body, "otherDeductions")
    ? Math.max(0, toNumber(body.otherDeductions, 0))
    : Math.max(0, toNumber(existing?.other_deductions, 0));

  const grossPay = basicPay + overtimePay + allowances + bonus;
  const netPay = Math.max(0, grossPay - deductions - advances - otherDeductions);

  return {
    regularDays,
    regularHours,
    overtimeHours,
    basicPay,
    overtimePay,
    allowances,
    bonus,
    deductions,
    advances,
    otherDeductions,
    grossPay,
    netPay
  };
}

function serializeEmployee(row) {
  if (!row) return null;
  return {
    ...row,
    base_rate: toNumber(row.base_rate, 0),
    payroll_count: toNumber(row.payroll_count, 0),
    total_net_pay: toNumber(row.total_net_pay, 0)
  };
}

function serializeEntry(row) {
  if (!row) return null;
  return {
    ...row,
    regular_days: toNumber(row.regular_days, 0),
    regular_hours: toNumber(row.regular_hours, 0),
    overtime_hours: toNumber(row.overtime_hours, 0),
    basic_pay: toNumber(row.basic_pay, 0),
    overtime_pay: toNumber(row.overtime_pay, 0),
    allowances: toNumber(row.allowances, 0),
    bonus: toNumber(row.bonus, 0),
    deductions: toNumber(row.deductions, 0),
    advances: toNumber(row.advances, 0),
    other_deductions: toNumber(row.other_deductions, 0),
    gross_pay: toNumber(row.gross_pay, 0),
    net_pay: toNumber(row.net_pay, 0),
    employee_base_rate: toNumber(row.employee_base_rate, 0)
  };
}

async function fetchEmployee(id, connection = pool) {
  const [rows] = await connection.query(
    `SELECT pe.*,
            u.name AS created_by_name,
            (SELECT COUNT(*) FROM payroll_entries pr WHERE pr.employee_id = pe.id) AS payroll_count,
            (SELECT COALESCE(SUM(pr.net_pay), 0) FROM payroll_entries pr WHERE pr.employee_id = pe.id AND pr.status <> 'void') AS total_net_pay
       FROM payroll_employees pe
       LEFT JOIN users u ON u.id = pe.created_by
      WHERE pe.id=?
      LIMIT 1`,
    [id]
  );
  return serializeEmployee(rows[0] || null);
}

async function fetchEntry(id, connection = pool) {
  const [rows] = await connection.query(
    `SELECT pr.*,
            pe.employee_name,
            pe.employee_code,
            pe.role_title,
            pe.pay_type AS employee_pay_type,
            pe.base_rate AS employee_base_rate,
            u.name AS created_by_name
       FROM payroll_entries pr
       JOIN payroll_employees pe ON pe.id = pr.employee_id
       LEFT JOIN users u ON u.id = pr.created_by
      WHERE pr.id=?
      LIMIT 1`,
    [id]
  );
  return serializeEntry(rows[0] || null);
}

exports.listEmployees = async (req, res) => {
  const active = String(req.query.active || "1").toLowerCase();
  const q = String(req.query.q || "").trim();
  const where = [];
  const params = [];

  if (active !== "all") {
    where.push("pe.status = ?");
    params.push(active === "0" || active === "inactive" ? "inactive" : "active");
  }

  if (q) {
    const like = `%${q}%`;
    where.push("(pe.employee_name LIKE ? OR pe.employee_code LIKE ? OR pe.role_title LIKE ? OR pe.contact_no LIKE ?)");
    params.push(like, like, like, like);
  }

  const [rows] = await pool.query(
    `SELECT pe.*,
            u.name AS created_by_name,
            (SELECT COUNT(*) FROM payroll_entries pr WHERE pr.employee_id = pe.id) AS payroll_count,
            (SELECT COALESCE(SUM(pr.net_pay), 0) FROM payroll_entries pr WHERE pr.employee_id = pe.id AND pr.status <> 'void') AS total_net_pay
       FROM payroll_employees pe
       LEFT JOIN users u ON u.id = pe.created_by
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY pe.status ASC, pe.employee_name ASC`,
    params
  );

  return res.json(rows.map(serializeEmployee));
};

exports.summary = async (_req, res) => {
  const [employeeRows] = await pool.query(
    `SELECT COUNT(*) AS total_employees,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_employees
       FROM payroll_employees`
  );
  const [entryRows] = await pool.query(
    `SELECT COUNT(*) AS total_entries,
            SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft_entries,
            SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_entries,
            SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid_entries,
            COALESCE(SUM(CASE WHEN status <> 'void' THEN gross_pay ELSE 0 END), 0) AS gross_total,
            COALESCE(SUM(CASE WHEN status <> 'void' THEN net_pay ELSE 0 END), 0) AS net_total,
            COALESCE(SUM(CASE
              WHEN status = 'paid'
               AND YEAR(COALESCE(pay_date, period_end)) = YEAR(CURDATE())
               AND MONTH(COALESCE(pay_date, period_end)) = MONTH(CURDATE())
              THEN net_pay ELSE 0 END), 0) AS paid_this_month
       FROM payroll_entries`
  );

  return res.json({
    totalEmployees: toNumber(employeeRows[0]?.total_employees, 0),
    activeEmployees: toNumber(employeeRows[0]?.active_employees, 0),
    totalEntries: toNumber(entryRows[0]?.total_entries, 0),
    draftEntries: toNumber(entryRows[0]?.draft_entries, 0),
    approvedEntries: toNumber(entryRows[0]?.approved_entries, 0),
    paidEntries: toNumber(entryRows[0]?.paid_entries, 0),
    grossTotal: toNumber(entryRows[0]?.gross_total, 0),
    netTotal: toNumber(entryRows[0]?.net_total, 0),
    paidThisMonth: toNumber(entryRows[0]?.paid_this_month, 0)
  });
};

exports.createEmployee = async (req, res) => {
  const employeeName = cleanText(req.body.employeeName, 160);
  const employeeCode = cleanText(req.body.employeeCode, 80);
  const roleTitle = cleanText(req.body.roleTitle, 120);
  const payType = normalizePayType(req.body.payType);
  const baseRate = Math.max(0, toNumber(req.body.baseRate, 0));
  const contactNo = cleanText(req.body.contactNo, 80);
  const notes = cleanText(req.body.notes, 4000);
  const status = normalizeEmployeeStatus(req.body.status);

  if (!employeeName) return res.status(400).json({ message: "employeeName is required" });

  try {
    const [result] = await pool.query(
      `INSERT INTO payroll_employees(
         employee_name,
         employee_code,
         role_title,
         pay_type,
         base_rate,
         contact_no,
         notes,
         status,
         created_by
       )
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [employeeName, employeeCode, roleTitle, payType, baseRate, contactNo, notes, status, req.user.id]
    );

    const created = await fetchEmployee(result.insertId);
    await safeLogAudit({
      userId: req.user.id,
      actorName: req.user.name,
      module: "PAYROLL",
      action: "EMPLOYEE_CREATED",
      details: `${created.employee_name} created. Pay type: ${formatAuditValue(created.pay_type)}. Base rate: ${formatAuditValue(created.base_rate)}. Status: ${formatAuditValue(created.status)}.`,
      ipAddress: getRequestIp(req)
    });

    return res.status(201).json(created);
  } catch (error) {
    if (isDuplicateEntryError(error)) {
      return res.status(409).json({ message: "Another payroll employee already uses that employee code." });
    }
    throw error;
  }
};

exports.updateEmployee = async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid employee id" });

  const existing = await fetchEmployee(id);
  if (!existing) return res.status(404).json({ message: "Payroll employee not found" });

  const employeeName = hasOwn(req.body, "employeeName") ? cleanText(req.body.employeeName, 160) : existing.employee_name;
  const employeeCode = hasOwn(req.body, "employeeCode") ? cleanText(req.body.employeeCode, 80) : existing.employee_code;
  const roleTitle = hasOwn(req.body, "roleTitle") ? cleanText(req.body.roleTitle, 120) : existing.role_title;
  const payType = hasOwn(req.body, "payType") ? normalizePayType(req.body.payType) : normalizePayType(existing.pay_type);
  const baseRate = hasOwn(req.body, "baseRate") ? Math.max(0, toNumber(req.body.baseRate, 0)) : toNumber(existing.base_rate, 0);
  const contactNo = hasOwn(req.body, "contactNo") ? cleanText(req.body.contactNo, 80) : existing.contact_no;
  const notes = hasOwn(req.body, "notes") ? cleanText(req.body.notes, 4000) : existing.notes;
  const status = hasOwn(req.body, "status") ? normalizeEmployeeStatus(req.body.status) : normalizeEmployeeStatus(existing.status);

  if (!employeeName) return res.status(400).json({ message: "employeeName is required" });

  try {
    await pool.query(
      `UPDATE payroll_employees
          SET employee_name=?,
              employee_code=?,
              role_title=?,
              pay_type=?,
              base_rate=?,
              contact_no=?,
              notes=?,
              status=?
        WHERE id=?`,
      [employeeName, employeeCode, roleTitle, payType, baseRate, contactNo, notes, status, id]
    );
  } catch (error) {
    if (isDuplicateEntryError(error)) {
      return res.status(409).json({ message: "Another payroll employee already uses that employee code." });
    }
    throw error;
  }

  const updated = await fetchEmployee(id);
  const changes = [
    describeAuditChange("Name", existing.employee_name, updated.employee_name),
    describeAuditChange("Employee code", existing.employee_code, updated.employee_code),
    describeAuditChange("Role", existing.role_title, updated.role_title),
    describeAuditChange("Pay type", existing.pay_type, updated.pay_type),
    describeAuditChange("Base rate", existing.base_rate, updated.base_rate),
    describeAuditChange("Contact", existing.contact_no, updated.contact_no),
    describeAuditChange("Status", existing.status, updated.status),
    describeAuditChange("Notes", existing.notes, updated.notes)
  ].filter(Boolean);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "PAYROLL",
    action: "EMPLOYEE_UPDATED",
    details: changes.length
      ? `${updated.employee_name} updated. ${changes.join("; ")}.`
      : `${updated.employee_name} was saved with no payroll employee changes.`,
    ipAddress: getRequestIp(req)
  });

  return res.json(updated);
};

exports.deactivateEmployee = async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid employee id" });

  const existing = await fetchEmployee(id);
  if (!existing) return res.status(404).json({ message: "Payroll employee not found" });

  await pool.query("UPDATE payroll_employees SET status='inactive' WHERE id=?", [id]);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "PAYROLL",
    action: "EMPLOYEE_DEACTIVATED",
    details: `${existing.employee_name} deactivated from payroll.`,
    ipAddress: getRequestIp(req)
  });

  return res.json({ success: true });
};

exports.listEntries = async (req, res) => {
  const employeeId = Number(req.query.employeeId || 0);
  const status = String(req.query.status || "all").trim().toLowerCase();
  const q = String(req.query.q || "").trim();
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 300);

  const where = [];
  const params = [];

  if (employeeId > 0) {
    where.push("pr.employee_id = ?");
    params.push(employeeId);
  }

  if (status !== "all") {
    where.push("pr.status = ?");
    params.push(normalizePayrollStatus(status));
  }

  if (q) {
    const like = `%${q}%`;
    where.push("(pe.employee_name LIKE ? OR pe.employee_code LIKE ? OR pr.reference_no LIKE ? OR pr.notes LIKE ?)");
    params.push(like, like, like, like);
  }

  const [rows] = await pool.query(
    `SELECT pr.*,
            pe.employee_name,
            pe.employee_code,
            pe.role_title,
            pe.pay_type AS employee_pay_type,
            pe.base_rate AS employee_base_rate,
            u.name AS created_by_name
       FROM payroll_entries pr
       JOIN payroll_employees pe ON pe.id = pr.employee_id
       LEFT JOIN users u ON u.id = pr.created_by
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY pr.period_start DESC, pr.id DESC
      LIMIT ${limit}`,
    params
  );

  return res.json(rows.map(serializeEntry));
};

exports.createEntry = async (req, res) => {
  const employeeId = Number(req.body.employeeId || 0);
  const periodStart = normalizeDate(req.body.periodStart);
  const periodEnd = normalizeDate(req.body.periodEnd);
  const payDate = normalizeDate(req.body.payDate, { nullable: true });
  const status = normalizePayrollStatus(req.body.status);
  const referenceNo = cleanText(req.body.referenceNo, 100);
  const notes = cleanText(req.body.notes, 4000);

  if (!employeeId) return res.status(400).json({ message: "employeeId is required" });
  if (!periodStart || !periodEnd) return res.status(400).json({ message: "periodStart and periodEnd are required" });
  if (periodEnd < periodStart) return res.status(400).json({ message: "periodEnd must be on or after periodStart" });

  const employee = await fetchEmployee(employeeId);
  if (!employee) return res.status(404).json({ message: "Payroll employee not found" });
  if (employee.status === "inactive") {
    return res.status(400).json({ message: "Cannot create payroll for an inactive employee" });
  }

  const amounts = calculatePayrollAmounts(req.body, employee);

  const [result] = await pool.query(
    `INSERT INTO payroll_entries(
       employee_id,
       period_start,
       period_end,
       pay_date,
       status,
       regular_days,
       regular_hours,
       overtime_hours,
       basic_pay,
       overtime_pay,
       allowances,
       bonus,
       deductions,
       advances,
       other_deductions,
       gross_pay,
       net_pay,
       reference_no,
       notes,
       created_by
     )
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      employeeId,
      periodStart,
      periodEnd,
      payDate,
      status,
      amounts.regularDays,
      amounts.regularHours,
      amounts.overtimeHours,
      amounts.basicPay,
      amounts.overtimePay,
      amounts.allowances,
      amounts.bonus,
      amounts.deductions,
      amounts.advances,
      amounts.otherDeductions,
      amounts.grossPay,
      amounts.netPay,
      referenceNo,
      notes,
      req.user.id
    ]
  );

  const created = await fetchEntry(result.insertId);
  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "PAYROLL",
    action: "PAYROLL_ENTRY_CREATED",
    details: `${created.employee_name} payroll created for ${formatDate(created.period_start)} to ${formatDate(created.period_end)}. Net pay: ${formatAuditValue(created.net_pay)}. Status: ${formatAuditValue(created.status)}.`,
    ipAddress: getRequestIp(req)
  });

  return res.status(201).json(created);
};

exports.updateEntry = async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid payroll entry id" });

  const existing = await fetchEntry(id);
  if (!existing) return res.status(404).json({ message: "Payroll entry not found" });

  const employeeId = hasOwn(req.body, "employeeId") ? Number(req.body.employeeId || 0) : Number(existing.employee_id);
  const employee = await fetchEmployee(employeeId);
  if (!employee) return res.status(404).json({ message: "Payroll employee not found" });

  const periodStart = hasOwn(req.body, "periodStart") ? normalizeDate(req.body.periodStart) : normalizeDate(existing.period_start);
  const periodEnd = hasOwn(req.body, "periodEnd") ? normalizeDate(req.body.periodEnd) : normalizeDate(existing.period_end);
  const payDate = hasOwn(req.body, "payDate") ? normalizeDate(req.body.payDate, { nullable: true }) : normalizeDate(existing.pay_date, { nullable: true });
  const status = hasOwn(req.body, "status") ? normalizePayrollStatus(req.body.status) : normalizePayrollStatus(existing.status);
  const referenceNo = hasOwn(req.body, "referenceNo") ? cleanText(req.body.referenceNo, 100) : existing.reference_no;
  const notes = hasOwn(req.body, "notes") ? cleanText(req.body.notes, 4000) : existing.notes;

  if (!periodStart || !periodEnd) return res.status(400).json({ message: "periodStart and periodEnd are required" });
  if (periodEnd < periodStart) return res.status(400).json({ message: "periodEnd must be on or after periodStart" });

  const amounts = calculatePayrollAmounts(req.body, employee, existing);

  await pool.query(
    `UPDATE payroll_entries
        SET employee_id=?,
            period_start=?,
            period_end=?,
            pay_date=?,
            status=?,
            regular_days=?,
            regular_hours=?,
            overtime_hours=?,
            basic_pay=?,
            overtime_pay=?,
            allowances=?,
            bonus=?,
            deductions=?,
            advances=?,
            other_deductions=?,
            gross_pay=?,
            net_pay=?,
            reference_no=?,
            notes=?
      WHERE id=?`,
    [
      employeeId,
      periodStart,
      periodEnd,
      payDate,
      status,
      amounts.regularDays,
      amounts.regularHours,
      amounts.overtimeHours,
      amounts.basicPay,
      amounts.overtimePay,
      amounts.allowances,
      amounts.bonus,
      amounts.deductions,
      amounts.advances,
      amounts.otherDeductions,
      amounts.grossPay,
      amounts.netPay,
      referenceNo,
      notes,
      id
    ]
  );

  const updated = await fetchEntry(id);
  const changes = [
    describeAuditChange("Employee", existing.employee_name, updated.employee_name),
    describeAuditChange("Period start", formatDate(existing.period_start), formatDate(updated.period_start)),
    describeAuditChange("Period end", formatDate(existing.period_end), formatDate(updated.period_end)),
    describeAuditChange("Pay date", formatDate(existing.pay_date), formatDate(updated.pay_date)),
    describeAuditChange("Status", existing.status, updated.status),
    describeAuditChange("Gross pay", existing.gross_pay, updated.gross_pay),
    describeAuditChange("Net pay", existing.net_pay, updated.net_pay),
    describeAuditChange("Reference", existing.reference_no, updated.reference_no)
  ].filter(Boolean);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "PAYROLL",
    action: "PAYROLL_ENTRY_UPDATED",
    details: changes.length
      ? `${updated.employee_name} payroll updated. ${changes.join("; ")}.`
      : `${updated.employee_name} payroll was saved with no changes.`,
    ipAddress: getRequestIp(req)
  });

  return res.json(updated);
};

exports.removeEntry = async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid payroll entry id" });

  const existing = await fetchEntry(id);
  if (!existing) return res.status(404).json({ message: "Payroll entry not found" });

  await pool.query("DELETE FROM payroll_entries WHERE id=?", [id]);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "PAYROLL",
    action: "PAYROLL_ENTRY_DELETED",
    details: `${existing.employee_name} payroll deleted for ${formatDate(existing.period_start)} to ${formatDate(existing.period_end)}. Net pay: ${formatAuditValue(existing.net_pay)}.`,
    ipAddress: getRequestIp(req)
  });

  return res.json({ success: true });
};
