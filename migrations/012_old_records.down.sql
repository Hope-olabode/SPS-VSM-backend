ALTER TABLE event_registrations ADD COLUMN anonymized_at DATETIME NULL;
ALTER TABLE pre_registrations ADD COLUMN anonymized_at DATETIME NULL;
ALTER TABLE visitors ADD COLUMN anonymized_at DATETIME NULL;
ALTER TABLE visits ADD COLUMN anonymized_at DATETIME NULL;
DROP TABLE old_records;
