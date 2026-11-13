-- A phone's push tokens. The secret is the phone's only credential; the relay keeps its hash.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  apns_token TEXT,
  voip_token TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX devices_apns_token ON devices (apns_token) WHERE apns_token IS NOT NULL;
CREATE UNIQUE INDEX devices_voip_token ON devices (voip_token) WHERE voip_token IS NOT NULL;

-- What a phone handed one Mac: the right to push to this phone, and nothing else.
CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX grants_device ON grants (device_id);

-- The signed APNs provider token, shared by every isolate so APNs sees one token per key at a time.
CREATE TABLE provider_tokens (
  key_id TEXT PRIMARY KEY,
  issued_at INTEGER NOT NULL,
  jwt TEXT NOT NULL
);
