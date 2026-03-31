SET @has_events_completion_photos_json := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'events'
    AND COLUMN_NAME = 'completion_photos_json'
);

SET @events_photo_gallery_sql := IF(
  @has_events_completion_photos_json = 0,
  'ALTER TABLE events ADD COLUMN completion_photos_json LONGTEXT NULL AFTER completion_photo_name',
  'SELECT 1'
);

PREPARE stmt FROM @events_photo_gallery_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

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
