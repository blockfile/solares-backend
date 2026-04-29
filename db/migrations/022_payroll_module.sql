CREATE TABLE IF NOT EXISTS payroll_employees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_name VARCHAR(160) NOT NULL,
  employee_code VARCHAR(80) NULL,
  role_title VARCHAR(120) NULL,
  pay_type VARCHAR(24) NOT NULL DEFAULT 'monthly',
  base_rate DECIMAL(12,2) NOT NULL DEFAULT 0,
  contact_no VARCHAR(80) NULL,
  notes TEXT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_payroll_employee_code (employee_code),
  KEY idx_payroll_employees_name (employee_name),
  KEY idx_payroll_employees_status (status),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS payroll_entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  pay_date DATE NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  regular_days DECIMAL(8,2) NOT NULL DEFAULT 0,
  regular_hours DECIMAL(8,2) NOT NULL DEFAULT 0,
  overtime_hours DECIMAL(8,2) NOT NULL DEFAULT 0,
  basic_pay DECIMAL(12,2) NOT NULL DEFAULT 0,
  overtime_pay DECIMAL(12,2) NOT NULL DEFAULT 0,
  allowances DECIMAL(12,2) NOT NULL DEFAULT 0,
  bonus DECIMAL(12,2) NOT NULL DEFAULT 0,
  deductions DECIMAL(12,2) NOT NULL DEFAULT 0,
  advances DECIMAL(12,2) NOT NULL DEFAULT 0,
  other_deductions DECIMAL(12,2) NOT NULL DEFAULT 0,
  gross_pay DECIMAL(12,2) NOT NULL DEFAULT 0,
  net_pay DECIMAL(12,2) NOT NULL DEFAULT 0,
  reference_no VARCHAR(100) NULL,
  notes TEXT NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_payroll_entries_employee (employee_id),
  KEY idx_payroll_entries_period (period_start, period_end),
  KEY idx_payroll_entries_status (status),
  FOREIGN KEY (employee_id) REFERENCES payroll_employees(id),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

UPDATE roles
SET modules_json='["calendar","quotes","templates","materials","inventory","payroll","packages","margins","users","roles","audit"]'
WHERE role_key='admin';
