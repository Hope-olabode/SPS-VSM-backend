-- the Control Panel settings, stored as one JSON object per location
CREATE TABLE location_settings (
  location_id  CHAR(36) PRIMARY KEY,
  settings     JSON NOT NULL,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (location_id) REFERENCES locations(id)
);

CREATE TABLE kiosk_tokens (
  id           CHAR(36) PRIMARY KEY,
  location_id  CHAR(36) NOT NULL,
  token_hash   CHAR(64) NOT NULL UNIQUE,   -- SHA-256 of the token; show the real token once
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at   DATETIME NULL,
  FOREIGN KEY (location_id) REFERENCES locations(id)
);

-- append-only: the app only ever INSERTs into this table
CREATE TABLE audit_events (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  action       VARCHAR(60) NOT NULL,       -- e.g. KIOSK_CHECK_IN
  category     ENUM('Visitor','Report','Security') NOT NULL,
  actor_id     CHAR(36) NULL,
  actor_name   VARCHAR(160) NOT NULL DEFAULT 'System',
  actor_role   VARCHAR(30) NULL,
  location_id  CHAR(36) NULL,
  meta         JSON NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_created (created_at),
  KEY idx_audit_action (action)
);

CREATE TABLE sms_campaigns (
  id          CHAR(36) PRIMARY KEY,
  message     TEXT NOT NULL,
  recipients  INT NOT NULL,
  accepted    INT NOT NULL,
  failed      INT NOT NULL,
  mode        VARCHAR(10) NOT NULL,
  sent_by_id  CHAR(36) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
