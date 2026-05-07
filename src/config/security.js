function getRequiredJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("JWT_SECRET must be set and at least 32 characters long.");
  }
  return secret;
}

function getJwtExpiresIn() {
  return process.env.JWT_EXPIRES_IN || "8h";
}

function getAllowedCorsOrigins() {
  const raw = process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN || "http://localhost:3000";
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function getTrustProxySetting() {
  const raw = process.env.TRUST_PROXY_HOPS;
  if (raw == null || raw === "") return 1;

  const value = String(raw).trim().toLowerCase();
  if (["false", "off", "no"].includes(value)) return false;
  if (["true", "on", "yes"].includes(value)) return true;

  const hops = Number(value);
  if (Number.isInteger(hops) && hops >= 0) return hops;
  throw new Error("TRUST_PROXY_HOPS must be a non-negative integer, true, or false.");
}

module.exports = {
  getAllowedCorsOrigins,
  getJwtExpiresIn,
  getRequiredJwtSecret,
  getTrustProxySetting
};
