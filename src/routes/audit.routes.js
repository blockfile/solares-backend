const router = require("express").Router();
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");
const c = require("./audit.controller");

router.get("/", auth, requireModule("audit"), c.list);

module.exports = router;
