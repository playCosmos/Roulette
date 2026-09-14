CREATE TABLE IF NOT EXISTS donor (
  donor_id TEXT PRIMARY KEY,
  current_nickname TEXT NOT NULL,
  total_balloons INTEGER NOT NULL DEFAULT 0 CHECK (total_balloons >= 0),
  issued_ticket_count INTEGER NOT NULL DEFAULT 0 CHECK (issued_ticket_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS donation_event (
  event_id TEXT PRIMARY KEY,
  donor_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  balloon_count INTEGER NOT NULL CHECK (balloon_count > 0),
  received_at TEXT NOT NULL,
  processed_at TEXT,
  raw_payload TEXT,
  FOREIGN KEY (donor_id) REFERENCES donor(donor_id)
);

CREATE INDEX IF NOT EXISTS idx_donation_event_donor_received
  ON donation_event(donor_id, received_at);

CREATE TABLE IF NOT EXISTS ticket (
  ticket_id TEXT PRIMARY KEY,
  donor_id TEXT NOT NULL,
  nickname_at_issue TEXT NOT NULL,
  numbers_json TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'PENDING',
    'NUMBERS_CONFIRMED',
    'ROULETTE_RUNNING',
    'ROULETTE_COMPLETED',
    'IMAGE_SAVED',
    'ISSUED',
    'FAILED'
  )),
  image_path TEXT,
  source_event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  issued_at TEXT,
  FOREIGN KEY (donor_id) REFERENCES donor(donor_id),
  FOREIGN KEY (source_event_id) REFERENCES donation_event(event_id)
);

CREATE INDEX IF NOT EXISTS idx_ticket_donor_created
  ON ticket(donor_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ticket_status_created
  ON ticket(status, created_at);
