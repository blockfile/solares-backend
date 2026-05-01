-- Customers & Sales module
CREATE TABLE IF NOT EXISTS customers (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(160) NOT NULL,
  contact       VARCHAR(120) NULL,
  address       VARCHAR(500) NULL,
  notes         TEXT         NULL,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_by    INT          NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_customers_name (name)
);

-- Projects: one customer can have multiple projects/contracts
CREATE TABLE IF NOT EXISTS customer_projects (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  customer_id   INT           NOT NULL,
  project_name  VARCHAR(200)  NOT NULL,
  sale_amount   DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  project_date  DATE          NULL,
  status        VARCHAR(32)   NOT NULL DEFAULT 'active',
  notes         TEXT          NULL,
  created_by    INT           NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_cp_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
);

-- Link budget transactions to a project
ALTER TABLE budget_transactions
  ADD COLUMN IF NOT EXISTS project_id INT NULL,
  ADD CONSTRAINT fk_bt_project FOREIGN KEY (project_id) REFERENCES customer_projects(id);
