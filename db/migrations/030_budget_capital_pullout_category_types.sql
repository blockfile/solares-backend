UPDATE budget_accounts
SET type = 'investment'
WHERE LOWER(name) = 'capital';

UPDATE budget_accounts
SET type = 'withdrawal'
WHERE LOWER(name) IN ('pull out', 'pullout');
