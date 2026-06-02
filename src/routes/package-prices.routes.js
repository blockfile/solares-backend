const router = require("express").Router();
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");
const c = require("./package-prices.controller");

router.get("/costing", auth, requireModule("packages", "quotes", "finance", "crm"), c.costing);
router.get("/", auth, requireModule("packages", "quotes", "finance", "crm"), c.list);
router.post("/", auth, requireModule("packages"), c.create);
router.put("/:id", auth, requireModule("packages"), c.update);
router.delete("/:id", auth, requireModule("packages"), c.remove);

module.exports = router;
