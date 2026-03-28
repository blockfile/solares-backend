const router = require("express").Router();
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");
const multer = require("multer");
const upload = multer({ dest: "uploads/" });

const c = require("./templates.controller");

router.post("/import", auth, requireModule("templates"), upload.single("file"), c.importExcel);
router.post("/", auth, requireModule("templates"), c.createTemplate);
router.post("/:id/duplicate", auth, requireModule("templates"), c.duplicateTemplate);
router.get("/", auth, requireModule("templates", "quotes"), c.listTemplates);
router.get("/:id/export/excel-all", auth, requireModule("templates"), c.exportTemplateExcelBundle);
router.get("/:id/export/excel", auth, requireModule("templates"), c.exportTemplateExcel);
router.get("/:id/items", auth, requireModule("templates", "quotes"), c.listTemplateItems);
router.post("/:id/items", auth, requireModule("templates"), c.createTemplateItem);
router.put("/:id/items/:itemId", auth, requireModule("templates"), c.updateTemplateItem);
router.delete("/:id/items/:itemId", auth, requireModule("templates"), c.deleteTemplateItem);
router.put("/:id", auth, requireModule("templates"), c.updateTemplate);
router.delete("/:id", auth, requireModule("templates"), c.deleteTemplate);

module.exports = router;
