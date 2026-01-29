-- Migration: Add AgentMail.to as email provider
-- Run: psql $DATABASE_URL -f schema/migrations/001-add-agentmail.sql

BEGIN;

-- Add agentmail to provider enum
ALTER TABLE sender_accounts
DROP CONSTRAINT IF EXISTS sender_accounts_provider_check;

ALTER TABLE sender_accounts
ADD CONSTRAINT sender_accounts_provider_check
CHECK (provider IN ('gmail', 'microsoft', 'agentmail'));

-- Add api_key auth type
ALTER TABLE sender_accounts
DROP CONSTRAINT IF EXISTS sender_accounts_auth_type_check;

ALTER TABLE sender_accounts
ADD CONSTRAINT sender_accounts_auth_type_check
CHECK (auth_type IN ('oauth', 'password', 'api_key'));

-- Add AgentMail inbox ID field
ALTER TABLE sender_accounts
ADD COLUMN IF NOT EXISTS agentmail_inbox_id TEXT;

COMMIT;
