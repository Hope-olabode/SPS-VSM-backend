CREATE TABLE documents (
  id                 CHAR(36) PRIMARY KEY,
  title              VARCHAR(160) NOT NULL,
  type               ENUM('NDA','SAFETY_BRIEFING','WIFI_POLICY','OTHER') NOT NULL DEFAULT 'NDA',
  content            LONGTEXT NOT NULL,
  require_signature  TINYINT(1) NOT NULL DEFAULT 1,
  active             TINYINT(1) NOT NULL DEFAULT 1,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE document_signatures (
  id               CHAR(36) PRIMARY KEY,
  visit_id         CHAR(36) NOT NULL,
  document_id      CHAR(36) NOT NULL,
  signature_image  LONGTEXT NOT NULL,   -- data URL from the signature pad
  signed_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (visit_id) REFERENCES visits(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES documents(id)
);

CREATE TABLE events (
  id               CHAR(36) PRIMARY KEY,
  location_id      CHAR(36) NOT NULL,
  title            VARCHAR(190) NOT NULL,
  starts_at        DATETIME NOT NULL,
  ends_at          DATETIME NOT NULL,
  capacity         INT NOT NULL,
  description      TEXT,
  require_nda      TINYINT(1) NOT NULL DEFAULT 0,
  require_photo    TINYINT(1) NOT NULL DEFAULT 0,
  require_approval TINYINT(1) NOT NULL DEFAULT 0,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (location_id) REFERENCES locations(id)
);
