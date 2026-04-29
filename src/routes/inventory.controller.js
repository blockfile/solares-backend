const pool = require("../config/db");
const { describeAuditChange, formatAuditValue, getRequestIp, safeLogAudit } = require("../services/audit");

const MOVEMENT_TYPES = new Set(["stock_in", "stock_out", "adjustment"]);

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toFlag(value, fallback = true) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "active"].includes(text)) return true;
  if (["0", "false", "no", "off", "inactive"].includes(text)) return false;
  return fallback;
}

function cleanText(value, maxLength = 255) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeMovementType(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (["in", "receive", "received", "receipt", "stockin"].includes(key)) return "stock_in";
  if (["out", "use", "used", "usage", "consume", "consumed", "stockout"].includes(key)) return "stock_out";
  if (["adjust", "adjustment", "count"].includes(key)) return "adjustment";
  return MOVEMENT_TYPES.has(key) ? key : "";
}

function formatDateTimeForSql(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(":");
}

function normalizeMovementDate(value) {
  const text = String(value || "").trim();
  if (!text) return formatDateTimeForSql(new Date());
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text} 00:00:00`;

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return "";
  return formatDateTimeForSql(parsed);
}

function statusForItem(row) {
  if (Number(row.is_active) !== 1) return "inactive";
  const current = toNumber(row.current_quantity, 0);
  const minimum = toNumber(row.minimum_quantity, 0);
  if (current <= 0) return "out";
  if (minimum > 0 && current <= minimum) return "low";
  return "in_stock";
}

function serializeItem(row) {
  if (!row) return null;
  return {
    ...row,
    minimum_quantity: toNumber(row.minimum_quantity, 0),
    current_quantity: toNumber(row.current_quantity, 0),
    is_active: Number(row.is_active) === 1 ? 1 : 0,
    movement_count: toNumber(row.movement_count, 0),
    stock_status: statusForItem(row)
  };
}

function serializeMovement(row) {
  if (!row) return null;
  const quantity = toNumber(row.quantity, 0);
  return {
    ...row,
    quantity,
    signed_quantity:
      row.movement_type === "stock_out"
        ? -Math.abs(quantity)
        : quantity,
    unit_cost: row.unit_cost == null ? null : toNumber(row.unit_cost, 0)
  };
}

function isDuplicateEntryError(error) {
  return error?.code === "ER_DUP_ENTRY";
}

async function fetchItem(id, connection = pool) {
  const [rows] = await connection.query(
    `SELECT ii.*,
            u.name AS created_by_name,
            (SELECT COUNT(*) FROM inventory_movements im WHERE im.item_id = ii.id) AS movement_count,
            (SELECT MAX(im.movement_date) FROM inventory_movements im WHERE im.item_id = ii.id) AS last_movement_at
       FROM inventory_items ii
       LEFT JOIN users u ON u.id = ii.created_by
      WHERE ii.id=?
      LIMIT 1`,
    [id]
  );
  return serializeItem(rows[0] || null);
}

async function fetchMovement(id, connection = pool) {
  const [rows] = await connection.query(
    `SELECT im.*,
            ii.item_name,
            ii.sku,
            ii.unit,
            u.name AS created_by_name
       FROM inventory_movements im
       JOIN inventory_items ii ON ii.id = im.item_id
       LEFT JOIN users u ON u.id = im.created_by
      WHERE im.id=?
      LIMIT 1`,
    [id]
  );
  return serializeMovement(rows[0] || null);
}

exports.list = async (req, res) => {
  const q = String(req.query.q || "").trim();
  const category = String(req.query.category || "").trim();
  const active = String(req.query.active || "1").toLowerCase();

  const where = [];
  const params = [];

  if (q) {
    const like = `%${q}%`;
    where.push("(ii.item_name LIKE ? OR ii.sku LIKE ? OR ii.category LIKE ? OR ii.location LIKE ? OR ii.notes LIKE ?)");
    params.push(like, like, like, like, like);
  }

  if (category && category !== "all") {
    where.push("ii.category = ?");
    params.push(category);
  }

  if (active !== "all") {
    where.push("ii.is_active = ?");
    params.push(active === "0" || active === "inactive" ? 0 : 1);
  }

  const [rows] = await pool.query(
    `SELECT ii.*,
            u.name AS created_by_name,
            (SELECT COUNT(*) FROM inventory_movements im WHERE im.item_id = ii.id) AS movement_count,
            (SELECT MAX(im.movement_date) FROM inventory_movements im WHERE im.item_id = ii.id) AS last_movement_at
       FROM inventory_items ii
       LEFT JOIN users u ON u.id = ii.created_by
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ii.is_active DESC, ii.category ASC, ii.item_name ASC`,
    params
  );

  return res.json(rows.map(serializeItem));
};

exports.summary = async (_req, res) => {
  const [itemRows] = await pool.query(
    `SELECT COUNT(*) AS total_items,
            SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_items,
            SUM(CASE WHEN is_active = 1 AND current_quantity <= 0 THEN 1 ELSE 0 END) AS out_items,
            SUM(CASE WHEN is_active = 1 AND minimum_quantity > 0 AND current_quantity <= minimum_quantity AND current_quantity > 0 THEN 1 ELSE 0 END) AS low_items,
            COALESCE(SUM(CASE WHEN is_active = 1 THEN current_quantity ELSE 0 END), 0) AS total_on_hand
       FROM inventory_items`
  );
  const [movementRows] = await pool.query("SELECT COUNT(*) AS total_movements FROM inventory_movements");

  return res.json({
    totalItems: toNumber(itemRows[0]?.total_items, 0),
    activeItems: toNumber(itemRows[0]?.active_items, 0),
    outItems: toNumber(itemRows[0]?.out_items, 0),
    lowItems: toNumber(itemRows[0]?.low_items, 0),
    totalOnHand: toNumber(itemRows[0]?.total_on_hand, 0),
    totalMovements: toNumber(movementRows[0]?.total_movements, 0)
  });
};

exports.listMovements = async (req, res) => {
  const routeItemId = Number(req.params.id || 0);
  const queryItemId = Number(req.query.itemId || 0);
  const itemId = routeItemId || queryItemId;
  const limit = Math.min(Math.max(Number(req.query.limit || 80), 1), 250);

  const where = [];
  const params = [];
  if (itemId > 0) {
    where.push("im.item_id = ?");
    params.push(itemId);
  }

  const [rows] = await pool.query(
    `SELECT im.*,
            ii.item_name,
            ii.sku,
            ii.unit,
            u.name AS created_by_name
       FROM inventory_movements im
       JOIN inventory_items ii ON ii.id = im.item_id
       LEFT JOIN users u ON u.id = im.created_by
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY im.movement_date DESC, im.id DESC
      LIMIT ${limit}`,
    params
  );

  return res.json(rows.map(serializeMovement));
};

exports.create = async (req, res) => {
  const itemName = cleanText(req.body.itemName, 255);
  const sku = cleanText(req.body.sku, 80);
  const unit = cleanText(req.body.unit, 40);
  const category = cleanText(req.body.category, 80) || "general";
  const location = cleanText(req.body.location, 120);
  const notes = cleanText(req.body.notes, 4000);
  const minimumQuantity = Math.max(0, toNumber(req.body.minimumQuantity, 0));
  const openingQuantity = Math.max(0, toNumber(req.body.openingQuantity, 0));
  const isActive = toFlag(req.body.isActive, true) ? 1 : 0;

  if (!itemName) return res.status(400).json({ message: "itemName is required" });

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.query(
      `INSERT INTO inventory_items(
         item_name,
         sku,
         category,
         unit,
         location,
         minimum_quantity,
         current_quantity,
         notes,
         is_active,
         created_by
       )
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        itemName,
        sku,
        category,
        unit,
        location,
        minimumQuantity,
        openingQuantity,
        notes,
        isActive,
        req.user.id
      ]
    );

    const itemId = result.insertId;
    if (openingQuantity > 0) {
      await connection.query(
        `INSERT INTO inventory_movements(
           item_id,
           movement_type,
           quantity,
           reference_no,
           notes,
           movement_date,
           created_by
         )
         VALUES (?,?,?,?,?,?,?)`,
        [
          itemId,
          "stock_in",
          openingQuantity,
          "Opening balance",
          "Initial stock recorded when item was created.",
          formatDateTimeForSql(new Date()),
          req.user.id
        ]
      );
    }

    await connection.commit();

    const created = await fetchItem(itemId);
    await safeLogAudit({
      userId: req.user.id,
      actorName: req.user.name,
      module: "INVENTORY",
      action: "ITEM_CREATED",
      details: `${created.item_name} created. Opening stock: ${formatAuditValue(openingQuantity)} ${formatAuditValue(created.unit)}. Minimum: ${formatAuditValue(created.minimum_quantity)}.`,
      ipAddress: getRequestIp(req)
    });

    return res.status(201).json(created);
  } catch (error) {
    await connection.rollback();
    if (isDuplicateEntryError(error)) {
      return res.status(409).json({ message: "Another inventory item already uses that SKU." });
    }
    throw error;
  } finally {
    connection.release();
  }
};

