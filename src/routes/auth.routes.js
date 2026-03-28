const router = require("express").Router();
const { register, login, me, changePassword } = require("../controllers/auth.controller");
const auth = require("../middleware/auth");
const requireModule = require("../middleware/requireModule");

router.post("/register", auth, requireModule("users"), register);
router.post("/login", login);
router.get("/me", auth, me);
router.post("/change-password", auth, changePassword);

module.exports = router;
