# Outbound Pipeline - Handoff Guide

This repo is a copy of the outbound/campaign email pipeline extracted from the SimplCyber Scanner. It sends personalized security outreach emails.

## What This Does

**Pipeline flow:**
1. **Ingest** - Get companies with security findings (API, CSV, or manual)
2. **Enrich** - Find executives via Apollo.io + Harvest
3. **Validate** - Verify emails via EmailListChecker.io
4. **Send** - Gmail OAuth or Microsoft SMTP with tracking
5. **Track** - Bounce detection, opens, replies

## Current State

**Working:**
- Apollo.io enrichment (finds CISOs, CTOs, VPs)
- Gmail OAuth sending
- Microsoft SMTP sending
- Email verification
- Bounce detection
- Multi-inbox rotation with daily limits

**Not Working (needs fixes):**
- Import paths are broken (all reference `../lib/database.js` etc from old repo structure)
- Schema has FK to `scans` table which doesn't exist here
- Some scripts reference scanner-specific columns

---

## WHAT NEEDS TO BE DONE

### Phase 1: Get It Compiling (~1-2 hours)

**1. Fix all import paths**

Every script has imports like:
```typescript
import { getPool } from '../lib/database.js';
```

These need to change based on new structure. Run:
```bash
grep -r "from '\.\." scripts/ | head -20
```

Then fix paths to match the new layout.

**2. Remove scanner references from schema**

In `schema/campaigns.sql`, line 39:
```sql
scan_id TEXT NOT NULL REFERENCES scans(id),  -- DELETE THIS LINE
```

Replace with:
```sql
source_id TEXT NOT NULL,  -- generic ID from your data source
source_type TEXT NOT NULL DEFAULT 'api',  -- 'api', 'csv', 'manual'
```

Also remove these scanner-specific columns from `campaign_prospects`:
- `critical_user_count`
- `medium_user_count`
- `total_eal_ml`
- `top_risk_categories`

**3. Fix the view `campaign_prospect_details`**

It joins to `scans` table. Either delete the view or change it to not reference scans.

### Phase 2: Make It Work (~2-4 hours)

**1. Create an API ingest script**

You said data will come from an API. Create `scripts/api-ingest.ts`:

```typescript
// Pseudocode - adapt to your actual API
import { getPool } from '../lib/database.js';

interface Company {
  domain: string;
  name: string;
  findings: Array<{ type: string; severity: string; details: any }>;
}

async function ingest() {
  const response = await fetch(process.env.SOURCE_API_URL);
  const companies: Company[] = await response.json();

  const pool = getPool();
  for (const company of companies) {
    await pool.query(`
      INSERT INTO campaign_prospects (domain, company_name, source_id, source_type)
      VALUES ($1, $2, $3, 'api')
    `, [company.domain, company.name, company.id]);
  }
}
```

**2. Update env vars**

Add to `.env`:
```
SOURCE_API_URL=https://your-api.com/companies
SOURCE_API_KEY=xxx

APOLLO_API_KEY=xxx
EMAILLISTCHECKER_API_KEY=xxx

# Gmail OAuth (run: npm run inbox:auth-gmail)
GMAIL_CLIENT_ID=xxx
GMAIL_CLIENT_SECRET=xxx

DATABASE_URL=postgresql://localhost/outbound
```

**3. Test the pipeline end-to-end**

```bash
npm install
npm run db:setup

# 1. Ingest some test data
npm run campaign:load  # or your new api-ingest

# 2. Enrich with Apollo
npm run enrich:campaigns

# 3. Verify emails
npm run verify:emails:bulk

# 4. Send test emails
CAMPAIGN_TEST_MODE=true npm run campaign:send
```

---

## File Inventory

```
outbound/
├── apps/
│   ├── campaigns/core/     # API clients
│   │   ├── apollo-client.ts    # Apollo.io people search
│   │   ├── gmail-client.ts     # Gmail OAuth sending
│   │   ├── harvest-client.ts   # LinkedIn email finder
│   │   └── role-email-finder.ts
│   └── inbox/              # Multi-inbox management
│       ├── server.ts           # Web UI for viewing all inboxes
│       ├── core/
│       │   ├── email-client.ts # SMTP/IMAP client
│       │   └── crypto.ts       # Credential encryption
│       └── public/             # Web UI assets
├── lib/
│   ├── database.ts             # PostgreSQL connection pool
│   └── campaigns/
│       ├── email-verifier.ts   # EmailListChecker.io wrapper
│       ├── email.ts            # Email utilities
│       └── validation-service.ts # Two-gate validation
├── scripts/                # 45 scripts (see below)
├── templates/email/        # Handlebars email templates
├── schema/
│   ├── campaigns.sql       # Campaign tables
│   └── inbox.sql           # Sender accounts table
├── package.json
├── tsconfig.json
└── .env.example
```

### Key Scripts

| Script | Purpose |
|--------|---------|
| `campaign-loader.ts` | Load prospects from CSV |
| `campaign-enrich-apollo.ts` | Find executives via Apollo |
| `enrich-campaigns.ts` | Batch enrichment orchestrator |
| `campaign-send.ts` | Send emails (test mode) |
| `campaign-schedule.ts` | Production sender with rate limits |
| `verify-emails-bulk.ts` | Verify emails via EmailListChecker |
| `validate-infostealer-contacts.ts` | Check if contacts still at company |
| `detect-bounces.ts` | Scan Gmail for bounce notifications |
| `inbox-add-account.ts` | Add Gmail/Microsoft sender account |
| `inbox-auth-gmail.ts` | Gmail OAuth setup |

---

## Known Issues to Fix

### Critical

1. **`campaign-schedule.ts` has hardcoded email**
   - Line ~200: `ryanrheger@gmail.com` as fallback
   - Replace with config or remove

2. **`email-client.ts` has bad TLS settings**
   - `rejectUnauthorized: false` and `ciphers: 'SSLv3'`
   - Fix or remove these for production

3. **`lib/campaigns/email.ts` imports ApolloPerson type**
   - Line 8: `import type { ApolloPerson } from '../../apps/campaigns/core/apollo-client.js'`
   - Need to fix this circular-ish import

### Important

4. **Schema trigger is slow**
   - `update_campaign_stats()` in campaigns.sql does 5 COUNT(*) on every update
   - Replace with incremental counters for scale

5. **Gmail-specific column names**
   - `gmail_thread_id`, `gmail_message_id` in schema
   - Rename to `provider_thread_id` etc if supporting other senders

### Nice to Have

6. **Console.log everywhere**
   - Many scripts use `console.log` instead of Pino logger
   - Convert to: `import pino from 'pino'; const log = pino();`

---

## API Keys You'll Need

| Service | Purpose | Get it at |
|---------|---------|-----------|
| Apollo.io | Find executives | https://app.apollo.io/settings/integrations |
| EmailListChecker.io | Verify emails | https://emaillistchecker.io/ |
| Google Cloud | Gmail OAuth | https://console.cloud.google.com/apis/credentials |

---

## Questions for You

Before the next agent starts, decide:

1. **What's your source API shape?** - What fields does it return? (domain, company name, findings?)
2. **Gmail or AgentMail?** - Gmail OAuth is ready. AgentMail (https://agentmail.to) is simpler but not implemented yet.
3. **New database or same?** - Fresh Postgres or copy of existing?

---

## To Run

```bash
cd /Users/ryanheger/outbound
npm install
cp .env.example .env
# Edit .env with your API keys

# Setup database
createdb outbound
npm run db:setup

# Then work through Phase 1 and 2 above
```
