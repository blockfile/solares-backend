require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./src/routes/auth.routes");
const eventRoutes = require("./src/routes/events.routes");
const templateRoutes = require("./src/routes/templates.routes");
const quoteRoutes = require("./src/routes/quotes.routes");
const materialRoutes = require("./src/routes/materials.routes");
const packagePriceRoutes = require("./src/routes/package-prices.routes");
const userRoutes = require("./src/routes/users.routes");
const roleRoutes = require("./src/routes/roles.routes");
const auditRoutes = require("./src/routes/audit.routes");

const app = express();

app.set("trust proxy", 1);
app.use(cors({ origin: "http://localhost:3000", credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(helmet());
app.use(rateLimit({ windowMs: 60_000, max: 200 }));
app.use("/uploads", express.static("uploads"));

app.use("/api/auth", authRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/quotes", quoteRoutes);
app.use("/api/materials", materialRoutes);
app.use("/api/package-prices", packagePriceRoutes);
app.use("/api/users", userRoutes);
app.use("/api/roles", roleRoutes);
app.use("/api/audit", auditRoutes);

app.get("/api/health", (_, res) => res.json({ ok: true }));

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`Backend running on ${port}`));
