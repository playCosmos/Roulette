CREATE TABLE IF NOT EXISTS board_admin_approval_request (
  request_hash TEXT PRIMARY KEY,
  approval_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('PENDING', 'APPROVED')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT
);

CREATE INDEX IF NOT EXISTS ix_board_admin_approval_expires
  ON board_admin_approval_request(expires_at);

CREATE INDEX IF NOT EXISTS ix_board_admin_approval_status
  ON board_admin_approval_request(status);
