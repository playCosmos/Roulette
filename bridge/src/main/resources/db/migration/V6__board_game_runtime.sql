CREATE TABLE IF NOT EXISTS board_game_state (
  room_id TEXT PRIMARY KEY,
  board_json TEXT NOT NULL,
  event_sequence INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (room_id) REFERENCES board_room(room_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS board_game_player_state (
  room_id TEXT NOT NULL,
  player_index INTEGER NOT NULL,
  soop_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  laps INTEGER NOT NULL DEFAULT 0,
  skip_next_throws INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, player_index),
  UNIQUE (room_id, soop_id),
  FOREIGN KEY (room_id) REFERENCES board_room(room_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS board_game_event (
  event_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  source_fingerprint TEXT NOT NULL,
  source_donor_id TEXT NOT NULL,
  source_balloon_count INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (room_id, source_fingerprint),
  UNIQUE (room_id, event_sequence),
  FOREIGN KEY (room_id) REFERENCES board_room(room_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_board_game_player_match
  ON board_game_player_state(room_id, soop_id);

CREATE INDEX IF NOT EXISTS idx_board_game_event_room_sequence
  ON board_game_event(room_id, event_sequence);
