const router = require("express").Router();
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");
const c = require("./quotes.controller");

router.post("/", auth, requireModule("quotes"), c.createQuoteFromTemplate);
router.get("/", auth, requireModule("quotes"), c.listQuotes);
router.delete("/:id", auth, requireModule("quotes"), c.deleteQuote);
router.get("/:id", auth, requireModule("quotes"), c.getQuote);
router.get("/:id/export/customer-excel", auth, requireModule("quotes"), c.exportCustomerExcel);
router.get("/:id/export/customer-pdf", auth, requireModule("quotes"), c.exportCustomerPdf);
router.get("/:id/export/company-excel", auth, requireModule("quotes"), c.exportCompanyExcel);
router.get("/:id/export", auth, requireModule("quotes"), c.exportQuoteExcel);

module.exports = router;
