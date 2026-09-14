ALTER TABLE donation_event ADD COLUMN raw_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_donation_event_raw_hash_received
  ON donation_event(raw_hash, received_at);

ALTER TABLE ticket ADD COLUMN ticket_sequence INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_donor_sequence
  ON ticket(donor_id, ticket_sequence)
  WHERE ticket_sequence IS NOT NULL;
