# feat: Add AgentMail.to as Primary Email Sender

> **Type:** Enhancement
> **Priority:** High
> **Complexity:** Low-Medium
> **Files to modify:** 4
> **New files:** 1 (migration only)

---

## Overview

Add AgentMail.to as the primary email sending provider, with Gmail as fallback. Use the SDK directly, keep it simple.

---

## Technical Approach

### Phase 1: Schema Migration

```sql
-- schema/migrations/001-add-agentmail.sql

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
```

### Phase 2: Update EmailClient

Add AgentMail sending directly in `apps/inbox/core/email-client.ts`:

```typescript
// Add to imports
import { AgentMailClient } from 'agentmail';

// Update SenderAccount interface
export interface SenderAccount {
  // ... existing fields
  provider: 'gmail' | 'microsoft' | 'agentmail';
  auth_type: 'oauth' | 'password' | 'api_key';
  agentmail_inbox_id: string | null;
}

// Update sendEmail method - add AgentMail routing
async sendEmail(options: SendEmailOptions): Promise<{ messageId: string }> {
  if (this.account.provider === 'agentmail') {
    return this.sendViaAgentMail(options);
  }
  if (this.account.provider === 'gmail' && this.account.auth_type === 'oauth') {
    return this.sendViaGmailApi(options);
  }
  return this.sendViaSmtp(options);
}

// New method - use SDK directly
private async sendViaAgentMail(options: SendEmailOptions): Promise<{ messageId: string }> {
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) {
    throw new Error('AGENTMAIL_API_KEY not set');
  }
  if (!this.account.agentmail_inbox_id) {
    throw new Error('AgentMail inbox ID not configured for this account');
  }

  const client = new AgentMailClient({ apiKey });

  const result = await client.inboxes.messages.send(this.account.agentmail_inbox_id, {
    to: [options.to],
    subject: options.subject,
    text: options.bodyText || this.stripHtml(options.bodyHtml),
    html: options.bodyHtml,
    reply_to: options.replyTo ? [options.replyTo] : undefined,
    headers: options.headers,
  });

  return { messageId: result.messageId };
}

private stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
```

### Phase 3: Simple Failover

Add try-catch fallback in `scripts/campaign-schedule.ts`:

```typescript
// In the send loop, wrap the send call
async function sendWithFallback(
  primaryAccount: SenderAccount,
  fallbackAccount: SenderAccount | null,
  options: SendOptions
): Promise<{ messageId: string; usedFallback: boolean }> {
  try {
    const result = await sendEmailViaApi(primaryAccount, options);
    return { messageId: result.messageId, usedFallback: false };
  } catch (error) {
    console.error(`Primary send failed (${primaryAccount.email}): ${error.message}`);

    if (!fallbackAccount) {
      throw error;
    }

    console.log(`Falling back to ${fallbackAccount.email}`);
    const result = await sendEmailViaApi(fallbackAccount, options);
    return { messageId: result.messageId, usedFallback: true };
  }
}
```

### Phase 4: Webhook Handler

Add to `apps/inbox/server.ts`:

```typescript
import crypto from 'crypto';

// AgentMail webhook types
interface AgentMailMessage {
  message_id: string;
  thread_id: string;
  from: string;
  to: string[];
  subject: string;
  text?: string;
}

interface AgentMailWebhookEvent {
  event_type: 'message.bounced' | 'message.received' | 'message.complained';
  event_id: string;
  message: AgentMailMessage;
}

// Webhook endpoint
app.post('/webhooks/agentmail', express.json(), async (req, res) => {
  // Validate signature FIRST
  const signature = req.headers['x-agentmail-signature'] as string;
  const secret = process.env.AGENTMAIL_WEBHOOK_SECRET;

  if (!secret) {
    console.error('AGENTMAIL_WEBHOOK_SECRET not configured');
    return res.status(500).send('Webhook not configured');
  }

  const payload = JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return res.status(401).send('Invalid signature');
  }

  // Signature valid - respond OK
  res.status(200).send('OK');

  // Process event
  const event: AgentMailWebhookEvent = req.body;
  const { event_type, message } = event;

  try {
    if (event_type === 'message.bounced') {
      const recipient = message.to?.[0];
      if (recipient) {
        await pool.query(
          `UPDATE campaign_prospects SET status = 'bounced', updated_at = NOW()
           WHERE contact_email = $1 AND status = 'sent'`,
          [recipient]
        );
        console.log(`Marked ${recipient} as bounced`);
      }
    } else if (event_type === 'message.received') {
      await pool.query(
        `UPDATE campaign_prospects SET status = 'replied', last_replied_at = NOW(), updated_at = NOW()
         WHERE contact_email = $1 AND status IN ('sent', 'delivered', 'opened')`,
        [message.from]
      );
      console.log(`Marked reply from ${message.from}`);
    } else if (event_type === 'message.complained') {
      await pool.query(
        `UPDATE campaign_prospects SET status = 'unsubscribed', updated_at = NOW()
         WHERE contact_email = $1`,
        [message.to?.[0]]
      );
      console.log(`Marked complaint for ${message.to?.[0]}`);
    }
  } catch (err) {
    console.error(`Webhook processing error: ${err.message}`);
  }
});
```

