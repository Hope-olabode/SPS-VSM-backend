-- each event gets a secret registration link token (shared as /register/<token>), and each registration has an approval status.
-- Staff-added registrations are APPROVED straight away. Someone who signs up through the link is PENDING while the event requires host approval.
ALTER TABLE events ADD COLUMN registration_token CHAR(32) NULL AFTER require_approval;
UPDATE events SET registration_token = LOWER(HEX(RANDOM_BYTES(16))) WHERE registration_token IS NULL;
ALTER TABLE events
  MODIFY COLUMN registration_token CHAR(32) NOT NULL,
  ADD UNIQUE KEY uq_event_registration_token (registration_token);

ALTER TABLE event_registrations
  ADD COLUMN status ENUM('PENDING','APPROVED') NOT NULL DEFAULT 'APPROVED' AFTER company;
