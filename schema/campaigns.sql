-- Campaign Tracking Extension for Scanner
-- Integrates with existing scans/findings tables to track outbound email campaigns

-- Campaign definitions (waves of outreach)
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY DEFAULT ('campaign-' || floor(random() * 1000000000)::text),
  name TEXT NOT NULL,
  description TEXT,
  campaign_type TEXT NOT NULL DEFAULT 'infostealer_credentials',
  status TEXT NOT NULL DEFAULT 'draft', -- draft, active, paused, completed
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  metadata JSONB,

  -- Email template configuration
  subject_template TEXT,
  body_template TEXT,
  from_name TEXT,
  from_email TEXT,

  -- Campaign goals and targeting
  target_segment TEXT, -- e.g., 'high_eal', 'infostealer_only', 'both_types'
  min_eal_threshold NUMERIC(12,2), -- only contact if EAL >= this

  -- Stats (updated by triggers/workers)
  total_prospects INTEGER DEFAULT 0,
  emails_sent INTEGER DEFAULT 0,
  emails_delivered INTEGER DEFAULT 0,
  emails_opened INTEGER DEFAULT 0,
  emails_replied INTEGER DEFAULT 0,
  meetings_booked INTEGER DEFAULT 0
);

-- Individual prospect records (one per company/contact per campaign)
CREATE TABLE IF NOT EXISTS campaign_prospects (
  id TEXT PRIMARY KEY DEFAULT ('prospect-' || floor(random() * 1000000000)::text),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  scan_id TEXT NOT NULL REFERENCES scans(id), -- source of intelligence

  -- Contact information
  company_name TEXT,
  domain TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  contact_name TEXT,
  contact_title TEXT,

  -- Intelligence summary (denormalized for performance)
  critical_user_count INTEGER DEFAULT 0,
  medium_user_count INTEGER DEFAULT 0,
  total_eal_ml NUMERIC(12,2), -- from scan_eal_summary
  top_risk_categories TEXT[], -- e.g., ['EMAIL_AUTH', 'TLS', 'BREACH']

  -- Tracking
  tracking_token TEXT UNIQUE NOT NULL, -- embed in email for thread tracking
  status TEXT NOT NULL DEFAULT 'queued', -- queued, sent, delivered, opened, replied, bounced, unsubscribed

  -- Email metadata
  gmail_thread_id TEXT,
  gmail_message_id TEXT,
  last_sent_at TIMESTAMP,
  last_opened_at TIMESTAMP,
  last_replied_at TIMESTAMP,

  -- Outcome tracking
  outcome TEXT, -- meeting_booked, not_interested, no_response, etc.
  outcome_notes TEXT,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(campaign_id, scan_id) -- one prospect per scan per campaign
);

