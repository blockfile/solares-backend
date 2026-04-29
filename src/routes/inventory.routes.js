const router = require("express").Router();
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");
const c = require("./inventory.controller");

router.get("/", auth, requireModule("inventory"), c.list);
router.get("/summary", auth, requireModule("inventory"), c.summary);
router.get("/movements", auth, requireModule("inventory"), c.listMovements);
router.post("/", auth, requireModule("inventory"), c.create);
router.put("/:id", auth, requireModule("inventory"), c.update);
router.delete("/:id", auth, requireModule("inventory"), c.remove);
router.get("/:id/movements", auth, requireModule("inventory"), c.listMovements);
router.post("/:id/movements", auth, requireModule("inventory"), c.createMovement);

module.exports = router;
