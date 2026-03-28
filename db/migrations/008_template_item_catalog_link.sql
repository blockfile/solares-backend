ALTER TABLE template_items
  ADD COLUMN catalog_material_id INT NULL AFTER section_key,
  ADD KEY idx_template_items_catalog_material (catalog_material_id),
  ADD CONSTRAINT fk_template_items_catalog_material
    FOREIGN KEY (catalog_material_id) REFERENCES material_prices(id);
