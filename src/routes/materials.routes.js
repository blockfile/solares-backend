const router = require("express").Router();
const fs = require("fs");
const path = require("path");
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");
const multer = require("multer");
const c = require("./materials.controller");

const uploadDir = path.join(process.cwd(), "uploads", "material-price-lists");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeBase = path
      .basename(file.originalname || "price-list", ext)
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "price-list";
    cb(null, `${Date.now()}-${safeBase}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 20 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    const ext = String(path.extname(file.originalname || "")).toLowerCase();
    const allowed = new Set([".pdf", ".xlsx", ".xls", ".csv", ".json"]);
    if (!allowed.has(ext)) {
      cb(new Error("Only PDF, Excel, CSV, and JSON price lists are supported."));
      return;
    }
    cb(null, true);
  }
});

function uploadPriceList(req, res, next) {
  upload.single("file")(req, res, (error) => {
    if (error) {
      return res.status(400).json({ message: error.message || "Failed to upload price list." });
    }
    return next();
  });
}

router.get("/", auth, requireModule("materials", "quotes"), c.list);
router.get("/suppliers", auth, requireModule("materials"), c.listSuppliers);
router.post("/suppliers", auth, requireModule("materials"), c.createSupplier);
router.put("/suppliers/:id", auth, requireModule("materials"), c.updateSupplier);
router.get("/price-lists", auth, requireModule("materials"), c.listPriceLists);
router.get("/comparison", auth, requireModule("materials"), c.listComparison);
router.post(
  "/import-price-list",
  auth,
  requireModule("materials"),
  uploadPriceList,
  c.importSupplierPriceList
);
router.post("/:id/select-supplier-price", auth, requireModule("materials"), c.selectSupplierPrice);
router.post("/", auth, requireModule("materials"), c.create);
router.put("/:id", auth, requireModule("materials"), c.update);
router.delete("/:id", auth, requireModule("materials"), c.remove);

module.exports = router;
