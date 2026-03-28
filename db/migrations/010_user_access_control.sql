ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role VARCHAR(32) NOT NULL DEFAULT 'admin' AFTER password_hash,
  ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'active' AFTER role;

UPDATE users
SET role = 'admin'
WHERE role IS NULL OR TRIM(role) = '';

UPDATE users
SET status = 'active'
WHERE status IS NULL OR TRIM(status) = '';

CREATE TABLE IF NOT EXISTS audit_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  actor_name VARCHAR(100) NULL,
  module VARCHAR(100) NOT NULL,
  action VARCHAR(100) NOT NULL,
  details TEXT NULL,
  ip_address VARCHAR(64) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
