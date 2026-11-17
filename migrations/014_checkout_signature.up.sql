-- where the visitor's check-out signature image is stored (a file under UPLOADS_DIR, like signature_url)
ALTER TABLE visits ADD COLUMN checkout_signature_url VARCHAR(500) NULL AFTER signature_url;
-- carried into the archive so retention can delete the file when it anonymizes the record
ALTER TABLE old_records ADD COLUMN checkout_signature_url VARCHAR(500) NULL AFTER signature_url;
