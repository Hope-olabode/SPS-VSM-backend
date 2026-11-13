CREATE TABLE locations (
  id          CHAR(36) PRIMARY KEY,
  name        VARCHAR(120) NOT NULL UNIQUE,
  address     VARCHAR(255) NOT NULL DEFAULT '',
  city        VARCHAR(120) NOT NULL DEFAULT 'Lagos, Nigeria',
  active      TINYINT(1) NOT NULL DEFAULT 1,
  is_primary  TINYINT(1) NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- resident companies in the building
CREATE TABLE tenants (
  id          CHAR(36) PRIMARY KEY,
  location_id CHAR(36) NOT NULL,
  name        VARCHAR(160) NOT NULL,
  floor       VARCHAR(60),
  UNIQUE KEY uq_tenant (location_id, name),
  FOREIGN KEY (location_id) REFERENCES locations(id)
);

CREATE TABLE users (
  id             CHAR(36) PRIMARY KEY,
  name           VARCHAR(160) NOT NULL,
  email          VARCHAR(190) NOT NULL UNIQUE,
  password_hash  VARCHAR(100) NOT NULL,
  role           ENUM('GLOBAL_ADMIN','LOCATION_ADMIN','MANAGER','TENANT_REP','USER') NOT NULL DEFAULT 'USER',
  location_id    CHAR(36) NOT NULL,
  tenant_id      CHAR(36) NULL,
  last_active_at DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (location_id) REFERENCES locations(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
