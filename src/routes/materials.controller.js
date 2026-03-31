const fs = require("fs");
const pool = require("../config/db");
const { normalizeMaterialName } = require("../services/materialCatalog");
const { normalizeSupplierName, parseMaterialPriceFile } = require("../services/materialPriceImport");
const { describeAuditChange, formatAuditValue, getRequestIp, safeLogAudit } = require("../services/audit");

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toFlag(value, fallback = false) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function isDuplicateEntryError(error) {
  return error?.code === "ER_DUP_ENTRY";
}

function isSupplierSchemaError(error) {
  return error?.code === "ER_NO_SUCH_TABLE" || error?.code === "ER_BAD_FIELD_ERROR";
}

function removeFileIfExists(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {}
}

function sendSupplierSchemaError(res) {
  return res.status(503).json({
    message: "Supplier pricing is not ready yet. Run migration 017_supplier_material_pricing.sql and restart the backend."
  });
}

async function getMaterialByNormalizedName(normalizedName) {
  const [rows] = await pool.query(
    "SELECT * FROM material_prices WHERE normalized_name=? LIMIT 1",
    [normalizedName]
  );
  return rows[0] || null;
}

async function markMaterialAsManualCatalog(materialId) {
  if (!materialId) return;
  try {
    await pool.query(
      `UPDATE material_prices
       SET active_supplier_id=NULL,
           active_price_list_id=NULL,
           price_selection_mode='manual_catalog'
       WHERE id=?`,
      [materialId]
    );
  } catch (error) {
    if (!isSupplierSchemaError(error)) throw error;
  }
}

async function getSupplierById(connection, id) {
  const [rows] = await connection.query("SELECT * FROM suppliers WHERE id=? LIMIT 1", [id]);
  return rows[0] || null;
}

async function getSupplierByNormalizedName(connection, normalizedName) {
  const [rows] = await connection.query(
    "SELECT * FROM suppliers WHERE normalized_name=? LIMIT 1",
    [normalizedName]
  );
  return rows[0] || null;
}

async function resolveSupplier(connection, { supplierId, supplierName, isPreferred }) {
  if (supplierId) {
    const supplier = await getSupplierById(connection, supplierId);
    if (!supplier) throw new Error("Supplier not found.");
    if (typeof isPreferred === "boolean" && Number(supplier.is_preferred || 0) !== Number(isPreferred ? 1 : 0)) {
      await connection.query("UPDATE suppliers SET is_preferred=? WHERE id=?", [isPreferred ? 1 : 0, supplierId]);
      return { ...supplier, is_preferred: isPreferred ? 1 : 0 };
    }
    return supplier;
  }

  const name = String(supplierName || "").trim();
  if (!name) throw new Error("supplierName is required");

  const normalized = normalizeSupplierName(name);
  if (!normalized) throw new Error("Invalid supplierName");

  const existing = await getSupplierByNormalizedName(connection, normalized);
  if (existing) {
    const nextPreferred =
      typeof isPreferred === "boolean" ? (isPreferred ? 1 : 0) : Number(existing.is_preferred || 0);
    if (existing.supplier_name !== name || Number(existing.is_preferred || 0) !== nextPreferred) {
      await connection.query(
        "UPDATE suppliers SET supplier_name=?, is_preferred=? WHERE id=?",
        [name, nextPreferred, existing.id]
      );
    }
    return { ...existing, supplier_name: name, is_preferred: nextPreferred };
  }

  const [result] = await connection.query(
    `INSERT INTO suppliers(supplier_name, normalized_name, is_preferred)
     VALUES (?,?,?)`,
    [name, normalized, isPreferred ? 1 : 0]
  );
  return {
    id: result.insertId,
    supplier_name: name,
    normalized_name: normalized,
    is_preferred: isPreferred ? 1 : 0
  };
}

function pickAutomaticSupplierPrice(rows) {
  const preferredRows = rows.filter((row) => Number(row.is_preferred || 0) === 1);
  const poolRows = preferredRows.length ? preferredRows : rows;
  return [...poolRows].sort((a, b) => {
    const priceGap = Number(a.base_price || 0) - Number(b.base_price || 0);
    if (priceGap !== 0) return priceGap;
    return String(a.supplier_name || "").localeCompare(String(b.supplier_name || ""));
  })[0] || null;
}

