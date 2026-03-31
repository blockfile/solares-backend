-- Add discount_amount column to quotes table when missing
SET @has_quotes_discount_amount := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'quotes'
    AND COLUMN_NAME = 'discount_amount'
);

SET @quote_discount_sql := IF(
  @has_quotes_discount_amount = 0,
  'ALTER TABLE quotes ADD COLUMN discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER total',
  'SELECT 1'
);

PREPARE stmt FROM @quote_discount_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
