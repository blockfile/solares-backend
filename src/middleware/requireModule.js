const { hasModuleAccess } = require("../services/accessControl");

module.exports = function requireModule(...modules) {
  return function checkModuleAccess(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ message: "Missing authenticated user" });
    }

    if (!modules.some((moduleKey) => hasModuleAccess(req.user, moduleKey))) {
      return res.status(403).json({ message: "You do not have access to this module" });
    }

    return next();
  };
};