async function syncCatalogMaterialPrice(connection, normalizedName) {
  if (!normalizedName) return { action: "skipped" };

  const [supplierRows] = await connection.query(
    `SELECT smp.*, s.supplier_name, s.is_preferred
       FROM supplier_material_prices smp
       JOIN suppliers s ON s.id = smp.supplier_id
      WHERE smp.normalized_name=?`,
    [normalizedName]
  );

  const [catalogRows] = await connection.query(
    "SELECT * FROM material_prices WHERE normalized_name=? LIMIT 1",
    [normalizedName]
  );
  const existing = catalogRows[0] || null;

  if (!supplierRows.length) {
    if (existing && ["supplier_auto", "manual_supplier"].includes(String(existing.price_selection_mode || ""))) {
      await connection.query(
        `UPDATE material_prices
            SET active_supplier_id=NULL,
                active_price_list_id=NULL,
                price_selection_mode='catalog_auto'
          WHERE id=?`,
        [existing.id]
      );
      return { action: "detached", materialId: existing.id };
    }
    return { action: "skipped", materialId: existing?.id || null };
  }

  if (existing && String(existing.price_selection_mode || "") === "manual_catalog") {
    return { action: "locked_manual_catalog", materialId: existing.id };
  }

  let chosen = null;
  let selectionMode = "supplier_auto";
  if (existing && String(existing.price_selection_mode || "") === "manual_supplier" && existing.active_supplier_id) {
    chosen =
      supplierRows.find((row) => Number(row.supplier_id) === Number(existing.active_supplier_id)) || null;
    selectionMode = "manual_supplier";
    if (!chosen) {
      chosen = pickAutomaticSupplierPrice(supplierRows);
      selectionMode = "supplier_auto";
    }
  } else {
    chosen = pickAutomaticSupplierPrice(supplierRows);
  }

  if (!chosen) return { action: "skipped", materialId: existing?.id || null };

  if (existing) {
    await connection.query(
      `UPDATE material_prices
          SET material_name=?,
              unit=?,
              base_price=?,
              category=?,
              subgroup=?,
              source_section=?,
              active_supplier_id=?,
              active_price_list_id=?,
              price_selection_mode=?
        WHERE id=?`,
      [
        chosen.material_name,
        chosen.unit || null,
        Number(chosen.base_price || 0),
        chosen.category || "other",
        chosen.subgroup || null,
        chosen.source_section || null,
        chosen.supplier_id,
        chosen.price_list_id,
        selectionMode,
        existing.id
      ]
    );
    await connection.query("UPDATE supplier_material_prices SET material_id=? WHERE normalized_name=?", [
      existing.id,
      normalizedName
    ]);
    return { action: "updated", materialId: existing.id, supplierId: chosen.supplier_id };
  }

  const [insertResult] = await connection.query(
    `INSERT INTO material_prices(
       material_name,
       normalized_name,
       unit,
       base_price,
       category,
       subgroup,
       source_section,
       active_supplier_id,
       active_price_list_id,
       price_selection_mode
     )
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      chosen.material_name,
      normalizedName,
      chosen.unit || null,
      Number(chosen.base_price || 0),
      chosen.category || "other",
      chosen.subgroup || null,
      chosen.source_section || null,
      chosen.supplier_id,
      chosen.price_list_id,
      selectionMode
    ]
  );

  await connection.query("UPDATE supplier_material_prices SET material_id=? WHERE normalized_name=?", [
    insertResult.insertId,
    normalizedName
  ]);

  return { action: "created", materialId: insertResult.insertId, supplierId: chosen.supplier_id };
}

exports.list = async (req, res) => {
  const q = String(req.query.q || "").trim();
  const category = String(req.query.category || "").trim();
  const where = [];
  const params = [];

  if (q) {
    const like = `%${q}%`;
    where.push("(material_name LIKE ? OR normalized_name LIKE ?)");
    params.push(like, like);
  }

  if (category) {
    where.push("category = ?");
    params.push(category);
  }

  const sql = `SELECT * FROM material_prices ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY category ASC, subgroup ASC, material_name ASC`;
  const [rows] = await pool.query(sql, params);
  return res.json(rows);
};

exports.listSuppliers = async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT s.*,
              (SELECT COUNT(*) FROM supplier_material_prices smp WHERE smp.supplier_id = s.id) AS material_count,
              (SELECT MAX(smp.updated_at) FROM supplier_material_prices smp WHERE smp.supplier_id = s.id) AS last_price_update,
              (SELECT spl.id FROM supplier_price_lists spl WHERE spl.supplier_id = s.id ORDER BY spl.id DESC LIMIT 1) AS latest_price_list_id,
              (SELECT spl.source_filename FROM supplier_price_lists spl WHERE spl.supplier_id = s.id ORDER BY spl.id DESC LIMIT 1) AS latest_source_filename,
              (SELECT spl.created_at FROM supplier_price_lists spl WHERE spl.supplier_id = s.id ORDER BY spl.id DESC LIMIT 1) AS latest_uploaded_at
         FROM suppliers s
        ORDER BY s.is_preferred DESC, s.supplier_name ASC`
    );
    return res.json(rows);
  } catch (error) {
    if (isSupplierSchemaError(error)) return sendSupplierSchemaError(res);
    throw error;
  }
};

