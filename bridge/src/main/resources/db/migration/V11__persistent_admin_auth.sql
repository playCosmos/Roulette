CREATE TABLE IF NOT EXISTS board_admin_auth_state (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  bootstrap_token TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS board_admin_session (
  session_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_board_admin_session_expires
  ON board_admin_session(expires_at);
