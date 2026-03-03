# Outbound

Email pipeline for sending personalized outreach to company executives. Handles the full workflow: ingest companies, find contacts via Apollo.io, verify emails, send via Gmail/AgentMail, and track responses.

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env with your API keys

# Setup database
createdb outbound
npm run db:setup

# Run the pipeline
npm run campaign:load        # Load prospects
npm run enrich:campaigns     # Find executives via Apollo
npm run verify:emails:bulk   # Verify email deliverability
npm run campaign:send        # Send (test mode by default)
```

## Pipeline Flow

```
Ingest → Batch Check → Enrich → Verify → Send → Track
```

The batch check (100 domains per API credit) dramatically reduces Apollo costs by identifying which domains have reachable executives before enriching.

## Key Scripts

| Script | Purpose |
|--------|---------|
| `npm run campaign:load` | Load prospects from CSV |
| `npm run enrich:campaigns` | Find executives via Apollo.io |
| `npm run verify:emails:bulk` | Verify emails via EmailListChecker |
| `npm run campaign:send` | Send emails (test mode) |
| `npm run bounces:detect` | Scan for bounce notifications |
| `npm run inbox:auth-gmail` | Gmail OAuth setup |
| `npm run inbox:server` | Start unified inbox UI |

## Project Structure

```
outbound/
├── apps/
│   ├── campaigns/core/     # API clients (Apollo, Gmail, Harvest)
│   └── inbox/              # Multi-inbox management + web UI
├── lib/
│   ├── database.ts         # PostgreSQL connection pool
│   └── campaigns/          # Email verification + utilities
├── scripts/                # CLI scripts for each pipeline step
├── templates/email/        # Handlebars email templates
└── schema/                 # PostgreSQL schemas
```

## Required API Keys

| Service | Purpose | URL |
|---------|---------|-----|
| Apollo.io | Find executives | https://app.apollo.io/settings/integrations |
| EmailListChecker.io | Verify emails | https://emaillistchecker.io/ |
| Google Cloud | Gmail OAuth | https://console.cloud.google.com/apis/credentials |
| AgentMail | Alternative sender | https://console.agentmail.to |

## Documentation

- [HANDOFF.md](HANDOFF.md) - Setup guide and known issues
- [workflow.md](workflow.md) - Detailed pipeline explanation and cost optimization