exports.update = async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid id" });

  const existing = await fetchItem(id);
  if (!existing) return res.status(404).json({ message: "Inventory item not found" });

  const itemName = Object.prototype.hasOwnProperty.call(req.body, "itemName")
    ? cleanText(req.body.itemName, 255)
    : existing.item_name;
  const sku = Object.prototype.hasOwnProperty.call(req.body, "sku")
    ? cleanText(req.body.sku, 80)
    : existing.sku;
  const category = Object.prototype.hasOwnProperty.call(req.body, "category")
    ? cleanText(req.body.category, 80) || "general"
    : existing.category || "general";
  const unit = Object.prototype.hasOwnProperty.call(req.body, "unit")
    ? cleanText(req.body.unit, 40)
    : existing.unit;
  const location = Object.prototype.hasOwnProperty.call(req.body, "location")
    ? cleanText(req.body.location, 120)
    : existing.location;
  const minimumQuantity = Object.prototype.hasOwnProperty.call(req.body, "minimumQuantity")
    ? Math.max(0, toNumber(req.body.minimumQuantity, 0))
    : toNumber(existing.minimum_quantity, 0);
  const notes = Object.prototype.hasOwnProperty.call(req.body, "notes")
    ? cleanText(req.body.notes, 4000)
    : existing.notes;
  const isActive = Object.prototype.hasOwnProperty.call(req.body, "isActive")
    ? toFlag(req.body.isActive, true) ? 1 : 0
    : Number(existing.is_active) === 1 ? 1 : 0;

  if (!itemName) return res.status(400).json({ message: "itemName is required" });

  try {
    await pool.query(
      `UPDATE inventory_items
          SET item_name=?,
              sku=?,
              category=?,
              unit=?,
              location=?,
              minimum_quantity=?,
              notes=?,
              is_active=?
        WHERE id=?`,
      [itemName, sku, category, unit, location, minimumQuantity, notes, isActive, id]
    );
  } catch (error) {
    if (isDuplicateEntryError(error)) {
      return res.status(409).json({ message: "Another inventory item already uses that SKU." });
    }
    throw error;
  }

  const updated = await fetchItem(id);
  const changes = [
    describeAuditChange("Name", existing.item_name, updated.item_name),
    describeAuditChange("SKU", existing.sku, updated.sku),
    describeAuditChange("Category", existing.category, updated.category),
    describeAuditChange("Unit", existing.unit, updated.unit),
    describeAuditChange("Location", existing.location, updated.location),
    describeAuditChange("Minimum quantity", existing.minimum_quantity, updated.minimum_quantity),
    describeAuditChange("Status", Number(existing.is_active) === 1 ? "active" : "inactive", Number(updated.is_active) === 1 ? "active" : "inactive"),
    describeAuditChange("Notes", existing.notes, updated.notes)
  ].filter(Boolean);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "INVENTORY",
    action: "ITEM_UPDATED",
    details: changes.length
      ? `${updated.item_name} updated. ${changes.join("; ")}.`
      : `${updated.item_name} was saved with no inventory item changes.`,
    ipAddress: getRequestIp(req)
  });

  return res.json(updated);
};

