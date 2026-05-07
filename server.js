require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const {
  getAllowedCorsOrigins,
  getRequiredJwtSecret,
  getTrustProxySetting
} = require("./src/config/security");

const authRoutes = require("./src/routes/auth.routes");
const eventRoutes = require("./src/routes/events.routes");
const templateRoutes = require("./src/routes/templates.routes");
const quoteRoutes = require("./src/routes/quotes.routes");
const materialRoutes = require("./src/routes/materials.routes");
const inventoryRoutes = require("./src/routes/inventory.routes");
const payrollRoutes = require("./src/routes/payroll.routes");
const packagePriceRoutes = require("./src/routes/package-prices.routes");
const marginTemplateRoutes = require("./src/routes/margin-templates.routes");
const userRoutes = require("./src/routes/users.routes");
const roleRoutes = require("./src/routes/roles.routes");
const auditRoutes = require("./src/routes/audit.routes");
const budgetRoutes = require("./src/routes/budget.routes");
const customerRoutes = require("./src/routes/customers.routes");

const app = express();

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

getRequiredJwtSecret();

const allowedCorsOrigins = new Set(getAllowedCorsOrigins());

function getRequestHosts(req) {
  return [
    req.get("host"),
    String(req.headers["x-forwarded-host"] || "").split(",")[0].trim()
  ].filter(Boolean);
}

function isSameHostOrigin(req, origin) {
  try {
    const originHost = new URL(origin).host;
    return getRequestHosts(req).some((host) => host === originHost);
  } catch {
    return false;
  }
}

app.disable("x-powered-by");
app.set("trust proxy", getTrustProxySetting());
app.use(
  cors((req, callback) => {
    const origin = req.headers.origin;
    const allowed = !origin || allowedCorsOrigins.has(origin) || isSameHostOrigin(req, origin);
    callback(allowed ? null : new Error("Origin not allowed by CORS"), {
      origin: allowed,
      credentials: true
    });
  })
);
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "1mb" }));
app.use(helmet());
app.use(
  rateLimit({
    windowMs: 60_000,
    max: toPositiveInteger(process.env.API_RATE_LIMIT_PER_MINUTE, 200),
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many requests. Please wait and try again." }
  })
);
app.use("/uploads", express.static("uploads"));

app.use("/api/auth", authRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/quotes", quoteRoutes);
app.use("/api/materials", materialRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/payroll", payrollRoutes);
app.use("/api/package-prices", packagePriceRoutes);
app.use("/api/margin-templates", marginTemplateRoutes);
app.use("/api/users", userRoutes);
app.use("/api/roles", roleRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/budget", budgetRoutes);
app.use("/api/customers", customerRoutes);

app.get("/api/health", (_, res) => res.json({ ok: true }));

app.use((error, _req, res, next) => {
  if (error?.message === "Origin not allowed by CORS") {
    return res.status(403).json({ message: "Origin not allowed" });
  }
  return next(error);
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`Backend running on ${port}`));