exports.createSupplier = async (req, res) => {
  const supplierName = String(req.body.supplierName || "").trim();
  const notes = String(req.body.notes || "").trim() || null;
  const isPreferred = toFlag(req.body.isPreferred, false);

  if (!supplierName) return res.status(400).json({ message: "supplierName is required" });

  const normalized = normalizeSupplierName(supplierName);
  if (!normalized) return res.status(400).json({ message: "Invalid supplierName" });

  try {
    const [existingRows] = await pool.query(
      "SELECT * FROM suppliers WHERE normalized_name=? LIMIT 1",
      [normalized]
    );
    if (existingRows.length) {
      return res.status(409).json({
        message: `Supplier already exists as "${existingRows[0].supplier_name}".`,
        existing: existingRows[0]
      });
    }

    const [result] = await pool.query(
      "INSERT INTO suppliers(supplier_name, normalized_name, is_preferred, notes) VALUES (?,?,?,?)",
      [supplierName, normalized, isPreferred ? 1 : 0, notes]
    );
    const created = {
      id: result.insertId,
      supplier_name: supplierName,
      normalized_name: normalized,
      is_preferred: isPreferred ? 1 : 0,
      notes
    };

    await safeLogAudit({
      userId: req.user.id,
      actorName: req.user.name,
      module: "MATERIALS",
      action: "SUPPLIER_CREATED",
      details: `${created.supplier_name} supplier created. Preferred: ${formatAuditValue(Boolean(created.is_preferred))}.`,
      ipAddress: getRequestIp(req)
    });

    return res.status(201).json(created);
  } catch (error) {
    if (isSupplierSchemaError(error)) return sendSupplierSchemaError(res);
    if (!isDuplicateEntryError(error)) throw error;
    const [rows] = await pool.query("SELECT * FROM suppliers WHERE normalized_name=? LIMIT 1", [normalized]);
    return res.status(409).json({
      message: rows[0]
        ? `Supplier already exists as "${rows[0].supplier_name}".`
        : "Supplier already exists.",
      existing: rows[0] || null
    });
  }
};

