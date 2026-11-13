ALTER TABLE event_registrations DROP COLUMN status;
ALTER TABLE events DROP INDEX uq_event_registration_token, DROP COLUMN registration_token;
