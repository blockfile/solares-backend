const router = require("express").Router();
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");
const c = require("./customers.controller");

router.get("/summary",                    auth, requireModule("budget"), c.summary);
router.get("/",                           auth, requireModule("budget"), c.listCustomers);
router.post("/",                          auth, requireModule("budget"), c.createCustomer);
router.put("/:id",                        auth, requireModule("budget"), c.updateCustomer);
router.delete("/:id",                     auth, requireModule("budget"), c.deleteCustomer);

router.get("/projects",                   auth, requireModule("budget"), c.listProjects);
router.post("/projects",                  auth, requireModule("budget"), c.createProject);
router.put("/projects/:id",               auth, requireModule("budget"), c.updateProject);
router.delete("/projects/:id",            auth, requireModule("budget"), c.deleteProject);
router.get("/projects/:id/transactions",  auth, requireModule("budget"), c.listProjectTransactions);

module.exports = router;
