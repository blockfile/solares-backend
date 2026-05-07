const LOGIN_IDENTIFIER_MAX_LENGTH = 150;
const PASSWORD_MAX_BYTES = 72;
const USERNAME_PATTERN = /^[a-z0-9._+-]{3,64}$/i;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f]/g;

function normalizeLoginIdentifier(value) {
  return String(value || "").trim();
}

function hasControlChars(value) {
  return CONTROL_CHARS.test(String(value || ""));
}

function isPlausibleLoginIdentifier(identifier) {
  const value = normalizeLoginIdentifier(identifier);
  if (!value || value.length > LOGIN_IDENTIFIER_MAX_LENGTH || hasControlChars(value)) return false;
  return value.includes("@") ? EMAIL_PATTERN.test(value) : USERNAME_PATTERN.test(value);
}

function maskIdentifierForAudit(identifier) {
  const value = normalizeLoginIdentifier(identifier).replace(CONTROL_CHARS_GLOBAL, "");
  if (!value) return "(blank)";

  if (value.includes("@")) {
    const [localPart, ...domainParts] = value.split("@");
    const domain = domainParts.join("@").slice(0, 80);
    const local = localPart || "";
    const visible = local.slice(0, 2);
    return `${visible}${local.length > 2 ? "***" : "*"}@${domain}`;
  }

  if (value.length <= 32) return value;
  return `${value.slice(0, 12)}...${value.slice(-6)} (${value.length} chars)`;
}

function validatePasswordSize(password, label = "Password") {
  if (Buffer.byteLength(String(password || ""), "utf8") > PASSWORD_MAX_BYTES) {
    return `${label} must be ${PASSWORD_MAX_BYTES} bytes or fewer`;
  }
  return null;
}

module.exports = {
  LOGIN_IDENTIFIER_MAX_LENGTH,
  PASSWORD_MAX_BYTES,
  isPlausibleLoginIdentifier,
  maskIdentifierForAudit,
  normalizeLoginIdentifier,
  validatePasswordSize
};
