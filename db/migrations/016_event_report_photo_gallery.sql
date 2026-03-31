ALTER TABLE events
  ADD COLUMN completion_photos_json LONGTEXT NULL AFTER completion_photo_name;

UPDATE events
SET completion_photos_json = JSON_ARRAY(
  JSON_OBJECT(
    'path', completion_photo_path,
    'name', COALESCE(NULLIF(completion_photo_name, ''), SUBSTRING_INDEX(completion_photo_path, '/', -1))
  )
)
WHERE completion_photo_path IS NOT NULL
  AND completion_photo_path <> ''
  AND (completion_photos_json IS NULL OR completion_photos_json = '');
