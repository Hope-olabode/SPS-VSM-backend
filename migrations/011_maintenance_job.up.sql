-- the scheduled maintenance job (src/utils/maintenance.js): auto check-out, overstay flags and data retention
ALTER TABLE visits
  ADD COLUMN auto_checked_out TINYINT(1) NOT NULL DEFAULT 0 AFTER check_out_at,   -- 1 = the job checked this visitor out, not a person
  ADD COLUMN overstay_flagged_at DATETIME NULL AFTER auto_checked_out,            -- set once, when the visit first passed the overstay threshold
  ADD COLUMN anonymized_at DATETIME NULL;                                        -- set when retention stripped the personal details

ALTER TABLE visitors ADD COLUMN anonymized_at DATETIME NULL;
ALTER TABLE pre_registrations ADD COLUMN anonymized_at DATETIME NULL;
ALTER TABLE event_registrations ADD COLUMN anonymized_at DATETIME NULL;
