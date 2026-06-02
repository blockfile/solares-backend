const router = require("express").Router();
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");
const c = require("./quotes.controller");

router.post("/", auth, requireModule("crm", "quotes"), c.createQuoteFromTemplate);
router.get("/", auth, requireModule("crm", "quotes"), c.listQuotes);
router.get("/config", auth, requireModule("crm", "quotes"), c.getPricingConfig);
router.delete("/:id", auth, requireModule("crm", "quotes"), c.deleteQuote);
router.get("/:id", auth, requireModule("crm", "quotes"), c.getQuote);
router.get("/:id/export/customer-excel", auth, requireModule("crm", "quotes"), c.exportCustomerExcel);
router.get("/:id/export/customer-pdf", auth, requireModule("crm", "quotes"), c.exportCustomerPdf);
router.get("/:id/export/company-excel", auth, requireModule("crm", "quotes"), c.exportCompanyExcel);
router.get("/:id/export", auth, requireModule("crm", "quotes"), c.exportQuoteExcel);

module.exports = router;
