CREATE TABLE IF NOT EXISTS package_prices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  template_id INT NOT NULL,
  scenario_key VARCHAR(80) NOT NULL,
  scenario_label VARCHAR(120) NOT NULL,
  package_price DECIMAL(12,2) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_package_template_scenario (template_id, scenario_key),
  KEY idx_package_template (template_id),
  CONSTRAINT fk_package_prices_template FOREIGN KEY (template_id) REFERENCES quote_templates(id)
);

ALTER TABLE quotes
  ADD COLUMN pricing_mode VARCHAR(30) NOT NULL DEFAULT 'formula' AFTER installation_rate_per_kw,
  ADD COLUMN package_price_target DECIMAL(12,2) NULL AFTER pricing_mode,
  ADD COLUMN package_price_id INT NULL AFTER package_price_target,
  ADD KEY idx_quotes_package_price_id (package_price_id),
  ADD CONSTRAINT fk_quotes_package_price FOREIGN KEY (package_price_id) REFERENCES package_prices(id);
