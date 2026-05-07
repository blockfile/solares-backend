const router = require("express").Router();
const { register, login, me, changePassword } = require("../controllers/auth.controller");
const auth = require("../middleware/auth");
const loginRateLimit = require("../middleware/loginRateLimit");
const requireModule = require("../middleware/requireModule");

router.post("/register", auth, requireModule("users"), register);
router.post("/login", loginRateLimit, login);
router.get("/me", auth, me);
router.post("/change-password", auth, changePassword);

module.exports = router;
