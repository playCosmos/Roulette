CREATE UNIQUE INDEX IF NOT EXISTS ux_board_room_single_ready
  ON board_room(status)
  WHERE status = 'READY';
