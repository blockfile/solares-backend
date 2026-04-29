const MODULE_DEFINITIONS = [
  {
    key: "calendar",
    label: "Calendar",
    description: "View and manage calendar events."
  },
  {
    key: "quotes",
    label: "Quotes",
    description: "Create and export customer quotations."
  },
  {
    key: "templates",
    label: "Template Manager",
    description: "Maintain costing templates and items."
  },
  {
    key: "materials",
    label: "Material Prices",
    description: "Manage the material catalog and pricing."
  },
  {
    key: "inventory",
    label: "Inventory",
    description: "Track material stock on hand, receipts, usage, and adjustments."
  },
  {
    key: "packages",
    label: "Package Prices",
    description: "Manage package price presets."
  },
  {
    key: "margins",
    label: "Margin Setup",
    description: "Manage reusable pricing margin templates."
  },
  {
    key: "users",
    label: "Users",
    description: "Create users and assign roles."
  },
  {
    key: "roles",
    label: "Roles",
    description: "Create and edit role permissions."
  },
  {
    key: "audit",
    label: "Audit",
    description: "Review activity logs and history."
  }
];

const SYSTEM_ROLE_KEYS = {
  ADMIN: "admin",
  FIELD_WORK: "field_work"
};

const MODULE_MAP = new Map(MODULE_DEFINITIONS.map((definition) => [definition.key, definition]));
const ALL_MODULE_KEYS = MODULE_DEFINITIONS.map((definition) => definition.key);

function normalizeRoleKey(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || SYSTEM_ROLE_KEYS.FIELD_WORK;
}

function normalizeModuleKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function humanizeRoleKey(roleKey) {
  return normalizeRoleKey(roleKey)
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function roleLabel(roleKey, roleName = "") {
  const explicit = String(roleName || "").trim();
  if (explicit) return explicit;
  if (normalizeRoleKey(roleKey) === SYSTEM_ROLE_KEYS.ADMIN) return "Admin";
  if (normalizeRoleKey(roleKey) === SYSTEM_ROLE_KEYS.FIELD_WORK) return "Field Work";
  return humanizeRoleKey(roleKey) || "Field Work";
}

function defaultModulesForRole(roleKey) {
  const normalized = normalizeRoleKey(roleKey);
  if (normalized === SYSTEM_ROLE_KEYS.ADMIN) return [...ALL_MODULE_KEYS];
  if (normalized === SYSTEM_ROLE_KEYS.FIELD_WORK) return ["calendar"];
  return [];
}

function normalizeModules(value, fallback = []) {
  let source = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      source = source
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    }
  }

  if (!Array.isArray(source)) {
    source = Array.isArray(fallback) ? fallback : defaultModulesForRole(fallback);
  }

  const seen = new Set();
  const modules = [];
  for (const item of source) {
    const key = normalizeModuleKey(item);
    if (!MODULE_MAP.has(key) || seen.has(key)) continue;
    seen.add(key);
    modules.push(key);
  }
  return modules;
}

function parseModulesJson(value, fallback = []) {
  return normalizeModules(value, fallback);
}

function hasModuleAccess(user, moduleKey) {
  const key = normalizeModuleKey(moduleKey);
  return normalizeModules(user?.permissions, defaultModulesForRole(user?.role)).includes(key);
}

function listModules() {
  return MODULE_DEFINITIONS.map((definition) => ({ ...definition }));
}

function getAllModuleKeys() {
  return [...ALL_MODULE_KEYS];
}

module.exports = {
  MODULE_DEFINITIONS,
  SYSTEM_ROLE_KEYS,
  defaultModulesForRole,
  getAllModuleKeys,
  hasModuleAccess,
  listModules,
  normalizeModuleKey,
  normalizeModules,
  normalizeRoleKey,
  parseModulesJson,
  roleLabel
};
