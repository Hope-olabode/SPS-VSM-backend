-- the kiosk link has to stay visible to admins (Overview and Control Panel), so the token is also kept encrypted.
-- token_hash is still what the kiosk is looked up by; token_enc is only ever decrypted for an admin.
ALTER TABLE kiosk_tokens ADD COLUMN token_enc VARCHAR(255) NULL AFTER token_hash;