exports.updateSupplier = async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid supplier id" });

  try {
    const [existingRows] = await pool.query("SELECT * FROM suppliers WHERE id=? LIMIT 1", [id]);
    if (!existingRows.length) return res.status(404).json({ message: "Supplier not found" });
    const existing = existingRows[0];

    const supplierName =
      Object.prototype.hasOwnProperty.call(req.body, "supplierName")
        ? String(req.body.supplierName || "").trim()
        : existing.supplier_name;
    const notes =
      Object.prototype.hasOwnProperty.call(req.body, "notes")
        ? String(req.body.notes || "").trim() || null
        : existing.notes;
    const isPreferred =
      Object.prototype.hasOwnProperty.call(req.body, "isPreferred")
        ? toFlag(req.body.isPreferred, false)
        : Boolean(existing.is_preferred);

    if (!supplierName) return res.status(400).json({ message: "supplierName is required" });

    const normalized = normalizeSupplierName(supplierName);
    const [duplicateRows] = await pool.query(
      "SELECT * FROM suppliers WHERE normalized_name=? AND id<>? LIMIT 1",
      [normalized, id]
    );
    if (duplicateRows.length) {
      return res.status(409).json({
        message: `Another supplier already uses this name: "${duplicateRows[0].supplier_name}".`,
        existing: duplicateRows[0]
      });
    }

    await pool.query(
      `UPDATE suppliers
          SET supplier_name=?,
              normalized_name=?,
              is_preferred=?,
              notes=?
        WHERE id=?`,
      [supplierName, normalized, isPreferred ? 1 : 0, notes, id]
    );

    const [rows] = await pool.query("SELECT * FROM suppliers WHERE id=? LIMIT 1", [id]);
    const updated = rows[0];
    const changes = [
      describeAuditChange("Supplier", existing.supplier_name, updated.supplier_name),
      describeAuditChange("Preferred", Boolean(existing.is_preferred), Boolean(updated.is_preferred)),
      describeAuditChange("Notes", existing.notes, updated.notes)
    ].filter(Boolean);

    await safeLogAudit({
      userId: req.user.id,
      actorName: req.user.name,
      module: "MATERIALS",
      action: "SUPPLIER_UPDATED",
      details: changes.length
        ? `${updated.supplier_name} updated. ${changes.join("; ")}.`
        : `${updated.supplier_name} was saved with no supplier field changes.`,
      ipAddress: getRequestIp(req)
    });

    return res.json(updated);
  } catch (error) {
    if (isSupplierSchemaError(error)) return sendSupplierSchemaError(res);
    throw error;
  }
};

exports.listPriceLists = async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 10)));

  try {
    const [rows] = await pool.query(
      `SELECT spl.*, s.supplier_name
         FROM supplier_price_lists spl
         JOIN suppliers s ON s.id = spl.supplier_id
        ORDER BY spl.id DESC
        LIMIT ?`,
      [limit]
    );
    return res.json(rows);
  } catch (error) {
    if (isSupplierSchemaError(error)) return sendSupplierSchemaError(res);
    throw error;
  }
};

exports.listComparison = async (_req, res) => {
  try {
    const [catalogRows] = await pool.query(
      `SELECT mp.id AS material_id,
              mp.material_name AS catalog_material_name,
              mp.normalized_name,
              mp.unit AS catalog_unit,
              mp.base_price AS active_price,
              mp.category,
              mp.subgroup,
              mp.source_section,
              mp.price_selection_mode,
              mp.active_supplier_id,
              s.supplier_name AS active_supplier_name
         FROM material_prices mp
         LEFT JOIN suppliers s ON s.id = mp.active_supplier_id`
    );

    const [supplierRows] = await pool.query(
      `SELECT smp.id AS supplier_price_id,
              smp.material_id,
              smp.material_name,
              smp.normalized_name,
              smp.unit,
              smp.base_price,
              smp.category,
              smp.subgroup,
              smp.source_section,
              smp.price_list_id,
              s.id AS supplier_id,
              s.supplier_name,
              s.is_preferred,
              spl.source_filename,
              spl.created_at AS uploaded_at
         FROM supplier_material_prices smp
         JOIN suppliers s ON s.id = smp.supplier_id
         LEFT JOIN supplier_price_lists spl ON spl.id = smp.price_list_id`
    );

    const byKey = new Map();

    for (const row of catalogRows) {
      byKey.set(row.normalized_name, {
        materialId: row.material_id,
        normalizedName: row.normalized_name,
        materialName: row.catalog_material_name,
        unit: row.catalog_unit,
        category: row.category,
        subgroup: row.subgroup,
        sourceSection: row.source_section,
        inCatalog: true,
        activePrice: Number(row.active_price || 0),
        activeSupplierId: row.active_supplier_id || null,
        activeSupplierName: row.active_supplier_name || null,
        priceSelectionMode: row.price_selection_mode || "catalog_auto",
        supplierPrices: []
      });
    }

    for (const row of supplierRows) {
      if (!byKey.has(row.normalized_name)) {
        byKey.set(row.normalized_name, {
          materialId: row.material_id || null,
          normalizedName: row.normalized_name,
          materialName: row.material_name,
          unit: row.unit || null,
          category: row.category || "other",
          subgroup: row.subgroup || null,
          sourceSection: row.source_section || null,
          inCatalog: Boolean(row.material_id),
          activePrice: row.material_id ? Number(row.base_price || 0) : 0,
          activeSupplierId: null,
          activeSupplierName: null,
          priceSelectionMode: "catalog_auto",
          supplierPrices: []
        });
      }

      const entry = byKey.get(row.normalized_name);
      entry.supplierPrices.push({
        supplierPriceId: row.supplier_price_id,
        supplierId: row.supplier_id,
        supplierName: row.supplier_name,
        isPreferred: Boolean(row.is_preferred),
        basePrice: Number(row.base_price || 0),
        unit: row.unit || null,
        priceListId: row.price_list_id,
        sourceFilename: row.source_filename || null,
        uploadedAt: row.uploaded_at || null,
        isActive: Number(entry.activeSupplierId || 0) === Number(row.supplier_id || 0)
      });
    }

    const rows = Array.from(byKey.values())
      .map((entry) => ({
        ...entry,
        bestPrice: entry.supplierPrices.reduce((lowest, item) => {
          if (lowest == null || Number(item.basePrice) < lowest) return Number(item.basePrice);
          return lowest;
        }, null),
        supplierPrices: [...entry.supplierPrices].sort((a, b) => {
          if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
          if (a.isPreferred !== b.isPreferred) return a.isPreferred ? -1 : 1;
          return a.basePrice - b.basePrice;
        })
      }))
      .sort((a, b) => String(a.materialName || "").localeCompare(String(b.materialName || "")));

    return res.json(rows);
  } catch (error) {
    if (isSupplierSchemaError(error)) return sendSupplierSchemaError(res);
    throw error;
  }
};

