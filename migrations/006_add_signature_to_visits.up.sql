-- where the visitor's signature image is stored (a file under UPLOADS_DIR, like photo_url)
ALTER TABLE visits ADD COLUMN signature_url VARCHAR(500) NULL AFTER photo_url;
