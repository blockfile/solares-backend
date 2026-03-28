INSERT INTO users (name, username, email, password_hash, role, status, must_change_password)
SELECT
  'Admin',
  'admin',
  'admin@solares.local',
  '$2b$10$hdc8gPe6AlH4.u0S1lnwQOVfHkrymCNS9gUS.vU3czx0vt/5BSsya',
  'admin',
  'active',
  0
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE email = 'admin@solares.local'
);
