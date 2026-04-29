CREATE TABLE IF NOT EXISTS inventory_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  item_name VARCHAR(255) NOT NULL,
  sku VARCHAR(80) NULL,
  category VARCHAR(80) NOT NULL DEFAULT 'general',
  unit VARCHAR(40) NULL,
  location VARCHAR(120) NULL,
  minimum_quantity DECIMAL(12,3) NOT NULL DEFAULT 0,
  current_quantity DECIMAL(12,3) NOT NULL DEFAULT 0,
  notes TEXT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_inventory_items_sku (sku),
  KEY idx_inventory_items_name (item_name),
  KEY idx_inventory_items_category (category),
  KEY idx_inventory_items_active (is_active),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  item_id INT NOT NULL,
  movement_type VARCHAR(32) NOT NULL,
  quantity DECIMAL(12,3) NOT NULL,
  unit_cost DECIMAL(12,2) NULL,
  reference_no VARCHAR(100) NULL,
  notes TEXT NULL,
  movement_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_inventory_movements_item (item_id),
  KEY idx_inventory_movements_date (movement_date),
  KEY idx_inventory_movements_type (movement_type),
  FOREIGN KEY (item_id) REFERENCES inventory_items(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

UPDATE roles
SET modules_json='["calendar","quotes","templates","materials","inventory","packages","margins","users","roles","audit"]'
WHERE role_key='admin';
