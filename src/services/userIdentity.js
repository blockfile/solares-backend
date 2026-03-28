function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function isValidUsername(value) {
  const username = normalizeUsername(value);
  return /^[a-z0-9][a-z0-9._+-]{2,63}$/.test(username);
}

module.exports = {
  isValidUsername,
  normalizeUsername
};
