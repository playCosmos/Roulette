ALTER TABLE board_room
  ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'DRAFT';

ALTER TABLE board_room
  ADD COLUMN retention_minutes INTEGER NOT NULL DEFAULT 240;

ALTER TABLE board_room
  ADD COLUMN expires_at TEXT;

ALTER TABLE board_room
  ADD COLUMN pause_donation_mode TEXT NOT NULL DEFAULT 'QUEUE';

ALTER TABLE board_room
  ADD COLUMN terminated_at TEXT;

UPDATE board_room
SET lifecycle_state = CASE
      WHEN status = 'READY' THEN 'ACTIVE'
      ELSE 'DRAFT'
    END,
    retention_minutes = 240,
    expires_at = datetime(created_at, '+240 minutes'),
    pause_donation_mode = 'QUEUE'
WHERE expires_at IS NULL;

DROP INDEX IF EXISTS ux_board_room_single_ready;

CREATE UNIQUE INDEX IF NOT EXISTS ux_board_room_single_active
  ON board_room((1))
  WHERE status = 'READY'
    AND lifecycle_state IN ('ACTIVE', 'PAUSED');

ALTER TABLE board_game_player_state
  ADD COLUMN next_throw_multiplier INTEGER NOT NULL DEFAULT 1;

ALTER TABLE board_game_player_state
  ADD COLUMN ignore_next_landing_effects INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS board_game_deferred_donation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('QUEUED', 'IGNORED')),
  streamer_id TEXT,
  donor_id TEXT NOT NULL,
  nickname TEXT,
  balloon_count INTEGER NOT NULL,
  fan_order INTEGER NOT NULL,
  raw_payload TEXT,
  received_at_epoch_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (room_id, source_fingerprint),
  FOREIGN KEY (room_id) REFERENCES board_room(room_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_board_game_deferred_fifo
  ON board_game_deferred_donation(room_id, state, id);
