-- one row per person, so returning visitors and watchlist matching work
CREATE TABLE visitors (
  id          CHAR(36) PRIMARY KEY,
  first_name  VARCHAR(80) NOT NULL,
  last_name   VARCHAR(80) NOT NULL,
  phone       VARCHAR(20) NOT NULL UNIQUE,   -- +2348012345621
  email       VARCHAR(190) NULL,
  company     VARCHAR(160) NOT NULL DEFAULT '',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- one row per check-in (the dashboard and visitor log show these)
CREATE TABLE visits (
  id                      CHAR(36) PRIMARY KEY,
  visitor_id              CHAR(36) NOT NULL,
  location_id             CHAR(36) NOT NULL,
  tenant_id               CHAR(36) NULL,
  host_user_id            CHAR(36) NULL,
  host_name               VARCHAR(160) NOT NULL DEFAULT '',
  type                    VARCHAR(40) NOT NULL DEFAULT 'Guest',
  purpose                 VARCHAR(255) NOT NULL DEFAULT '',
  notes                   TEXT,
  status                  ENUM('ONSITE','PENDING_CLEARANCE','LEFT') NOT NULL DEFAULT 'ONSITE',
  check_in_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  check_out_at            DATETIME NULL,
  clearance_requested_at  DATETIME NULL,
  photo_url               VARCHAR(500) NULL,
  pre_registration_id     CHAR(36) NULL,
  KEY idx_visits_loc_status (location_id, status),
  KEY idx_visits_checkin (check_in_at),
  FOREIGN KEY (visitor_id) REFERENCES visitors(id),
  FOREIGN KEY (location_id) REFERENCES locations(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (host_user_id) REFERENCES users(id)
);
