const fs = require("fs");
const path = require("path");
const router = require("express").Router();
const multer = require("multer");
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");
const c = require("./budget.controller");

// ─────────────────────────────────────────────
// Upload setup
// ─────────────────────────────────────────────
const uploadDir = path.join(process.cwd(), "uploads", "budget-imports");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();

    const safeBase = path
      .basename(file.originalname || "budget", ext)
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "budget";

    cb(null, `${Date.now()}-${safeBase}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = String(path.extname(file.originalname || "")).toLowerCase();

    if (ext !== ".xlsx") {
      cb(new Error("Only Excel .xlsx files are supported."));
      return;
    }

    cb(null, true);
  }
});

function uploadExcel(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        message: err.message || "Upload failed."
      });
    }
    return next();
  });
}

// ─────────────────────────────────────────────
// Budget Summary + Accounts
// ─────────────────────────────────────────────
router.get("/summary",         auth, requireModule("budget", "accounting"), c.summary);

router.get("/accounts",        auth, requireModule("budget", "accounting"), c.listAccounts);
router.post("/accounts",       auth, requireModule("budget", "accounting"), c.createAccount);
router.put("/accounts/:id",    auth, requireModule("budget", "accounting"), c.updateAccount);
router.delete("/accounts/:id", auth, requireModule("budget", "accounting"), c.deleteAccount);

// ─────────────────────────────────────────────
// Import + Bulk Actions
// ─────────────────────────────────────────────
router.post("/import",         auth, requireModule("budget"), uploadExcel, c.importExcel);
router.get("/import-batches",  auth, requireModule("budget"), c.listImportBatches);
router.delete("/import-batches/:batchId", auth, requireModule("budget"), c.deleteImportBatch);

// ✅ EXISTING
router.put("/bulk/project",    auth, requireModule("budget"), c.bulkAssignProject);

// ✅ NEW: BULK DELETE (IMPORTANT)
router.delete("/bulk",         auth, requireModule("budget"), c.bulkDeleteTransactions);

// ─────────────────────────────────────────────
// Transactions CRUD
// ─────────────────────────────────────────────
router.get("/export/raw-logs", auth, requireModule("budget"), c.exportRawLogsExcel);
router.get("/",                auth, requireModule("budget"), c.listTransactions);
router.post("/",               auth, requireModule("budget"), c.createTransaction);

// ⚠️ IMPORTANT: keep these LAST
router.put("/:id",             auth, requireModule("budget"), c.updateTransaction);
router.delete("/:id",          auth, requireModule("budget"), c.deleteTransaction);

module.exports = router;
