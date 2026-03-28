-- Add discount_amount column to quotes table
ALTER TABLE quotes
  ADD COLUMN discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER total;
