ALTER TABLE board_room_player
  ADD COLUMN live_status TEXT NOT NULL DEFAULT 'NOT_CHECKED';

ALTER TABLE board_room_player
  ADD COLUMN live_bno TEXT;

ALTER TABLE board_room_player
  ADD COLUMN live_title TEXT;

ALTER TABLE board_room_player
  ADD COLUMN live_checked_at TEXT;

ALTER TABLE board_room_player
  ADD COLUMN live_check_error TEXT;