exports.remove = async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ message: "Invalid id" });

  const existing = await fetchItem(id);
  if (!existing) return res.status(404).json({ message: "Inventory item not found" });

  await pool.query("UPDATE inventory_items SET is_active=0 WHERE id=?", [id]);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "INVENTORY",
    action: "ITEM_DEACTIVATED",
    details: `${existing.item_name} deactivated. Stock on hand: ${formatAuditValue(existing.current_quantity)} ${formatAuditValue(existing.unit)}.`,
    ipAddress: getRequestIp(req)
  });

  return res.json({ success: true });
};

exports.createMovement = async (req, res) => {
  const itemId = Number(req.params.id || 0);
  if (!itemId) return res.status(400).json({ message: "Invalid item id" });

  const movementType = normalizeMovementType(req.body.movementType || req.body.type);
  if (!movementType) {
    return res.status(400).json({ message: "movementType must be stock_in, stock_out, or adjustment" });
  }

  const rawQuantity = toNumber(req.body.quantity, 0);
  const quantity =
    movementType === "adjustment"
      ? rawQuantity
      : Math.abs(rawQuantity);

  if (movementType === "adjustment") {
    if (!quantity) return res.status(400).json({ message: "Adjustment quantity must not be zero" });
  } else if (quantity <= 0) {
    return res.status(400).json({ message: "Quantity must be greater than zero" });
  }

  const movementDate = normalizeMovementDate(req.body.movementDate);
  if (!movementDate) return res.status(400).json({ message: "Invalid movementDate" });

  const unitCost = Object.prototype.hasOwnProperty.call(req.body, "unitCost")
    ? Math.max(0, toNumber(req.body.unitCost, 0))
    : null;
  const referenceNo = cleanText(req.body.referenceNo, 100);
  const notes = cleanText(req.body.notes, 4000);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.query(
      "SELECT * FROM inventory_items WHERE id=? LIMIT 1 FOR UPDATE",
      [itemId]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ message: "Inventory item not found" });
    }

    const existing = rows[0];
    const currentQuantity = toNumber(existing.current_quantity, 0);
    const delta =
      movementType === "stock_in"
        ? quantity
        : movementType === "stock_out"
          ? -quantity
          : quantity;
    const nextQuantity = currentQuantity + delta;

    if (nextQuantity < -0.0004) {
      await connection.rollback();
      return res.status(400).json({
        message: `Not enough stock. ${existing.item_name} has ${currentQuantity} ${existing.unit || ""} on hand.`
      });
    }

    const [insertResult] = await connection.query(
      `INSERT INTO inventory_movements(
         item_id,
         movement_type,
         quantity,
         unit_cost,
         reference_no,
         notes,
         movement_date,
         created_by
       )
       VALUES (?,?,?,?,?,?,?,?)`,
      [itemId, movementType, quantity, unitCost, referenceNo, notes, movementDate, req.user.id]
    );

    await connection.query(
      "UPDATE inventory_items SET current_quantity=? WHERE id=?",
      [Math.max(0, nextQuantity), itemId]
    );

    await connection.commit();

    const [item, movement] = await Promise.all([
      fetchItem(itemId),
      fetchMovement(insertResult.insertId)
    ]);

    const action =
      movementType === "stock_in"
        ? "STOCK_RECEIVED"
        : movementType === "stock_out"
          ? "STOCK_USED"
          : "STOCK_ADJUSTED";

    await safeLogAudit({
      userId: req.user.id,
      actorName: req.user.name,
      module: "INVENTORY",
      action,
      details: `${item.item_name}: ${movementType.replace("_", " ")} ${formatAuditValue(quantity)} ${formatAuditValue(item.unit)}. Stock now ${formatAuditValue(item.current_quantity)}. Reference: ${formatAuditValue(referenceNo)}.`,
      ipAddress: getRequestIp(req)
    });

    return res.status(201).json({ item, movement });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};
