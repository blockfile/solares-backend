SET @has_username_column := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'username'
);

SET @sql := IF(
  @has_username_column = 0,
  'ALTER TABLE users ADD COLUMN username VARCHAR(64) NULL AFTER name',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE users
SET username = LOWER(SUBSTRING_INDEX(email, '@', 1))
WHERE username IS NULL OR TRIM(username) = '';

UPDATE users
SET username = CONCAT('user_', id)
WHERE username IS NULL OR TRIM(username) = '';

UPDATE users u
JOIN (
  SELECT username
  FROM users
  WHERE username IS NOT NULL AND TRIM(username) <> ''
  GROUP BY username
  HAVING COUNT(*) > 1
) dup ON dup.username = u.username
SET u.username = CONCAT(LEFT(u.username, 54), '_', u.id);

ALTER TABLE users
  MODIFY COLUMN username VARCHAR(64) NOT NULL;

SET @has_username_index := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND INDEX_NAME = 'users_username_unique'
);

SET @sql := IF(
  @has_username_index = 0,
  'CREATE UNIQUE INDEX users_username_unique ON users(username)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
