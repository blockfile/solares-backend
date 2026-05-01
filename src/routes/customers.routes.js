const router = require("express").Router();
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");
const c = require("./customers.controller");

router.get("/summary",                    auth, requireModule("sales"), c.summary);
router.get("/",                           auth, requireModule("sales"), c.listCustomers);
router.post("/",                          auth, requireModule("sales"), c.createCustomer);
router.put("/:id",                        auth, requireModule("sales"), c.updateCustomer);
router.delete("/:id",                     auth, requireModule("sales"), c.deleteCustomer);

router.get("/projects",                   auth, requireModule("sales"), c.listProjects);
router.post("/projects",                  auth, requireModule("sales"), c.createProject);
router.put("/projects/:id",               auth, requireModule("sales"), c.updateProject);
router.delete("/projects/:id",            auth, requireModule("sales"), c.deleteProject);
router.get("/projects/:id/transactions",  auth, requireModule("sales"), c.listProjectTransactions);

module.exports = router;
