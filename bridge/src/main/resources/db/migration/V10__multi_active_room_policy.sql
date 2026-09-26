ALTER TABLE board_room
  ADD COLUMN activated_at TEXT;

UPDATE board_room
SET activated_at = updated_at
WHERE status = 'READY'
  AND lifecycle_state IN ('ACTIVE', 'PAUSED')
  AND activated_at IS NULL;

DROP INDEX IF EXISTS ux_board_room_single_ready;
DROP INDEX IF EXISTS ux_board_room_single_active;

CREATE TABLE IF NOT EXISTS board_server_policy (
  policy_key TEXT PRIMARY KEY,
  policy_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO board_server_policy(
  policy_key, policy_value, updated_at
) VALUES (
  'active_room_limit',
  '1',
  datetime('now')
);
