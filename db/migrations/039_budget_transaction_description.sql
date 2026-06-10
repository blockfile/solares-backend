SET @has_budget_transaction_description := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'budget_transactions'
    AND COLUMN_NAME = 'transaction_description'
);

SET @budget_transaction_description_sql := IF(
  @has_budget_transaction_description = 0,
  'ALTER TABLE budget_transactions ADD COLUMN transaction_description VARCHAR(500) NULL AFTER discount',
  'SELECT 1'
);

PREPARE budget_transaction_description_stmt FROM @budget_transaction_description_sql;
EXECUTE budget_transaction_description_stmt;
DEALLOCATE PREPARE budget_transaction_description_stmt;