exports.importSupplierPriceList = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "Price list file is required." });
  }

  const supplierId = Number(req.body.supplierId || 0) || null;
  const supplierName = String(req.body.supplierName || "").trim();
  const isPreferred = Object.prototype.hasOwnProperty.call(req.body, "isPreferred")
    ? toFlag(req.body.isPreferred, false)
    : undefined;
  const applyToCatalog = toFlag(req.body.applyToCatalog, true);
  const replaceExisting = toFlag(req.body.replaceExisting, true);

  if (!supplierId && !supplierName) {
    removeFileIfExists(req.file.path);
    return res.status(400).json({ message: "supplierName is required when supplierId is not provided." });
  }

  let parsed;
  try {
    parsed = await parseMaterialPriceFile({
      filePath: req.file.path,
      mimeType: req.file.mimetype
    });
  } catch (error) {
    removeFileIfExists(req.file.path);
    return res.status(400).json({ message: error.message || "Unable to parse the uploaded price list." });
  }

  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  if (!items.length) {
    removeFileIfExists(req.file.path);
    return res.status(400).json({ message: "No material price rows were detected in the uploaded file." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const supplier = await resolveSupplier(connection, { supplierId, supplierName, isPreferred });
    const [priceListResult] = await connection.query(
      `INSERT INTO supplier_price_lists(
         supplier_id,
         source_filename,
         stored_path,
         file_type,
         apply_to_catalog,
         replace_existing,
         uploaded_by
       )
       VALUES (?,?,?,?,?,?,?)`,
      [
        supplier.id,
        req.file.originalname,
        req.file.path.replace(/\\/g, "/"),
        parsed.fileType,
        applyToCatalog ? 1 : 0,
        replaceExisting ? 1 : 0,
        req.user.id
      ]
    );
    const priceListId = priceListResult.insertId;

    const normalizedNames = Array.from(new Set(items.map((item) => item.normalizedName).filter(Boolean)));
    const [existingPriceRows] = await connection.query(
      "SELECT id, normalized_name FROM supplier_material_prices WHERE supplier_id=?",
      [supplier.id]
    );
    const existingByName = new Map(existingPriceRows.map((row) => [row.normalized_name, row]));

    const materialByName = new Map();
    if (normalizedNames.length) {
      const [materialRows] = await connection.query(
        "SELECT id, normalized_name FROM material_prices WHERE normalized_name IN (?)",
        [normalizedNames]
      );
      for (const row of materialRows) {
        materialByName.set(row.normalized_name, row.id);
      }
    }

    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    for (const item of items) {
      if (!item.normalizedName || Number(item.basePrice || 0) <= 0) {
        skippedCount += 1;
        continue;
      }

      const materialId = materialByName.get(item.normalizedName) || null;
      const existed = existingByName.has(item.normalizedName);
      await connection.query(
        `INSERT INTO supplier_material_prices(
           supplier_id,
           price_list_id,
           material_id,
           material_name,
           normalized_name,
           unit,
           base_price,
           category,
           subgroup,
           source_section,
           metadata_json
         )
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           price_list_id=VALUES(price_list_id),
           material_id=VALUES(material_id),
           material_name=VALUES(material_name),
           unit=VALUES(unit),
           base_price=VALUES(base_price),
           category=VALUES(category),
           subgroup=VALUES(subgroup),
           source_section=VALUES(source_section),
           metadata_json=VALUES(metadata_json),
           updated_at=CURRENT_TIMESTAMP`,
        [
          supplier.id,
          priceListId,
          materialId,
          item.materialName,
          item.normalizedName,
          item.unit || null,
          Number(item.basePrice || 0),
          item.category || "other",
          item.subgroup || null,
          item.sourceSection || null,
          JSON.stringify(item.metadata || {})
        ]
      );

      if (existed) updatedCount += 1;
      else insertedCount += 1;
    }

    let removedCount = 0;
    const removedNames = [];
    if (replaceExisting) {
      const importedSet = new Set(normalizedNames);
      const rowsToDelete = existingPriceRows.filter((row) => !importedSet.has(row.normalized_name));
      if (rowsToDelete.length) {
        removedCount = rowsToDelete.length;
        removedNames.push(...rowsToDelete.map((row) => row.normalized_name));
        await connection.query(
          "DELETE FROM supplier_material_prices WHERE supplier_id=? AND normalized_name IN (?)",
          [supplier.id, removedNames]
        );
      }
    }

    if (applyToCatalog) {
      const affectedNames = Array.from(new Set([...normalizedNames, ...removedNames]));
      for (const normalizedName of affectedNames) {
        await syncCatalogMaterialPrice(connection, normalizedName);
      }
    }

    await connection.query(
      `UPDATE supplier_price_lists
          SET imported_count=?,
              inserted_count=?,
              updated_count=?,
              removed_count=?,
              skipped_count=?
        WHERE id=?`,
      [items.length, insertedCount, updatedCount, removedCount, skippedCount, priceListId]
    );

    await connection.commit();

    await safeLogAudit({
      userId: req.user.id,
      actorName: req.user.name,
      module: "MATERIALS",
      action: "SUPPLIER_PRICE_LIST_IMPORTED",
      details: `${supplier.supplier_name} price list imported. File: ${formatAuditValue(req.file.originalname)}. Imported: ${items.length}. Inserted: ${insertedCount}. Updated: ${updatedCount}. Removed: ${removedCount}. Auto-sync: ${formatAuditValue(applyToCatalog)}.`,
      ipAddress: getRequestIp(req)
    });

    return res.status(201).json({
      supplier,
      priceListId,
      fileType: parsed.fileType,
      importedCount: items.length,
      insertedCount,
      updatedCount,
      removedCount,
      skippedCount,
      applyToCatalog,
      replaceExisting
    });
  } catch (error) {
    await connection.rollback();
    removeFileIfExists(req.file.path);
    if (isSupplierSchemaError(error)) return sendSupplierSchemaError(res);
    return res.status(400).json({ message: error.message || "Failed to import supplier price list." });
  } finally {
    connection.release();
  }
};

exports.selectSupplierPrice = async (req, res) => {
  const materialId = Number(req.params.id);
  const supplierPriceId = Number(req.body.supplierPriceId || 0) || null;
  const supplierId = Number(req.body.supplierId || 0) || null;

  if (!materialId) return res.status(400).json({ message: "Invalid material id" });
  if (!supplierPriceId && !supplierId) {
    return res.status(400).json({ message: "supplierPriceId or supplierId is required" });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [materialRows] = await connection.query(
      "SELECT * FROM material_prices WHERE id=? LIMIT 1",
      [materialId]
    );
    if (!materialRows.length) {
      await connection.rollback();
      return res.status(404).json({ message: "Material not found" });
    }
    const material = materialRows[0];

    const query = supplierPriceId
      ? `SELECT smp.*, s.supplier_name
           FROM supplier_material_prices smp
           JOIN suppliers s ON s.id = smp.supplier_id
          WHERE smp.id=? LIMIT 1`
      : `SELECT smp.*, s.supplier_name
           FROM supplier_material_prices smp
           JOIN suppliers s ON s.id = smp.supplier_id
          WHERE smp.supplier_id=? AND smp.normalized_name=? LIMIT 1`;
    const params = supplierPriceId ? [supplierPriceId] : [supplierId, material.normalized_name];
    const [supplierRows] = await connection.query(query, params);
    const chosen = supplierRows[0] || null;

    if (!chosen) {
      await connection.rollback();
      return res.status(404).json({ message: "Supplier price not found for this material." });
    }

    if (chosen.normalized_name !== material.normalized_name) {
      await connection.rollback();
      return res.status(400).json({ message: "Supplier price does not match the selected material." });
    }

    await connection.query(
      `UPDATE material_prices
          SET material_name=?,
              unit=?,
              base_price=?,
              category=?,
              subgroup=?,
              source_section=?,
              active_supplier_id=?,
              active_price_list_id=?,
              price_selection_mode='manual_supplier'
        WHERE id=?`,
      [
        chosen.material_name,
        chosen.unit || null,
        Number(chosen.base_price || 0),
        chosen.category || "other",
        chosen.subgroup || null,
        chosen.source_section || null,
        chosen.supplier_id,
        chosen.price_list_id,
        materialId
      ]
    );
    await connection.query("UPDATE supplier_material_prices SET material_id=? WHERE id=?", [materialId, chosen.id]);

    await connection.commit();

    await safeLogAudit({
      userId: req.user.id,
      actorName: req.user.name,
      module: "MATERIALS",
      action: "SUPPLIER_PRICE_SELECTED",
      details: `${material.material_name} now uses ${chosen.supplier_name} price ${formatAuditValue(chosen.base_price)}.`,
      ipAddress: getRequestIp(req)
    });

    const [rows] = await pool.query("SELECT * FROM material_prices WHERE id=? LIMIT 1", [materialId]);
    return res.json(rows[0]);
  } catch (error) {
    await connection.rollback();
    if (isSupplierSchemaError(error)) return sendSupplierSchemaError(res);
    throw error;
  } finally {
    connection.release();
  }
};

exports.create = async (req, res) => {
  const materialName = String(req.body.materialName || "").trim();
  const unit = String(req.body.unit || "").trim();
  const basePrice = Math.max(0, toNumber(req.body.basePrice, 0));
  const category = String(req.body.category || "").trim().toLowerCase() || "other";
  const subgroup = String(req.body.subgroup || "").trim() || null;
  const sourceSection = String(req.body.sourceSection || "").trim() || null;

  if (!materialName) return res.status(400).json({ message: "materialName is required" });

  const normalizedName = normalizeMaterialName(materialName);
  if (!normalizedName) return res.status(400).json({ message: "Invalid materialName" });

  const existing = await getMaterialByNormalizedName(normalizedName);
  if (existing) {
    return res.status(409).json({
      message: `Material already exists in the catalog as "${existing.material_name}".`,
      existing
    });
  }

  let createdId = null;
  try {
    const [result] = await pool.query(
      `INSERT INTO material_prices(material_name, normalized_name, unit, base_price, category, subgroup, source_section)
       VALUES (?,?,?,?,?,?,?)`,
      [materialName, normalizedName, unit || null, basePrice, category, subgroup, sourceSection]
    );
    createdId = result.insertId;
    await markMaterialAsManualCatalog(createdId);
  } catch (error) {
    if (!isDuplicateEntryError(error)) throw error;
    const duplicate = await getMaterialByNormalizedName(normalizedName);
    return res.status(409).json({
      message: duplicate
        ? `Material already exists in the catalog as "${duplicate.material_name}".`
        : "Material already exists in the catalog.",
      existing: duplicate
    });
  }

  const created = await getMaterialByNormalizedName(normalizedName);
  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "MATERIALS",
    action: "MATERIAL_CREATED",
    details: `${created.material_name} created. Category: ${formatAuditValue(created.category)}. Base price: ${formatAuditValue(created.base_price)}. Unit: ${formatAuditValue(created.unit)}.`,
    ipAddress: getRequestIp(req)
  });
  return res.status(201).json(created);
};

