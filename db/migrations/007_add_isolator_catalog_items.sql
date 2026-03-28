INSERT INTO material_prices(material_name, normalized_name, unit, base_price, category, subgroup, source_section)
VALUES
  ('AC ISOLATOR 4P 63amps', 'ac isolator 4p 63amps', 'pc/s', 1200, 'battery_ac', 'protection', 'Isolator ALL BRANCHES'),
  ('DC ISOLATOR 4P 32amps', 'dc isolator 4p 32amps', 'pc/s', 1500, 'battery_ac', 'protection', 'Isolator ALL BRANCHES')
ON DUPLICATE KEY UPDATE
  material_name=VALUES(material_name),
  unit=VALUES(unit),
  base_price=VALUES(base_price),
  category=VALUES(category),
  subgroup=VALUES(subgroup),
  source_section=VALUES(source_section),
  updated_at=CURRENT_TIMESTAMP;
