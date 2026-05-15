-- Financial bookkeeping records
CREATE TABLE IF NOT EXISTS budget_bookkeeping_entries (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  section       ENUM('sales','expense','accounts_receivable','accounts_payable') NOT NULL,
  entry_date    DATE          NULL,
  description   VARCHAR(500)  NULL,
  debit         DECIMAL(14,2) NULL,
  credit        DECIMAL(14,2) NULL,
  client        VARCHAR(160)  NULL,
  total         DECIMAL(14,2) NULL,
  paid          DECIMAL(14,2) NULL,
  remaining     DECIMAL(14,2) NULL,
  supplier      VARCHAR(160)  NULL,
  amount_due    DECIMAL(14,2) NULL,
  due_date      DATE          NULL,
  created_by    INT           NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_bookkeeping_section (section),
  KEY idx_bookkeeping_entry_date (entry_date),
  KEY idx_bookkeeping_due_date (due_date),
  CONSTRAINT fk_bookkeeping_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
