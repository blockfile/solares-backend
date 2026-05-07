ALTER TABLE budget_accounts
  MODIFY COLUMN type ENUM('income','expense','investment','withdrawal') NOT NULL DEFAULT 'expense';