exports.update = async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid id" });

  const [existingRows] = await pool.query("SELECT * FROM material_prices WHERE id=? LIMIT 1", [id]);
  if (!existingRows.length) return res.status(404).json({ message: "Material not found" });
  const existing = existingRows[0];

  const materialName = String(req.body.materialName || "").trim();
  const unit = String(req.body.unit || "").trim();
  const basePrice = Math.max(0, toNumber(req.body.basePrice, 0));
  const category =
    Object.prototype.hasOwnProperty.call(req.body, "category")
      ? String(req.body.category || "").trim().toLowerCase() || "other"
      : String(existing.category || "other");
  const subgroup =
    Object.prototype.hasOwnProperty.call(req.body, "subgroup")
      ? String(req.body.subgroup || "").trim() || null
      : existing.subgroup;
  const sourceSection =
    Object.prototype.hasOwnProperty.call(req.body, "sourceSection")
      ? String(req.body.sourceSection || "").trim() || null
      : existing.source_section;

  if (!materialName) return res.status(400).json({ message: "materialName is required" });

  const normalizedName = normalizeMaterialName(materialName);
  const duplicate = await getMaterialByNormalizedName(normalizedName);
  if (duplicate && Number(duplicate.id) !== id) {
    return res.status(409).json({
      message: `Another material already uses this name: "${duplicate.material_name}".`,
      existing: duplicate
    });
  }

  try {
    await pool.query(
      `UPDATE material_prices
       SET material_name=?, normalized_name=?, unit=?, base_price=?, category=?, subgroup=?, source_section=?
       WHERE id=?`,
      [materialName, normalizedName, unit || null, basePrice, category, subgroup, sourceSection, id]
    );
    await markMaterialAsManualCatalog(id);
  } catch (error) {
    if (!isDuplicateEntryError(error)) throw error;
    const existingDuplicate = await getMaterialByNormalizedName(normalizedName);
    return res.status(409).json({
      message: existingDuplicate
        ? `Another material already uses this name: "${existingDuplicate.material_name}".`
        : "Another material already uses this name.",
      existing: existingDuplicate
    });
  }

  const [rows] = await pool.query("SELECT * FROM material_prices WHERE id=? LIMIT 1", [id]);
  const updated = rows[0];
  const changes = [
    describeAuditChange("Name", existing.material_name, updated.material_name),
    describeAuditChange("Unit", existing.unit, updated.unit),
    describeAuditChange("Base price", existing.base_price, updated.base_price),
    describeAuditChange("Category", existing.category, updated.category),
    describeAuditChange("Subgroup", existing.subgroup, updated.subgroup),
    describeAuditChange("Source section", existing.source_section, updated.source_section)
  ].filter(Boolean);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "MATERIALS",
    action: "MATERIAL_UPDATED",
    details: changes.length
      ? `${updated.material_name} updated. ${changes.join("; ")}.`
      : `${updated.material_name} was saved with no material field changes.`,
    ipAddress: getRequestIp(req)
  });

  return res.json(updated);
};

exports.remove = async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid id" });

  const [rows] = await pool.query("SELECT * FROM material_prices WHERE id=? LIMIT 1", [id]);
  await pool.query("DELETE FROM material_prices WHERE id=?", [id]);

  if (rows.length) {
    await safeLogAudit({
      userId: req.user.id,
      actorName: req.user.name,
      module: "MATERIALS",
      action: "MATERIAL_DELETED",
      details: `${rows[0].material_name} deleted. Category: ${formatAuditValue(rows[0].category)}. Base price: ${formatAuditValue(rows[0].base_price)}.`,
      ipAddress: getRequestIp(req)
    });
  }

  return res.json({ success: true });
};
