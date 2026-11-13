-- who is registered for an event. Staff add people from the event page; a phone number can register once per event.
CREATE TABLE event_registrations (
  id                CHAR(36) PRIMARY KEY,
  event_id          CHAR(36) NOT NULL,
  name              VARCHAR(160) NOT NULL,
  email             VARCHAR(190) NULL,
  phone             VARCHAR(20) NOT NULL,       -- +2348012345678, the same form check-in saves
  company           VARCHAR(160) NOT NULL DEFAULT '',
  registered_by_id  CHAR(36) NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_event_phone (event_id, phone),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);
