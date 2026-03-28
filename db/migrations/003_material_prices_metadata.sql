ALTER TABLE material_prices
  ADD COLUMN category VARCHAR(40) NOT NULL DEFAULT 'other' AFTER base_price,
  ADD COLUMN subgroup VARCHAR(60) NULL AFTER category,
  ADD COLUMN source_section VARCHAR(255) NULL AFTER subgroup;

CREATE INDEX idx_material_prices_category ON material_prices(category);
CREATE INDEX idx_material_prices_subgroup ON material_prices(subgroup);
