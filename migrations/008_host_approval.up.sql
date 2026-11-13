-- host approval: a kiosk visitor can wait for staff to let them in (PENDING_APPROVAL), and staff can turn them away (DECLINED)
ALTER TABLE visits
  MODIFY COLUMN status ENUM('PENDING_APPROVAL','ONSITE','PENDING_CLEARANCE','LEFT','DECLINED') NOT NULL DEFAULT 'ONSITE',
  ADD COLUMN decided_by_id CHAR(36) NULL AFTER clearance_requested_at,
  ADD COLUMN decided_at DATETIME NULL AFTER decided_by_id;