-- Email events (sent and received messages)
CREATE TABLE IF NOT EXISTS campaign_emails (
  id TEXT PRIMARY KEY DEFAULT ('email-' || floor(random() * 1000000000)::text),
  prospect_id TEXT NOT NULL REFERENCES campaign_prospects(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,

  direction TEXT NOT NULL, -- 'outbound' or 'inbound'

  -- Gmail identifiers
  gmail_thread_id TEXT NOT NULL,
  gmail_message_id TEXT NOT NULL,
  gmail_history_id TEXT, -- for incremental sync

  -- Message metadata
  subject TEXT,
  snippet TEXT,
  from_email TEXT,
  to_email TEXT,

  -- Content (optional storage)
  body_html TEXT,
  body_text TEXT,

  -- Timing
  sent_at TIMESTAMP NOT NULL,
  received_at TIMESTAMP, -- when we detected it (for inbound)

  -- Engagement signals
  opened BOOLEAN DEFAULT FALSE,
  clicked BOOLEAN DEFAULT FALSE,

  -- Raw data
  raw_headers JSONB,
  raw_payload JSONB,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Engagement tracking (opens, clicks, etc.)
CREATE TABLE IF NOT EXISTS campaign_tracking (
  id TEXT PRIMARY KEY DEFAULT ('track-' || floor(random() * 1000000000)::text),
  prospect_id TEXT NOT NULL REFERENCES campaign_prospects(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,

  event_type TEXT NOT NULL, -- 'email_sent', 'email_opened', 'link_clicked', 'reply_received', 'meeting_booked'
  event_timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Context
  tracking_token TEXT,
  user_agent TEXT,
  ip_address TEXT,

  -- Event-specific data
  metadata JSONB,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_campaign_prospects_campaign_id ON campaign_prospects(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_prospects_scan_id ON campaign_prospects(scan_id);
CREATE INDEX IF NOT EXISTS idx_campaign_prospects_status ON campaign_prospects(status);
CREATE INDEX IF NOT EXISTS idx_campaign_prospects_tracking_token ON campaign_prospects(tracking_token);
CREATE INDEX IF NOT EXISTS idx_campaign_prospects_gmail_thread_id ON campaign_prospects(gmail_thread_id);

-- Performance indexes for capacity checks and duplicate detection
CREATE INDEX IF NOT EXISTS idx_campaign_prospects_sender_sent
ON campaign_prospects(sender_email, last_sent_at DESC)
WHERE status = 'sent';

CREATE INDEX IF NOT EXISTS idx_campaign_emails_prospect_id ON campaign_emails(prospect_id);
CREATE INDEX IF NOT EXISTS idx_campaign_emails_campaign_id ON campaign_emails(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_emails_gmail_thread_id ON campaign_emails(gmail_thread_id);
CREATE INDEX IF NOT EXISTS idx_campaign_emails_direction ON campaign_emails(direction);

CREATE INDEX IF NOT EXISTS idx_campaign_tracking_prospect_id ON campaign_tracking(prospect_id);
CREATE INDEX IF NOT EXISTS idx_campaign_tracking_event_type ON campaign_tracking(event_type);

-- Trigger to update campaign stats when prospect status changes
CREATE OR REPLACE FUNCTION update_campaign_stats()
RETURNS TRIGGER AS $$
BEGIN
  -- Recalculate campaign stats
  UPDATE campaigns c SET
    total_prospects = (SELECT COUNT(*) FROM campaign_prospects WHERE campaign_id = c.id),
    emails_sent = (SELECT COUNT(*) FROM campaign_prospects WHERE campaign_id = c.id AND status NOT IN ('queued', 'draft')),
    emails_delivered = (SELECT COUNT(*) FROM campaign_prospects WHERE campaign_id = c.id AND status IN ('delivered', 'opened', 'replied')),
    emails_opened = (SELECT COUNT(*) FROM campaign_prospects WHERE campaign_id = c.id AND status IN ('opened', 'replied')),
    emails_replied = (SELECT COUNT(*) FROM campaign_prospects WHERE campaign_id = c.id AND status = 'replied')
  WHERE c.id = NEW.campaign_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_campaign_stats
AFTER INSERT OR UPDATE ON campaign_prospects
FOR EACH ROW
EXECUTE FUNCTION update_campaign_stats();

-- View: Campaign performance with EAL attribution
CREATE OR REPLACE VIEW campaign_performance AS
SELECT
  c.id as campaign_id,
  c.name as campaign_name,
  c.status as campaign_status,
  c.total_prospects,
  c.emails_sent,
  c.emails_opened,
  c.emails_replied,
  c.meetings_booked,

  -- Engagement rates
  CASE WHEN c.emails_sent > 0 THEN ROUND(c.emails_opened::NUMERIC / c.emails_sent * 100, 2) ELSE 0 END as open_rate_pct,
  CASE WHEN c.emails_sent > 0 THEN ROUND(c.emails_replied::NUMERIC / c.emails_sent * 100, 2) ELSE 0 END as reply_rate_pct,
  CASE WHEN c.emails_sent > 0 THEN ROUND(c.meetings_booked::NUMERIC / c.emails_sent * 100, 2) ELSE 0 END as meeting_rate_pct,

  -- EAL intelligence aggregates
  SUM(p.total_eal_ml) as total_addressable_risk_ml,
  AVG(p.total_eal_ml) as avg_risk_per_prospect_ml,
  SUM(CASE WHEN p.status = 'replied' THEN p.total_eal_ml ELSE 0 END) as total_risk_engaged_ml,

  -- Critical exposure counts
  SUM(p.critical_user_count) as total_critical_users,
  SUM(p.medium_user_count) as total_medium_users,

  c.created_at,
  c.started_at,
  c.completed_at
FROM campaigns c
LEFT JOIN campaign_prospects p ON p.campaign_id = c.id
GROUP BY c.id, c.name, c.status, c.total_prospects, c.emails_sent, c.emails_opened,
         c.emails_replied, c.meetings_booked, c.created_at, c.started_at, c.completed_at;

-- View: Prospect detail with scan intelligence
CREATE OR REPLACE VIEW campaign_prospect_details AS
SELECT
  p.id as prospect_id,
  p.campaign_id,
  p.company_name,
  p.domain,
  p.contact_email,
  p.contact_name,
  p.status as prospect_status,
  p.tracking_token,

  -- Intelligence from scan
  s.id as scan_id,
  s.created_at as scan_date,
  s.findings_count,
  p.total_eal_ml,
  p.critical_user_count,
  p.medium_user_count,
  p.top_risk_categories,

  -- Engagement timeline
  p.last_sent_at,
  p.last_opened_at,
  p.last_replied_at,

  -- Outcome
  p.outcome,
  p.outcome_notes,

  -- Email thread
  p.gmail_thread_id,
  (SELECT COUNT(*) FROM campaign_emails WHERE prospect_id = p.id AND direction = 'outbound') as emails_sent_count,
  (SELECT COUNT(*) FROM campaign_emails WHERE prospect_id = p.id AND direction = 'inbound') as emails_received_count
FROM campaign_prospects p
LEFT JOIN scans s ON s.id = p.scan_id;

-- Success message
SELECT 'Campaign tracking schema created successfully!' as status;
