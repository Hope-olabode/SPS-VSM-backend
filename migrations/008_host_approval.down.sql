-- visits that only exist because of host approval go back to the old statuses before the ENUM shrinks
UPDATE visits SET status = 'LEFT', check_out_at = COALESCE(check_out_at, decided_at, check_in_at) WHERE status = 'DECLINED';
UPDATE visits SET status = 'ONSITE' WHERE status = 'PENDING_APPROVAL';
ALTER TABLE visits
  DROP COLUMN decided_at,
  DROP COLUMN decided_by_id,
  MODIFY COLUMN status ENUM('ONSITE','PENDING_CLEARANCE','LEFT') NOT NULL DEFAULT 'ONSITE';
