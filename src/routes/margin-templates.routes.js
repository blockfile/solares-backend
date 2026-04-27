const router = require("express").Router();
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");
const c = require("./margin-templates.controller");

router.get("/", auth, requireModule("margins", "quotes"), c.list);
router.post("/", auth, requireModule("margins"), c.create);
router.put("/:id", auth, requireModule("margins"), c.update);
router.delete("/:id", auth, requireModule("margins"), c.remove);

module.exports = router;
