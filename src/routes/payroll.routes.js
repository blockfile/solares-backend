const router = require("express").Router();
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");
const c = require("./payroll.controller");

router.get("/", auth, requireModule("payroll"), c.listEntries);
router.post("/", auth, requireModule("payroll"), c.createEntry);
router.get("/summary", auth, requireModule("payroll"), c.summary);
router.get("/employees", auth, requireModule("payroll"), c.listEmployees);
router.post("/employees", auth, requireModule("payroll"), c.createEmployee);
router.put("/employees/:id", auth, requireModule("payroll"), c.updateEmployee);
router.delete("/employees/:id", auth, requireModule("payroll"), c.deactivateEmployee);
router.get("/entries", auth, requireModule("payroll"), c.listEntries);
router.post("/entries", auth, requireModule("payroll"), c.createEntry);
router.put("/entries/:id", auth, requireModule("payroll"), c.updateEntry);
router.delete("/entries/:id", auth, requireModule("payroll"), c.removeEntry);

module.exports = router;
