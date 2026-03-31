CREATE TABLE IF NOT EXISTS suppliers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  supplier_name VARCHAR(160) NOT NULL,
  normalized_name VARCHAR(160) NOT NULL UNIQUE,
  is_preferred TINYINT(1) NOT NULL DEFAULT 0,
  notes TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS supplier_price_lists (
  id INT AUTO_INCREMENT PRIMARY KEY,
  supplier_id INT NOT NULL,
  source_filename VARCHAR(255) NOT NULL,
  stored_path VARCHAR(255) NULL,
  file_type VARCHAR(32) NOT NULL,
  apply_to_catalog TINYINT(1) NOT NULL DEFAULT 1,
  replace_existing TINYINT(1) NOT NULL DEFAULT 1,
  imported_count INT NOT NULL DEFAULT 0,
  inserted_count INT NOT NULL DEFAULT 0,
  updated_count INT NOT NULL DEFAULT 0,
  removed_count INT NOT NULL DEFAULT 0,
  skipped_count INT NOT NULL DEFAULT 0,
  uploaded_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS supplier_material_prices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  supplier_id INT NOT NULL,
  price_list_id INT NOT NULL,
  material_id INT NULL,
  material_name VARCHAR(255) NOT NULL,
  normalized_name VARCHAR(255) NOT NULL,
  unit VARCHAR(50) NULL,
  base_price DECIMAL(12,2) NOT NULL DEFAULT 0,
  category VARCHAR(40) NOT NULL DEFAULT 'other',
  subgroup VARCHAR(60) NULL,
  source_section VARCHAR(255) NULL,
  metadata_json LONGTEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_supplier_material_price (supplier_id, normalized_name),
  KEY idx_supplier_material_normalized (normalized_name),
  KEY idx_supplier_material_material (material_id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  FOREIGN KEY (price_list_id) REFERENCES supplier_price_lists(id),
  FOREIGN KEY (material_id) REFERENCES material_prices(id) ON DELETE SET NULL
);

SET @has_material_prices_active_supplier_id := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'material_prices'
    AND COLUMN_NAME = 'active_supplier_id'
);

SET @material_prices_active_supplier_id_sql := IF(
  @has_material_prices_active_supplier_id = 0,
  'ALTER TABLE material_prices ADD COLUMN active_supplier_id INT NULL AFTER source_section',
  'SELECT 1'
);

PREPARE stmt FROM @material_prices_active_supplier_id_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_material_prices_active_price_list_id := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'material_prices'
    AND COLUMN_NAME = 'active_price_list_id'
);

SET @material_prices_active_price_list_id_sql := IF(
  @has_material_prices_active_price_list_id = 0,
  'ALTER TABLE material_prices ADD COLUMN active_price_list_id INT NULL AFTER active_supplier_id',
  'SELECT 1'
);

PREPARE stmt FROM @material_prices_active_price_list_id_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_material_prices_price_selection_mode := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'material_prices'
    AND COLUMN_NAME = 'price_selection_mode'
);

SET @material_prices_price_selection_mode_sql := IF(
  @has_material_prices_price_selection_mode = 0,
  'ALTER TABLE material_prices ADD COLUMN price_selection_mode VARCHAR(32) NOT NULL DEFAULT ''catalog_auto'' AFTER active_price_list_id',
  'SELECT 1'
);

PREPARE stmt FROM @material_prices_price_selection_mode_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_idx_material_prices_active_supplier := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'material_prices'
    AND INDEX_NAME = 'idx_material_prices_active_supplier'
);

SET @material_prices_active_supplier_idx_sql := IF(
  @has_idx_material_prices_active_supplier = 0,
  'ALTER TABLE material_prices ADD KEY idx_material_prices_active_supplier (active_supplier_id)',
  'SELECT 1'
);

PREPARE stmt FROM @material_prices_active_supplier_idx_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_idx_material_prices_active_price_list := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'material_prices'
    AND INDEX_NAME = 'idx_material_prices_active_price_list'
);

SET @material_prices_active_price_list_idx_sql := IF(
  @has_idx_material_prices_active_price_list = 0,
  'ALTER TABLE material_prices ADD KEY idx_material_prices_active_price_list (active_price_list_id)',
  'SELECT 1'
);

PREPARE stmt FROM @material_prices_active_price_list_idx_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_fk_material_prices_active_supplier := (
  SELECT COUNT(*)
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'material_prices'
    AND CONSTRAINT_NAME = 'fk_material_prices_active_supplier'
);

SET @material_prices_active_supplier_fk_sql := IF(
  @has_fk_material_prices_active_supplier = 0,
  'ALTER TABLE material_prices ADD CONSTRAINT fk_material_prices_active_supplier FOREIGN KEY (active_supplier_id) REFERENCES suppliers(id)',
  'SELECT 1'
);

PREPARE stmt FROM @material_prices_active_supplier_fk_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_fk_material_prices_active_price_list := (
  SELECT COUNT(*)
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'material_prices'
    AND CONSTRAINT_NAME = 'fk_material_prices_active_price_list'
);

SET @material_prices_active_price_list_fk_sql := IF(
  @has_fk_material_prices_active_price_list = 0,
  'ALTER TABLE material_prices ADD CONSTRAINT fk_material_prices_active_price_list FOREIGN KEY (active_price_list_id) REFERENCES supplier_price_lists(id)',
  'SELECT 1'
);

PREPARE stmt FROM @material_prices_active_price_list_fk_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
