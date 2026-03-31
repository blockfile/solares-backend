const fs = require("fs/promises");
const path = require("path");
const pool = require("../config/db");
const {
  SYSTEM_ROLE_KEYS,
  defaultModulesForRole,
  normalizeRoleKey,
  parseModulesJson,
  roleLabel
} = require("../services/accessControl");
const { getRequestIp, safeLogAudit } = require("../services/audit");

const EVENT_STATUSES = new Set(["planned", "in_progress", "completed", "cancelled"]);
const EVENT_ACTIVITY_TYPES = new Set([
  "survey",
  "site_visit",
  "installation",
  "delivery",
  "maintenance",
  "follow_up",
  "inspection",
  "other"
]);
const EVENT_PHOTO_PREFIX = "/uploads/event-photos/";

function isAdmin(user) {
  return normalizeRoleKey(user?.role) === SYSTEM_ROLE_KEYS.ADMIN;
}

function normalizeStatus(value) {
  const key = String(value || "").trim().toLowerCase();
  return EVENT_STATUSES.has(key) ? key : "planned";
}

function normalizeActivityType(value) {
  const key = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return EVENT_ACTIVITY_TYPES.has(key) ? key : "other";
}

function toNullableText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function toMysqlDateTime(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  const candidate = text.replace("T", " ");
  const direct = new Date(text);
  if (!Number.isNaN(direct.getTime())) {
    const year = direct.getFullYear();
    const month = String(direct.getMonth() + 1).padStart(2, "0");
    const day = String(direct.getDate()).padStart(2, "0");
    const hours = String(direct.getHours()).padStart(2, "0");
    const minutes = String(direct.getMinutes()).padStart(2, "0");
    const seconds = String(direct.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return `${candidate} 00:00:00`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(candidate)) return `${candidate}:00`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(candidate)) return candidate;
  return null;
}

function publicPhotoUrl(req, photoPath) {
  if (!photoPath) return "";
  const base = `${req.protocol}://${req.get("host")}`;
  return `${base}${photoPath}`;
}

function getUploadedReportFiles(req) {
  if (Array.isArray(req.files)) return req.files.filter(Boolean);

  const files = [];
  if (req.file) files.push(req.file);

  if (req.files && typeof req.files === "object") {
    for (const value of Object.values(req.files)) {
      if (Array.isArray(value)) files.push(...value.filter(Boolean));
    }
  }

  return files;
}

async function cleanupUploadedReportFiles(req) {
  const files = getUploadedReportFiles(req);
  await Promise.all(
    files.map((file) => (file?.path ? fs.unlink(file.path).catch(() => {}) : Promise.resolve()))
  );
}

function normalizeStoredPhoto(entry) {
  const pathValue = String(
    entry?.path ||
      entry?.photoPath ||
      entry?.completion_photo_path ||
      entry?.completionPhotoPath ||
      ""
  ).trim();
  if (!pathValue) return null;

  const nameValue = String(
    entry?.name ||
      entry?.photoName ||
      entry?.completion_photo_name ||
      entry?.completionPhotoName ||
      path.basename(pathValue) ||
      ""
  ).trim();

  return {
    path: pathValue,
    name: nameValue || path.basename(pathValue)
  };
}

function parseCompletionPhotos(row) {
  const parsed = [];

  if (row?.completion_photos_json) {
    try {
      const json = typeof row.completion_photos_json === "string"
        ? JSON.parse(row.completion_photos_json)
        : row.completion_photos_json;
      if (Array.isArray(json)) {
        for (const entry of json) {
          const normalized = normalizeStoredPhoto(entry);
          if (normalized) parsed.push(normalized);
        }
      }
    } catch {
      // Ignore malformed legacy photo json and fall back to legacy columns.
    }
  }

  if (parsed.length > 0) return parsed;

  const legacy = normalizeStoredPhoto(row);
  return legacy ? [legacy] : [];
}

function serializeCompletionPhotos(row, req) {
  return parseCompletionPhotos(row).map((photo, index) => ({
    id: `${Number(row?.id || 0) || "event"}-${index + 1}`,
    path: photo.path,
    name: photo.name,
    url: publicPhotoUrl(req, photo.path)
  }));
}

function serializeCompletionPhotosJson(photos) {
  const normalized = photos
    .map((entry) => normalizeStoredPhoto(entry))
    .filter(Boolean)
    .map((entry) => ({ path: entry.path, name: entry.name }));

  return normalized.length ? JSON.stringify(normalized) : null;
}

