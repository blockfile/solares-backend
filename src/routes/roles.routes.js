const router = require("express").Router();
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");
const c = require("./roles.controller");

router.get("/modules", auth, requireModule("roles"), c.modules);
router.get("/", auth, requireModule("roles"), c.list);
router.post("/", auth, requireModule("roles"), c.create);
router.put("/:key", auth, requireModule("roles"), c.update);

module.exports = router;
