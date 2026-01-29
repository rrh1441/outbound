# Outbound Email Pipeline - How It Works

This system sends personalized outreach emails to company executives. Here's how the pieces fit together.

---

## The Big Picture

```
Get Companies → Batch Check for Contacts → Enrich (only qualified) → Verify Emails → Send → Track
```

The critical insight: **batch the free people search BEFORE enriching**. This saves massive Apollo credits.

---

## Why Batching Matters (Cost Savings)

Apollo charges per API call. The batch people search checks 100 domains per credit:

| Approach | 1000 Companies | Cost |
|----------|---------------|------|
| Without batching | 1 call per domain | 1000 credits |
| **With batching** | 1 call per 100 domains | **10 credits** |

The batch search tells you which domains have a qualified buyer (CISO, CTO, VP, etc.) with an email available. You only pay for full enrichment on those.

---

## Step 1: Ingest Companies

**What happens:** Load companies into the system.

**How:** Run `scripts/api-ingest.ts` (or CSV loaders)

**Result:** Companies stored with status `queued`

```bash
npm run ingest:api -- --dry-run  # Preview
npm run ingest:api               # Load
```

---

## Step 2: Batch Check for Qualified Buyers (FREE-ish)

**This is the key step that saves you money.**

**What happens:** Check which companies have executives with email addresses, 100 at a time.

**How:** Run `scripts/verify-emails-for-scans.ts`

**What it does:**
1. Takes up to 100 company domains
2. Calls Apollo's people search (1 credit for the whole batch)
3. Filters for qualified titles: CEO, CTO, CISO, VP, Director, etc.
4. Returns which domains have someone with an available email
5. Marks domains without contacts so we skip them later

**Cost:** 1 credit per 100 domains (not 1 credit per domain!)

**Result:** `scan_email_status` table tracks which domains have qualified contacts

```bash
npm run verify:emails -- --limit=1000   # 10 credits for 1000 domains
npm run verify:emails -- --status       # See hit rate
```

Typical hit rate is 30-50%. So out of 1000 companies, maybe 400 have a reachable executive. Now you only pay to enrich those 400.

---

## Step 3: Enrich with Full Contact Info

**What happens:** For domains that passed the batch check, get the actual email addresses.

**How:** Run `scripts/enrich-campaigns.ts`

**What it does:**
1. Pulls only domains that have `has_qualified_email = true`
2. Calls Apollo to get the person's name, title, and email
3. Updates the prospect record

**Cost:** Credits per enrichment call (varies by Apollo plan)

**Why this is efficient:** You're not wasting credits on domains that have no reachable contact.

```bash
npm run enrich:campaigns
```

---

## Step 4: Verify Email Deliverability

**What happens:** Confirm the email addresses won't bounce.

**How:** Run `scripts/verify-emails-bulk.ts`

**What it does:**
1. Sends each email to EmailListChecker.io
2. Gets deliverability score
3. Marks risky/undeliverable emails

**Why:** Too many bounces = spam folder. This protects your sender reputation.

```bash
npm run verify:emails:bulk
```

---

## Step 5: Send Emails

**What happens:** Send personalized emails through Gmail/Microsoft.

**How:** Run `scripts/campaign-send.ts` (test) or `scripts/campaign-schedule.ts` (production)

**What it does:**
1. Picks prospects with verified emails
2. Personalizes email template
3. Sends via OAuth/SMTP
4. Rotates between sender accounts
5. Respects daily limits (50/inbox default)

```bash
# Always test first
CAMPAIGN_TEST_MODE=true npm run campaign:send

# Then production
CAMPAIGN_TEST_MODE=false npm run campaign:send
```

---

## Step 6: Track Responses

**What happens:** Detect bounces, opens, replies.

**How:** Run `scripts/detect-bounces.ts` + check inbox server

```bash
npm run detect:bounces
open http://localhost:3847  # Unified inbox UI
```

---

## Complete Pipeline Example

```bash
# 1. Load 1000 companies from your API
npm run ingest:api -- --limit 1000

# 2. Batch check which have contacts (10 credits, not 1000!)
npm run verify:emails -- --limit 1000
# Output: "Hit rate: 42% - 420 companies have qualified contacts"

# 3. Enrich ONLY the 420 that have contacts
npm run enrich:campaigns

# 4. Verify those emails are deliverable
npm run verify:emails:bulk

# 5. Test send
CAMPAIGN_TEST_MODE=true npm run campaign:send -- --batch-size 5

# 6. Production send
CAMPAIGN_TEST_MODE=false npm run campaign:send -- --batch-size 50

# 7. Monitor
npm run detect:bounces
```

**Credits used:**
- Batch check: 10 (for 1000 domains)
- Enrichment: ~420 (only qualified domains)
- **Total: ~430 credits instead of 1420+**

---

## Database Tables

| Table | Purpose |
|-------|---------|
| `campaigns` | Campaign definitions and aggregate stats |
| `campaign_prospects` | One row per company/contact being reached |
| `campaign_emails` | Every email sent and received |
| `scan_email_status` | Tracks batch check results (has_qualified_email) |
| `sender_accounts` | Gmail/Microsoft accounts with encrypted creds |
| `inbox_messages` | Synced emails for unified inbox view |

---

## Key Scripts

| Script | What It Does | Cost |
|--------|--------------|------|
| `verify-emails-for-scans.ts` | Batch check for contacts | 1 credit / 100 domains |
| `enrich-campaigns.ts` | Get actual email addresses | ~1 credit / domain |
| `verify-emails-bulk.ts` | Check deliverability | EmailListChecker credits |
| `campaign-send.ts` | Send emails (test mode) | Free |
| `campaign-schedule.ts` | Send emails (production) | Free |
| `detect-bounces.ts` | Find bounced emails | Free |

---

## Environment Variables

```bash
# Required
DATABASE_URL=postgresql://localhost/outbound
APOLLO_API_KEY=xxx                    # For batch check + enrichment
EMAILLISTCHECKER_API_KEY=xxx          # For deliverability check
CAMPAIGN_TEST_RECIPIENT=you@email.com # Where test emails go

# Gmail OAuth
GMAIL_CLIENT_ID=xxx
GMAIL_CLIENT_SECRET=xxx

# Security
SENDER_ENCRYPTION_KEY=xxx             # For stored credentials
```
