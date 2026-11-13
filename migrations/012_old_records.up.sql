-- Data retention in two stages (src/utils/maintenance.js):
--   stage 1: records older than the location's retention setting are MOVED here (and deleted from the live tables)
--   stage 2: records here older than ARCHIVE_ANONYMIZE_DAYS lose their personal details (anonymized_at is set)
-- One row per archived visit, pre-registration or event registration, copied as plain values so nothing here links back to a live table.
CREATE TABLE old_records (
  id                CHAR(36) PRIMARY KEY,
  source            ENUM('VISIT','PRE_REGISTRATION','EVENT_REGISTRATION') NOT NULL,
  original_id       CHAR(36) NOT NULL,           -- the id the record had in its live table
  location_id       CHAR(36) NOT NULL,
  name              VARCHAR(160) NOT NULL,
  phone             VARCHAR(20) NULL,
  email             VARCHAR(190) NULL,
  company           VARCHAR(160) NOT NULL DEFAULT '',
  job_title         VARCHAR(120) NULL,
  type              VARCHAR(40) NULL,
  host_name         VARCHAR(160) NOT NULL DEFAULT '',
  purpose           VARCHAR(255) NOT NULL DEFAULT '',
  notes             TEXT NULL,
  resident_company  VARCHAR(160) NULL,
  floor             VARCHAR(60) NULL,
  status            VARCHAR(30) NOT NULL,
  event_title       VARCHAR(190) NULL,
  record_at         DATETIME NOT NULL,           -- check-in time / expected time / end of the event
  check_out_at      DATETIME NULL,
  auto_checked_out  TINYINT(1) NOT NULL DEFAULT 0,
  photo_url         VARCHAR(500) NULL,           -- the file stays under UPLOADS_DIR until stage 2 deletes it
  signature_url     VARCHAR(500) NULL,
  documents_signed  JSON NULL,                   -- [{ title, signedAt }]
  archived_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  anonymized_at     DATETIME NULL,
  KEY idx_old_location_record (location_id, record_at),
  KEY idx_old_anonymize (anonymized_at, record_at)
);

-- 011 marked rows in place; records are now moved instead, so those markers are not needed
ALTER TABLE visits DROP COLUMN anonymized_at;
ALTER TABLE visitors DROP COLUMN anonymized_at;
ALTER TABLE pre_registrations DROP COLUMN anonymized_at;
ALTER TABLE event_registrations DROP COLUMN anonymized_at;