function getPrimaryCompletionPhoto(photos) {
  return photos.length ? photos[photos.length - 1] : null;
}

function serializeEvent(row, req) {
  const completionPhotos = serializeCompletionPhotos(row, req);
  const primaryPhoto = getPrimaryCompletionPhoto(completionPhotos);

  return {
    id: Number(row.id),
    title: row.title,
    activityType: row.activity_type || "other",
    customerName: row.customer_name || "",
    location: row.location || "",
    startDateTime: row.start_datetime,
    endDateTime: row.end_datetime,
    allDay: Number(row.all_day || 0) === 1,
    status: normalizeStatus(row.status),
    notes: row.notes || "",
    completionNotes: row.completion_notes || "",
    completionPhotoPath: primaryPhoto?.path || "",
    completionPhotoName: primaryPhoto?.name || "",
    completionPhotoUrl: primaryPhoto?.url || "",
    completionPhotos,
    completedAt: row.completed_at,
    assigneeUserId: Number(row.user_id),
    assigneeName: row.assignee_name || "",
    assigneeUsername: row.assignee_username || "",
    assigneeRole: row.assignee_role || "",
    createdByUserId: Number(row.created_by_user_id || 0) || null,
    createdByName: row.created_by_name || "",
    createdByUsername: row.created_by_username || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function canEditEvent(user, event) {
  if (isAdmin(user)) return true;
  return Number(event.user_id) === Number(user.id) && Number(event.created_by_user_id) === Number(user.id);
}

function canSubmitReport(user, event) {
  if (isAdmin(user)) return true;
  return Number(event.user_id) === Number(user.id);
}

async function removeStoredPhoto(photoPath) {
  const normalized = String(photoPath || "");
  if (!normalized.startsWith(EVENT_PHOTO_PREFIX)) return;

  const absolutePath = path.resolve(process.cwd(), normalized.replace(/^\/+/, ""));
  try {
    await fs.unlink(absolutePath);
  } catch {
    // Ignore missing or already-removed files.
  }
}

async function removeStoredPhotos(photoPaths) {
  const uniquePaths = [...new Set(photoPaths.map((value) => String(value || "").trim()).filter(Boolean))];
  await Promise.all(uniquePaths.map((photoPath) => removeStoredPhoto(photoPath)));
}

async function loadAssignableUsers() {
  const [rows] = await pool.query(
    `SELECT u.id,
            u.name,
            u.username,
            u.email,
            u.role,
            u.status,
            r.role_name,
            r.modules_json,
            r.status AS role_status
     FROM users u
     LEFT JOIN roles r ON r.role_key = u.role
     WHERE u.status='active'
     ORDER BY u.name ASC, u.id ASC`
  );

  return rows
    .filter((row) => {
      const roleKey = normalizeRoleKey(row.role);
      const roleStatus = String(row.role_status || "active").toLowerCase();
      if (roleStatus !== "active" && ![SYSTEM_ROLE_KEYS.ADMIN, SYSTEM_ROLE_KEYS.FIELD_WORK].includes(roleKey)) {
        return false;
      }
      return parseModulesJson(row.modules_json, defaultModulesForRole(roleKey)).includes("calendar");
    })
    .map((row) => ({
      id: Number(row.id),
      name: row.name || "",
      username: row.username || "",
      email: row.email || "",
      role: normalizeRoleKey(row.role),
      roleLabel: roleLabel(row.role, row.role_name)
    }));
}

async function loadEventRow(eventId, connection = pool) {
  const [rows] = await connection.query(
    `SELECT e.*,
            assignee.name AS assignee_name,
            assignee.username AS assignee_username,
            assignee.role AS assignee_role,
            creator.name AS created_by_name,
            creator.username AS created_by_username
     FROM events e
     LEFT JOIN users assignee ON assignee.id = e.user_id
     LEFT JOIN users creator ON creator.id = e.created_by_user_id
     WHERE e.id=?
     LIMIT 1`,
    [eventId]
  );
  return rows[0] || null;
}

exports.meta = async (req, res) => {
  const assignableUsers = isAdmin(req.user)
    ? await loadAssignableUsers()
    : [
        {
          id: Number(req.user.id),
          name: req.user.name || "",
          username: req.user.username || "",
          email: req.user.email || "",
          role: normalizeRoleKey(req.user.role),
          roleLabel: req.user.roleLabel || roleLabel(req.user.role)
        }
      ];

  return res.json({
    canAssignAll: isAdmin(req.user),
    assignableUsers
  });
};

exports.list = async (req, res) => {
  const params = [];
  let where = "";

  if (!isAdmin(req.user)) {
    where = "WHERE e.user_id=?";
    params.push(req.user.id);
  }

  const [rows] = await pool.query(
    `SELECT e.*,
            assignee.name AS assignee_name,
            assignee.username AS assignee_username,
            assignee.role AS assignee_role,
            creator.name AS created_by_name,
            creator.username AS created_by_username
     FROM events e
     LEFT JOIN users assignee ON assignee.id = e.user_id
     LEFT JOIN users creator ON creator.id = e.created_by_user_id
     ${where}
     ORDER BY e.start_datetime ASC, e.id ASC`,
    params
  );

  return res.json(rows.map((row) => serializeEvent(row, req)));
};

exports.create = async (req, res) => {
  const title = String(req.body.title || "").trim();
  const activityType = normalizeActivityType(req.body.activityType);
  const customerName = toNullableText(req.body.customerName);
  const location = toNullableText(req.body.location);
  const startDateTime = toMysqlDateTime(req.body.start_datetime || req.body.startDateTime);
  const endDateTime = toMysqlDateTime(req.body.end_datetime || req.body.endDateTime);
  const allDay = req.body.all_day || req.body.allDay ? 1 : 0;
  const notes = toNullableText(req.body.notes);
  const status = normalizeStatus(req.body.status);
  const requestedAssignee = Number(req.body.user_id || req.body.assigneeUserId || 0);

  if (!title || !startDateTime) {
    return res.status(400).json({ message: "Title and start date are required" });
  }

  if (endDateTime && new Date(endDateTime) < new Date(startDateTime)) {
    return res.status(400).json({ message: "End time must be later than start time" });
  }

  let assigneeUserId = Number(req.user.id);
  if (isAdmin(req.user) && requestedAssignee > 0) {
    const assignableUsers = await loadAssignableUsers();
    const matched = assignableUsers.find((user) => Number(user.id) === requestedAssignee);
    if (!matched) return res.status(400).json({ message: "Assigned user is invalid for calendar activities" });
    assigneeUserId = matched.id;
  }

  const [result] = await pool.query(
    `INSERT INTO events(
      user_id,
      created_by_user_id,
      title,
      activity_type,
      customer_name,
      location,
      start_datetime,
      end_datetime,
      all_day,
      status,
      notes
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      assigneeUserId,
      req.user.id,
      title,
      activityType,
      customerName,
      location,
      startDateTime,
      endDateTime,
      allDay,
      status,
      notes
    ]
  );

  const created = await loadEventRow(result.insertId);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "CALENDAR",
    action: "EVENT_CREATED",
    details: `${title} scheduled for ${startDateTime}. Assigned to ${created?.assignee_name || req.user.name}.`,
    ipAddress: getRequestIp(req)
  });

  return res.status(201).json(serializeEvent(created, req));
};

exports.update = async (req, res) => {
  const eventId = Number(req.params.id);
  if (!eventId) return res.status(400).json({ message: "Invalid event id" });

  const existing = await loadEventRow(eventId);
  if (!existing) return res.status(404).json({ message: "Activity not found" });
  if (!canEditEvent(req.user, existing)) {
    return res.status(403).json({ message: "You can only edit activities you created for yourself" });
  }

  const title = String(req.body.title || "").trim();
  const activityType = normalizeActivityType(req.body.activityType);
  const customerName = toNullableText(req.body.customerName);
  const location = toNullableText(req.body.location);
  const startDateTime = toMysqlDateTime(req.body.start_datetime || req.body.startDateTime);
  const endDateTime = toMysqlDateTime(req.body.end_datetime || req.body.endDateTime);
  const allDay = req.body.all_day || req.body.allDay ? 1 : 0;
  const notes = toNullableText(req.body.notes);
  const status = normalizeStatus(req.body.status || existing.status);

  if (!title || !startDateTime) {
    return res.status(400).json({ message: "Title and start date are required" });
  }

  if (endDateTime && new Date(endDateTime) < new Date(startDateTime)) {
    return res.status(400).json({ message: "End time must be later than start time" });
  }

  let assigneeUserId = Number(existing.user_id);
  if (isAdmin(req.user)) {
    const requestedAssignee = Number(req.body.user_id || req.body.assigneeUserId || 0);
    if (requestedAssignee > 0 && requestedAssignee !== assigneeUserId) {
      const assignableUsers = await loadAssignableUsers();
      const matched = assignableUsers.find((user) => Number(user.id) === requestedAssignee);
      if (!matched) return res.status(400).json({ message: "Assigned user is invalid for calendar activities" });
      assigneeUserId = matched.id;
    }
  }

  await pool.query(
    `UPDATE events
     SET user_id=?,
         title=?,
         activity_type=?,
         customer_name=?,
         location=?,
         start_datetime=?,
         end_datetime=?,
         all_day=?,
         status=?,
         notes=?
     WHERE id=?`,
    [
      assigneeUserId,
      title,
      activityType,
      customerName,
      location,
      startDateTime,
      endDateTime,
      allDay,
      status,
      notes,
      eventId
    ]
  );

  const updated = await loadEventRow(eventId);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "CALENDAR",
    action: "EVENT_UPDATED",
    details: `${updated?.title || title} updated for ${startDateTime}. Status: ${status}.`,
    ipAddress: getRequestIp(req)
  });

  return res.json(serializeEvent(updated, req));
};

exports.submitReport = async (req, res) => {
  const eventId = Number(req.params.id);
  if (!eventId) return res.status(400).json({ message: "Invalid event id" });

  const existing = await loadEventRow(eventId);
  if (!existing) {
    await cleanupUploadedReportFiles(req);
    return res.status(404).json({ message: "Activity not found" });
  }

  if (!canSubmitReport(req.user, existing)) {
    await cleanupUploadedReportFiles(req);
    return res.status(403).json({ message: "You can only submit reports for activities assigned to you" });
  }

  const uploadedFiles = getUploadedReportFiles(req);
  const completionNotes = toNullableText(req.body.completionNotes || req.body.completion_notes);
  const requestedStatus = normalizeStatus(req.body.status || "completed");
  const finalStatus = requestedStatus === "cancelled" ? "cancelled" : requestedStatus;
  const completedAt = finalStatus === "completed" ? toMysqlDateTime(new Date().toISOString()) : null;
  const existingPhotos = parseCompletionPhotos(existing);
  const uploadedPhotos = uploadedFiles
    .map((file) =>
      normalizeStoredPhoto({
        path: `${EVENT_PHOTO_PREFIX}${file.filename}`,
        name: file.originalname || file.filename
      })
    )
    .filter(Boolean);
  const nextPhotos = [...existingPhotos, ...uploadedPhotos];
  const primaryPhoto = getPrimaryCompletionPhoto(nextPhotos);

  await pool.query(
    `UPDATE events
     SET status=?,
         completion_notes=?,
         completion_photo_path=?,
         completion_photo_name=?,
         completion_photos_json=?,
         completed_at=?
     WHERE id=?`,
    [
      finalStatus,
      completionNotes,
      primaryPhoto?.path || null,
      primaryPhoto?.name || null,
      serializeCompletionPhotosJson(nextPhotos),
      completedAt,
      eventId
    ]
  );

  const updated = await loadEventRow(eventId);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "CALENDAR",
    action: "EVENT_REPORT_SUBMITTED",
    details: `${updated?.title || existing.title} marked as ${finalStatus}${
      uploadedPhotos.length
        ? ` with ${uploadedPhotos.length} work photo${uploadedPhotos.length === 1 ? "" : "s"}`
        : ""
    }.`,
    ipAddress: getRequestIp(req)
  });

  return res.json(serializeEvent(updated, req));
};

exports.remove = async (req, res) => {
  const eventId = Number(req.params.id);
  if (!eventId) return res.status(400).json({ message: "Invalid event id" });

  const existing = await loadEventRow(eventId);
  if (!existing) return res.status(404).json({ message: "Activity not found" });
  if (!canEditEvent(req.user, existing)) {
    return res.status(403).json({ message: "You can only delete activities you created for yourself" });
  }

  await pool.query("DELETE FROM events WHERE id=?", [eventId]);
  await removeStoredPhotos([
    ...parseCompletionPhotos(existing).map((photo) => photo.path),
    existing.completion_photo_path
  ]);

  await safeLogAudit({
    userId: req.user.id,
    actorName: req.user.name,
    module: "CALENDAR",
    action: "EVENT_DELETED",
    details: `${existing.title} removed from ${existing.start_datetime}.`,
    ipAddress: getRequestIp(req)
  });

  return res.json({ success: true });
};
