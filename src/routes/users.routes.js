const router = require("express").Router();
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");
const c = require("./users.controller");

router.get("/", auth, requireModule("users"), c.list);
router.post("/", auth, requireModule("users"), c.create);
router.put("/:id", auth, requireModule("users"), c.update);
router.delete("/:id", auth, requireModule("users"), c.remove);

module.exports = router;
