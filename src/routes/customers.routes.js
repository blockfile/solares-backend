const router = require("express").Router();
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");
const c = require("./customers.controller");

router.get("/summary",                    auth, requireModule("crm", "finance"), c.summary);
router.get("/",                           auth, requireModule("crm", "finance"), c.listCustomers);
router.post("/",                          auth, requireModule("crm"), c.createCustomer);
router.put("/:id",                        auth, requireModule("crm"), c.updateCustomer);
router.delete("/:id",                     auth, requireModule("crm"), c.deleteCustomer);

router.get("/projects",                   auth, requireModule("crm", "finance"), c.listProjects);
router.post("/projects",                  auth, requireModule("crm"), c.createProject);
router.put("/projects/:id",               auth, requireModule("crm"), c.updateProject);
router.delete("/projects/:id",            auth, requireModule("crm"), c.deleteProject);
router.get("/projects/:id/transactions",  auth, requireModule("crm", "finance"), c.listProjectTransactions);

module.exports = router;
