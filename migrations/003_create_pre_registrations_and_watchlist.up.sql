CREATE TABLE pre_registrations (
  id            CHAR(36) PRIMARY KEY,
  name          VARCHAR(160) NOT NULL,
  email         VARCHAR(190) NOT NULL,
  phone         VARCHAR(20) NULL,
  company       VARCHAR(160) NOT NULL DEFAULT '',
  job_title     VARCHAR(120) NULL,
  visitor_type  VARCHAR(40) NULL,
  tenant_id     CHAR(36) NOT NULL,
  host_name     VARCHAR(160) NULL,
  purpose       VARCHAR(255) NULL,
  expected_at   DATETIME NOT NULL,
  status        ENUM('EXPECTED','CHECKED_IN','CHECKED_OUT','CANCELLED') NOT NULL DEFAULT 'EXPECTED',
  qr_code       VARCHAR(20) NOT NULL UNIQUE,   -- PR-605309
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_prereg_expected (expected_at),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE watchlist (
  id          CHAR(36) PRIMARY KEY,
  first_name  VARCHAR(80) NOT NULL,
  last_name   VARCHAR(80) NOT NULL,
  email       VARCHAR(190) NULL,
  phone       VARCHAR(20) NULL,
  company     VARCHAR(160) NOT NULL DEFAULT '',
  severity    ENUM('LOW','MEDIUM','HIGH','CRITICAL') NOT NULL DEFAULT 'MEDIUM',
  reason      TEXT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_watch_phone (phone)
);
