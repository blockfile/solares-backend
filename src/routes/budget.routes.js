const router = require("express").Router();
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");
const c = require("./budget.controller");

router.get("/summary",      auth, requireModule("budget"), c.summary);
router.get("/accounts",     auth, requireModule("budget"), c.listAccounts);
router.post("/accounts",    auth, requireModule("budget"), c.createAccount);
router.put("/accounts/:id", auth, requireModule("budget"), c.updateAccount);
router.delete("/accounts/:id", auth, requireModule("budget"), c.deleteAccount);

router.get("/",          auth, requireModule("budget"), c.listTransactions);
router.post("/",         auth, requireModule("budget"), c.createTransaction);
router.put("/:id",       auth, requireModule("budget"), c.updateTransaction);
router.delete("/:id",    auth, requireModule("budget"), c.deleteTransaction);

module.exports = router;
