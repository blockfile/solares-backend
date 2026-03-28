-- Fix subgroup classification for protection items based on actual material name.
UPDATE material_prices
SET subgroup = 'ats_mts', category = 'battery_ac'
WHERE (
  LOWER(material_name) REGEXP '(^|[^a-z])(ats|mts)([^a-z]|$)'
  OR LOWER(normalized_name) REGEXP '(^| )ats( |$)|(^| )mts( |$)'
);

UPDATE material_prices
SET subgroup = 'spd', category = 'battery_ac'
WHERE LOWER(material_name) LIKE '%spd%'
  AND NOT (
    LOWER(material_name) REGEXP '(^|[^a-z])(ats|mts)([^a-z]|$)'
    OR LOWER(normalized_name) REGEXP '(^| )ats( |$)|(^| )mts( |$)'
  );
