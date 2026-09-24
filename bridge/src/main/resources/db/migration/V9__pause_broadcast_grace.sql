ALTER TABLE board_room
  ADD COLUMN pause_grace_seconds INTEGER NOT NULL DEFAULT 10;

ALTER TABLE board_room
  ADD COLUMN pause_requested_at TEXT;

ALTER TABLE board_room
  ADD COLUMN pause_grace_until TEXT;

UPDATE board_room
SET pause_grace_seconds = 10
WHERE pause_grace_seconds IS NULL;

UPDATE board_room
SET pause_requested_at = datetime('now'),
    pause_grace_until = datetime('now', '+10 seconds')
WHERE lifecycle_state = 'PAUSED'
  AND pause_grace_until IS NULL;
