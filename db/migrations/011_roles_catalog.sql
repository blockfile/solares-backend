ALTER TABLE users
  MODIFY COLUMN role VARCHAR(64) NOT NULL DEFAULT 'admin';

CREATE TABLE IF NOT EXISTS roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  role_key VARCHAR(64) NOT NULL UNIQUE,
  role_name VARCHAR(100) NOT NULL,
  description VARCHAR(255) NULL,
  modules_json LONGTEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

INSERT INTO roles (role_key, role_name, description, modules_json, status, is_system)
SELECT
  'admin',
  'Admin',
  'Full access to all SOLARES modules.',
  '["calendar","quotes","templates","materials","packages","margins","users","roles","audit"]',
  'active',
  1
WHERE NOT EXISTS (
  SELECT 1 FROM roles WHERE role_key = 'admin'
);

INSERT INTO roles (role_key, role_name, description, modules_json, status, is_system)
SELECT
  'field_work',
  'Field Work',
  'Access is limited to the Calendar module for field scheduling.',
  '["calendar"]',
  'active',
  1
WHERE NOT EXISTS (
  SELECT 1 FROM roles WHERE role_key = 'field_work'
);