### Phase 5: Account Setup

Update `scripts/inbox-add-account.ts` to support AgentMail:

```typescript
// Add to provider choices
const { provider } = await inquirer.prompt([{
  type: 'list',
  name: 'provider',
  message: 'Email provider:',
  choices: [
    { name: 'AgentMail.to (Recommended)', value: 'agentmail' },
    { name: 'Gmail (OAuth)', value: 'gmail' },
    { name: 'Microsoft 365', value: 'microsoft' },
  ],
}]);

// Add AgentMail handling
if (provider === 'agentmail') {
  const { inboxId } = await inquirer.prompt([{
    type: 'input',
    name: 'inboxId',
    message: 'AgentMail Inbox ID (from console.agentmail.to):',
    validate: (v: string) => v.length > 0 || 'Required',
  }]);

  // Test connection
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) {
    console.error('Set AGENTMAIL_API_KEY in .env first');
    process.exit(1);
  }

  const client = new AgentMailClient({ apiKey });
  const inbox = await client.inboxes.get(inboxId);
  console.log(`✓ Connected: ${inbox.email}`);

  const { displayName } = await inquirer.prompt([{
    type: 'input',
    name: 'displayName',
    message: 'Display name:',
    default: inbox.displayName || inbox.email.split('@')[0],
  }]);

  // Store - credentials are in env, just store inbox reference
  const credentials = { inbox_id: inboxId };
  const encrypted = encryptCredentials(credentials);

  await pool.query(`
    INSERT INTO sender_accounts (email, display_name, provider, auth_type,
      credentials_encrypted, credentials_iv, credentials_tag, agentmail_inbox_id, status)
    VALUES ($1, $2, 'agentmail', 'api_key', $3, $4, $5, $6, 'active')
  `, [inbox.email, displayName, encrypted.encrypted, encrypted.iv, encrypted.tag, inboxId]);

  console.log(`✓ Added AgentMail account: ${inbox.email}`);
}
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `apps/inbox/core/email-client.ts` | Add `sendViaAgentMail()` method, update interface |
| `apps/inbox/server.ts` | Add webhook endpoint (~40 lines) |
| `scripts/inbox-add-account.ts` | Add AgentMail option (~30 lines) |
| `scripts/campaign-schedule.ts` | Add simple try-catch failover (~15 lines) |

## New Files

| File | Purpose |
|------|---------|
| `schema/migrations/001-add-agentmail.sql` | Schema changes |

## Config Changes

Add to `.env.example`:
```bash
# AgentMail
AGENTMAIL_API_KEY=your_api_key
AGENTMAIL_WEBHOOK_SECRET=your_webhook_secret
```

Add dependency:
```bash
npm install agentmail
```

---

## Acceptance Criteria

- [ ] AgentMail accounts can be added via `inbox-add-account.ts`
- [ ] Emails send through AgentMail SDK
- [ ] Bounces update prospect status via webhook
- [ ] Replies detected via webhook
- [ ] Gmail fallback works when AgentMail fails
- [ ] Existing Gmail/Microsoft accounts unaffected

---

## What We're NOT Building (v1)

Per review feedback, deferred for later if needed:

- ❌ Circuit breaker (rate limiting already exists)
- ❌ AgentMailWrapper class (SDK is sufficient)
- ❌ webhook_events audit table (log to stdout)
- ❌ Failover orchestrator (try-catch is enough)
- ❌ fallback_account_id column (hardcode priority)
- ❌ Priority system (AgentMail first, Gmail fallback)

---

## Test Plan

```bash
# 1. Add AgentMail account
npm run inbox:add-account

# 2. Send test email
CAMPAIGN_TEST_MODE=true npm run campaign:send

# 3. Verify webhook (use ngrok for local)
# - Send to test email, reply, check status updates

# 4. Test fallback (temporarily break AGENTMAIL_API_KEY)
# - Verify Gmail sends when AgentMail fails
```

---

*Simplified based on DHH, Kieran, and Simplicity review feedback*
