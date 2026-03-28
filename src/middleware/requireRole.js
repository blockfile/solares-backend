const { normalizeRole } = require("../services/accessControl");

module.exports = function requireRole(...roles) {
  const allowed = roles.map((role) => normalizeRole(role)).filter(Boolean);

  return function checkRole(req, res, next) {
    if (!req.user) return res.status(401).json({ message: "Missing authenticated user" });
    if (!allowed.includes(normalizeRole(req.user.role))) {
      return res.status(403).json({ message: "You do not have permission to access this module" });
    }
    return next();
  };
};
