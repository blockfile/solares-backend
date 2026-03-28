const router = require("express").Router();
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");
const c = require("./package-prices.controller");

router.get("/", auth, requireModule("packages", "quotes"), c.list);
router.post("/", auth, requireModule("packages"), c.create);
router.put("/:id", auth, requireModule("packages"), c.update);
router.delete("/:id", auth, requireModule("packages"), c.remove);

module.exports = router;
