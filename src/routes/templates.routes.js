const router = require("express").Router();
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");
const multer = require("multer");
const path = require("path");
const upload = multer({
  dest: "uploads/",
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

const c = require("./templates.controller");

function uploadTemplateWorkbook(req, res, next) {
  upload.single("file")(req, res, (error) => {
    if (error) {
      return res.status(400).json({ message: error.message || "Failed to upload template workbook." });
    }
    return next();
  });
}

router.post("/import", auth, requireModule("templates"), uploadTemplateWorkbook, c.importExcel);
router.post("/", auth, requireModule("templates"), c.createTemplate);
router.post("/:id/duplicate", auth, requireModule("templates"), c.duplicateTemplate);
router.get("/", auth, requireModule("templates", "quotes", "packages", "crm"), c.listTemplates);
router.get("/:id/export/excel-all", auth, requireModule("templates"), c.exportTemplateExcelBundle);
router.get("/:id/export/excel", auth, requireModule("templates"), c.exportTemplateExcel);
router.get("/:id/items", auth, requireModule("templates", "quotes", "crm"), c.listTemplateItems);
router.post("/:id/items", auth, requireModule("templates"), c.createTemplateItem);
router.put("/:id/items/:itemId", auth, requireModule("templates"), c.updateTemplateItem);
router.delete("/:id/items/:itemId", auth, requireModule("templates"), c.deleteTemplateItem);
router.put("/:id", auth, requireModule("templates"), c.updateTemplate);
router.delete("/:id", auth, requireModule("templates"), c.deleteTemplate);

module.exports = router;
