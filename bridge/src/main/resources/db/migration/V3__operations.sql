CREATE TABLE IF NOT EXISTS adjustment_event (
  adjustment_id TEXT PRIMARY KEY,
  donor_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  balloon_delta INTEGER NOT NULL CHECK (balloon_delta <> 0),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (donor_id) REFERENCES donor(donor_id)
);

CREATE INDEX IF NOT EXISTS idx_adjustment_event_donor_created
  ON adjustment_event(donor_id, created_at);
