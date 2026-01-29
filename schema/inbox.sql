-- Unified Inbox Schema
-- Manages multiple sender accounts (Gmail + Microsoft) with encrypted credentials

-- Encryption key should be stored in .env as SENDER_ENCRYPTION_KEY
-- Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

-- Sender accounts table (Gmail and Microsoft)
CREATE TABLE IF NOT EXISTS sender_accounts (
  id TEXT PRIMARY KEY DEFAULT ('sender-' || floor(random() * 1000000000)::text),

  -- Account identification
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  provider TEXT NOT NULL CHECK (provider IN ('gmail', 'microsoft')),

  -- Authentication (encrypted at rest)
  -- For Gmail: stores OAuth refresh token
  -- For Microsoft: stores password (encrypted)
  auth_type TEXT NOT NULL CHECK (auth_type IN ('oauth', 'password')),
  credentials_encrypted TEXT NOT NULL,  -- AES-256-GCM encrypted JSON
  credentials_iv TEXT NOT NULL,          -- Initialization vector for decryption
  credentials_tag TEXT NOT NULL,         -- Auth tag for verification

  -- SMTP/IMAP settings (defaults work for most cases)
  smtp_host TEXT,
  smtp_port INTEGER,
  imap_host TEXT,
  imap_port INTEGER,

  -- Account status
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'error', 'rate_limited')),
  last_error TEXT,
  last_error_at TIMESTAMP,

  -- Usage tracking for rotation
  emails_sent_today INTEGER DEFAULT 0,
  emails_sent_total INTEGER DEFAULT 0,
  last_sent_at TIMESTAMP,
  daily_limit INTEGER DEFAULT 50,  -- Conservative default

  -- Sync state for inbox
  last_sync_at TIMESTAMP,
  last_sync_uid TEXT,  -- IMAP UID for incremental sync

  -- Metadata
  tags TEXT[],  -- e.g., ['tips', 'outreach', 'primary']
  notes TEXT,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Unified inbox messages (synced from all accounts)
CREATE TABLE IF NOT EXISTS inbox_messages (
  id TEXT PRIMARY KEY DEFAULT ('msg-' || floor(random() * 1000000000)::text),

  -- Account reference
  account_id TEXT NOT NULL REFERENCES sender_accounts(id) ON DELETE CASCADE,
  account_email TEXT NOT NULL,  -- Denormalized for quick display

  -- Message identification
  message_uid TEXT NOT NULL,     -- IMAP UID or provider message ID
  thread_id TEXT,                -- For threading conversations
  in_reply_to TEXT,              -- Message-ID of parent
  references_header TEXT,        -- Full references chain

  -- Message metadata
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  folder TEXT DEFAULT 'INBOX',   -- INBOX, Sent, etc.

  -- Envelope
  from_email TEXT NOT NULL,
  from_name TEXT,
  to_email TEXT NOT NULL,
  to_name TEXT,
  cc TEXT,
  bcc TEXT,
  subject TEXT,

  -- Content
  body_text TEXT,
  body_html TEXT,
  snippet TEXT,  -- First ~200 chars for preview

  -- Status flags
  is_read BOOLEAN DEFAULT FALSE,
  is_starred BOOLEAN DEFAULT FALSE,
  is_archived BOOLEAN DEFAULT FALSE,
  is_spam BOOLEAN DEFAULT FALSE,
  is_deleted BOOLEAN DEFAULT FALSE,

  -- For campaign tracking (if this is a campaign reply)
  campaign_id TEXT REFERENCES campaigns(id),
  prospect_id TEXT REFERENCES campaign_prospects(id),

  -- Timestamps
  sent_at TIMESTAMP NOT NULL,
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Raw data for debugging
  raw_headers JSONB,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(account_id, message_uid)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_sender_accounts_provider ON sender_accounts(provider);
CREATE INDEX IF NOT EXISTS idx_sender_accounts_status ON sender_accounts(status);
CREATE INDEX IF NOT EXISTS idx_sender_accounts_email ON sender_accounts(email);

CREATE INDEX IF NOT EXISTS idx_inbox_messages_account_id ON inbox_messages(account_id);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_direction ON inbox_messages(direction);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_sent_at ON inbox_messages(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_is_read ON inbox_messages(is_read) WHERE NOT is_read;
CREATE INDEX IF NOT EXISTS idx_inbox_messages_thread_id ON inbox_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_from_email ON inbox_messages(from_email);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_to_sent ON inbox_messages(to_email, sent_at DESC)
WHERE direction = 'outbound';  -- For duplicate send detection
CREATE INDEX IF NOT EXISTS idx_inbox_messages_campaign ON inbox_messages(campaign_id) WHERE campaign_id IS NOT NULL;

-- View: Unread messages across all accounts
CREATE OR REPLACE VIEW inbox_unread AS
SELECT
  m.*,
  s.display_name as account_name,
  s.provider
FROM inbox_messages m
JOIN sender_accounts s ON s.id = m.account_id
WHERE m.is_read = FALSE
  AND m.is_archived = FALSE
  AND m.is_deleted = FALSE
  AND m.direction = 'inbound'
ORDER BY m.sent_at DESC;

-- View: Conversation threads
CREATE OR REPLACE VIEW inbox_threads AS
SELECT
  COALESCE(m.thread_id, m.id) as thread_id,
  MIN(m.subject) as subject,
  array_agg(DISTINCT m.from_email) as participants,
  COUNT(*) as message_count,
  MAX(m.sent_at) as last_message_at,
  bool_or(NOT m.is_read AND m.direction = 'inbound') as has_unread,
  MIN(m.account_email) as account_email
FROM inbox_messages m
WHERE m.is_deleted = FALSE
GROUP BY COALESCE(m.thread_id, m.id)
ORDER BY last_message_at DESC;

-- View: Account health dashboard
CREATE OR REPLACE VIEW sender_account_health AS
SELECT
  s.id,
  s.email,
  s.provider,
  s.status,
  s.emails_sent_today,
  s.daily_limit,
  ROUND(s.emails_sent_today::NUMERIC / NULLIF(s.daily_limit, 0) * 100, 1) as usage_pct,
  s.last_sent_at,
  s.last_sync_at,
  s.last_error,
  (SELECT COUNT(*) FROM inbox_messages WHERE account_id = s.id AND is_read = FALSE AND direction = 'inbound') as unread_count
FROM sender_accounts s
ORDER BY s.provider, s.email;

-- Function to reset daily send counts (run via cron at midnight)
CREATE OR REPLACE FUNCTION reset_daily_send_counts()
RETURNS void AS $$
BEGIN
  UPDATE sender_accounts SET emails_sent_today = 0, updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Trigger to update timestamps
CREATE OR REPLACE FUNCTION update_sender_account_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_sender_account_timestamp ON sender_accounts;
CREATE TRIGGER trigger_sender_account_timestamp
BEFORE UPDATE ON sender_accounts
FOR EACH ROW
EXECUTE FUNCTION update_sender_account_timestamp();

SELECT 'Unified inbox schema created successfully!' as status;
