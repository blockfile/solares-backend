INSERT INTO material_prices(material_name, normalized_name, unit, base_price, category, subgroup, source_section)
VALUES
  ('Wire Ferrules 2.5mm2 (AWG #14)', 'wire ferrules 2 5mm awg 14', 'pack', 100, 'battery_ac', 'cable', 'Wire Ferrules'),
  ('Wire Ferrules 4.0mm2 (AWG #12)', 'wire ferrules 4mm awg 12', 'pack', 120, 'battery_ac', 'cable', 'Wire Ferrules'),
  ('Wire Ferrules 6.0mm2 (AWG #10)', 'wire ferrules 6mm awg 10', 'pack', 140, 'battery_ac', 'cable', 'Wire Ferrules'),
  ('Wire Ferrules 10mm2 (AWG #7)', 'wire ferrules 10mm awg 7', 'pack', 160, 'battery_ac', 'cable', 'Wire Ferrules'),
  ('Wire Ferrules 16mm2 (AWG #5)', 'wire ferrules 16mm awg 5', 'pack', 200, 'battery_ac', 'cable', 'Wire Ferrules'),
  ('Wire Ferrules 25mm2 (AWG #4)', 'wire ferrules 25mm awg 4', 'pack', 190, 'battery_ac', 'cable', 'Wire Ferrules'),
  ('Wire Ferrules 35mm2 (AWG #2)', 'wire ferrules 35mm awg 2', 'pack', 210, 'battery_ac', 'cable', 'Wire Ferrules'),
  ('Wire Ferrules 50mm2 (AWG #1)', 'wire ferrules 50mm awg 1', 'pack', 420, 'battery_ac', 'cable', 'Wire Ferrules'),

  ('Cable Tie 3 x 150', 'cable tie 3 150', 'pack', 55, 'pv', 'cable', 'Cable Tie'),
  ('Cable Tie 4 x 200', 'cable tie 4 200', 'pack', 100, 'pv', 'cable', 'Cable Tie'),
  ('Cable Tie 5 x 300', 'cable tie 5 300', 'pack', 170, 'pv', 'cable', 'Cable Tie'),

  ('35mm Din Rail One meter', '35mm din rail one meter', 'PCS', 290, 'battery_ac', 'mounting', 'Metal Enclosure'),

  ('Junction Box 100*100*70', 'junction box 100 100 70', 'PCS', 120, 'pv', 'enclosure', 'Junction Box'),
  ('Junction Box 150*150*70', 'junction box 150 150 70', 'PCS', 130, 'pv', 'enclosure', 'Junction Box'),
  ('Junction Box 200*200*80', 'junction box 200 200 80', 'PCS', 240, 'pv', 'enclosure', 'Junction Box'),
  ('Junction Box 255x200x80', 'junction box 255x200x80', 'PCS', 260, 'pv', 'enclosure', 'Junction Box'),

  ('Metal Enclosure 250*300*160mm', 'metal enclosure 250 300 160mm', 'PCS', 1400, 'battery_ac', 'enclosure', 'Metal Enclosure'),
  ('Metal Enclosure 300*400*200mm', 'metal enclosure 300 400 200mm', 'PCS', 1900, 'battery_ac', 'enclosure', 'Metal Enclosure'),
  ('Metal Enclosure 400*500*200mm', 'metal enclosure 400 500 200mm', 'PCS', 2900, 'battery_ac', 'enclosure', 'Metal Enclosure'),
  ('Metal Enclosure 500*600*200mm', 'metal enclosure 500 600 200mm', 'PCS', 4100, 'battery_ac', 'enclosure', 'Metal Enclosure'),
  ('Metal Enclosure 500*700*200mm', 'metal enclosure 500 700 200mm', 'PCS', 4400, 'battery_ac', 'enclosure', 'Metal Enclosure')
ON DUPLICATE KEY UPDATE
  material_name=VALUES(material_name),
  unit=VALUES(unit),
  base_price=VALUES(base_price),
  category=VALUES(category),
  subgroup=VALUES(subgroup),
  source_section=VALUES(source_section),
  updated_at=CURRENT_TIMESTAMP;
