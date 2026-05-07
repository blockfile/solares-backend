-- Budget / Expenses module
CREATE TABLE IF NOT EXISTS budget_accounts (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(120)  NOT NULL,
  type          ENUM('income','expense') NOT NULL DEFAULT 'expense',
  description   VARCHAR(500)  NULL,
  is_active     TINYINT(1)    NOT NULL DEFAULT 1,
  created_by    INT           NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_budget_accounts_name (name)
);

CREATE TABLE IF NOT EXISTS budget_transactions (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  account_id      INT           NOT NULL,
  type            ENUM('in','out') NOT NULL,
  amount          DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
  price           DECIMAL(14,4) NULL,
  quantity        DECIMAL(12,4) NULL,
  description     VARCHAR(500)  NULL,
  reference_no    VARCHAR(100)  NULL,
  transaction_date DATE          NOT NULL,
  notes           TEXT          NULL,
  created_by      INT           NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_bt_account FOREIGN KEY (account_id) REFERENCES budget_accounts(id)
);

-- Seed default expense categories
INSERT IGNORE INTO budget_accounts (name, type, description) VALUES
  ('General Expenses',  'expense', 'Default category for general business expenses'),
  ('Equipment',         'expense', 'Tools, machinery, and equipment purchases'),
  ('Labor',             'expense', 'Labor and manpower costs'),
  ('Materials',         'expense', 'Raw materials and supplies'),
  ('Transportation',    'expense', 'Vehicle and transportation costs'),
  ('Marketing',         'expense', 'Advertising and promotional expenses'),
  ('Permits & Fees',    'expense', 'Government permits, licenses, and regulatory fees'),
  ('Sales / Revenue',   'income',  'Income from sales and installations');

-- Grant budget module to admin role
UPDATE roles
SET modules_json = JSON_ARRAY_APPEND(
  CASE
    WHEN JSON_SEARCH(modules_json, 'one', 'budget') IS NULL
    THEN modules_json
    ELSE modules_json
  END,
  '$',
  'budget'
)
WHERE role_key = 'admin'
  AND JSON_SEARCH(modules_json, 'one', 'budget') IS NULL;
