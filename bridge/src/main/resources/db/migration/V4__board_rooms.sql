CREATE TABLE IF NOT EXISTS board_room (
  room_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'READY')),
  config_json TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  committed_board_json TEXT,
  preview_seed INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS board_room_player (
  room_id TEXT NOT NULL,
  player_index INTEGER NOT NULL CHECK (player_index >= 0 AND player_index < 6),
  soop_id TEXT NOT NULL,
  display_name TEXT,
  profile_image_url TEXT,
  balloon_trigger INTEGER NOT NULL CHECK (balloon_trigger > 0),
  PRIMARY KEY (room_id, player_index),
  UNIQUE (room_id, soop_id),
  FOREIGN KEY (room_id) REFERENCES board_room(room_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_board_room_status_updated
  ON board_room(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_board_room_player_soop
  ON board_room_player(soop_id, balloon_trigger);
