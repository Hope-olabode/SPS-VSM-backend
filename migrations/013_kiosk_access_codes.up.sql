-- one 6-digit access code per location. A kiosk tablet must enter it before the kiosk page shows anything.
-- code_hash lets the server check an attempt; code_enc (encrypted, like kiosk_tokens.token_enc) lets an admin see the code again.
CREATE TABLE kiosk_access_codes (
  location_id  CHAR(36) PRIMARY KEY,
  code_hash    CHAR(64) NOT NULL,
  code_enc     VARCHAR(255) NOT NULL,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE
);
