ALTER TABLE event_registrations DROP COLUMN anonymized_at;
ALTER TABLE pre_registrations DROP COLUMN anonymized_at;
ALTER TABLE visitors DROP COLUMN anonymized_at;
ALTER TABLE visits DROP COLUMN anonymized_at, DROP COLUMN overstay_flagged_at, DROP COLUMN auto_checked_out;
