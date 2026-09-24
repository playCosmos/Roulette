-- Preserve only the most recently updated READY room when upgrading an
-- existing database that was created before the single-active-room rule.
UPDATE board_room
SET status = 'DRAFT',
    committed_board_json = NULL,
    updated_at = datetime('now')
WHERE status = 'READY'
  AND room_id NOT IN (
    SELECT room_id
    FROM board_room
    WHERE status = 'READY'
    ORDER BY updated_at DESC, created_at DESC, room_id DESC
    LIMIT 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_board_room_single_ready
  ON board_room(status)
  WHERE status = 'READY';
