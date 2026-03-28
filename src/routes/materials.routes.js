const router = require("express").Router();
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");
const c = require("./materials.controller");

router.get("/", auth, requireModule("materials", "quotes"), c.list);
router.post("/", auth, requireModule("materials"), c.create);
router.put("/:id", auth, requireModule("materials"), c.update);
router.delete("/:id", auth, requireModule("materials"), c.remove);

module.exports = router;
