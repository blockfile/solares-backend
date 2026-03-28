ALTER TABLE events
  ADD COLUMN created_by_user_id INT NULL AFTER user_id,
  ADD COLUMN activity_type VARCHAR(40) NOT NULL DEFAULT 'site_visit' AFTER title,
  ADD COLUMN customer_name VARCHAR(160) NULL AFTER activity_type,
  ADD COLUMN location VARCHAR(255) NULL AFTER customer_name,
  ADD COLUMN status VARCHAR(24) NOT NULL DEFAULT 'planned' AFTER all_day,
  ADD COLUMN completion_notes TEXT NULL AFTER notes,
  ADD COLUMN completion_photo_path VARCHAR(255) NULL AFTER completion_notes,
  ADD COLUMN completion_photo_name VARCHAR(255) NULL AFTER completion_photo_path,
  ADD COLUMN completed_at DATETIME NULL AFTER completion_photo_name,
  ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at;

UPDATE events
SET created_by_user_id = user_id
WHERE created_by_user_id IS NULL;

ALTER TABLE events
  MODIFY COLUMN created_by_user_id INT NOT NULL,
  ADD CONSTRAINT fk_events_created_by_user FOREIGN KEY (created_by_user_id) REFERENCES users(id);

CREATE INDEX idx_events_assignee_start ON events(user_id, start_datetime);
CREATE INDEX idx_events_status_start ON events(status, start_datetime);
