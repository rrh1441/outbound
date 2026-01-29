/**
 * Unified Inbox Web Server
 *
 * Web interface to view and send emails across all sender accounts.
 * Supports Gmail and Microsoft accounts.
 */

import express from 'express';
import { config } from 'dotenv';
import { getPool } from '../../lib/database.js';
import { createEmailClient, SenderAccount, EmailMessage } from './core/email-client.js';
import path from 'path';
import { fileURLToPath } from 'url';

config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.INBOX_PORT || 3001;

const pool = getPool();

// Input validation helpers
function validateInt(value: unknown, defaultValue: number, min: number, max: number): number {
  const num = parseInt(String(value), 10);
  if (isNaN(num)) return defaultValue;
  return Math.max(min, Math.min(max, num));
}

function validateUUID(value: unknown): string | null {
  if (!value || typeof value !== 'string') return null;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value) ? value : null;
}

function validateDirection(value: unknown): 'inbound' | 'outbound' | null {
  if (value === 'inbound' || value === 'outbound') return value;
  return null;
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Simple auth middleware (optional, set INBOX_PASSWORD in .env)
const INBOX_PASSWORD = process.env.INBOX_PASSWORD;

if (INBOX_PASSWORD) {
  app.use((req, res, next) => {
    // Skip auth for static files
    if (req.path.startsWith('/static')) return next();

    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Unified Inbox"');
      return res.status(401).send('Authentication required');
    }

    const credentials = Buffer.from(auth.slice(6), 'base64').toString();
    const [, password] = credentials.split(':');

    if (password !== INBOX_PASSWORD) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Unified Inbox"');
      return res.status(401).send('Invalid password');
    }

    next();
  });
}

// ============================================================================
// API Routes
// ============================================================================

/**
 * GET /api/accounts - List all sender accounts
 */
app.get('/api/accounts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id, email, display_name, provider, status,
        daily_limit, emails_sent_today, last_sent_at, last_sync_at,
        tags, last_error
      FROM sender_accounts
      ORDER BY provider, email
    `);

    res.json({ accounts: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/accounts/:id/health - Test account connection
 */
app.get('/api/accounts/:id/health', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sender_accounts WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const account = result.rows[0] as SenderAccount;
    const client = createEmailClient(account);

    const health = await client.testConnection();
    client.close();

    // Update status in DB
    const newStatus = health.smtp && health.imap ? 'active' : 'error';
    await pool.query(
      'UPDATE sender_accounts SET status = $1, last_error = $2, last_error_at = $3 WHERE id = $4',
      [newStatus, health.errors.join('; ') || null, health.errors.length > 0 ? new Date() : null, req.params.id]
    );

    res.json({ ...health, status: newStatus });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/messages - Get messages from database (unified inbox)
 */
app.get('/api/messages', async (req, res) => {
  try {
    // Validate and sanitize query parameters
    const validatedAccountId = validateUUID(req.query.account_id);
    const validatedDirection = validateDirection(req.query.direction);
    const validatedLimit = validateInt(req.query.limit, 50, 1, 100); // Max 100 per page
    const validatedOffset = validateInt(req.query.offset, 0, 0, 10000); // Max offset 10k
    const unread = req.query.unread === 'true';

    let query = `
      SELECT
        m.*,
        s.display_name as account_name,
        s.provider
      FROM inbox_messages m
      JOIN sender_accounts s ON s.id = m.account_id
      WHERE m.is_deleted = FALSE
    `;

    const params: any[] = [];
    let paramIdx = 1;

    if (validatedAccountId) {
      query += ` AND m.account_id = $${paramIdx++}`;
      params.push(validatedAccountId);
    }

    if (validatedDirection) {
      query += ` AND m.direction = $${paramIdx++}`;
      params.push(validatedDirection);
    }

    if (unread) {
      query += ` AND m.is_read = FALSE`;
    }

    query += ` ORDER BY m.sent_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(validatedLimit, validatedOffset);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `
      SELECT COUNT(*) FROM inbox_messages m
      WHERE m.is_deleted = FALSE
    `;
    const countParams: any[] = [];
    let countParamIdx = 1;

    if (validatedAccountId) {
      countQuery += ` AND m.account_id = $${countParamIdx++}`;
      countParams.push(validatedAccountId);
    }
    if (validatedDirection) {
      countQuery += ` AND m.direction = $${countParamIdx++}`;
      countParams.push(validatedDirection);
    }
    if (unread) {
      countQuery += ` AND m.is_read = FALSE`;
    }

    const countResult = await pool.query(countQuery, countParams);

    res.json({
      messages: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: validatedLimit,
      offset: validatedOffset
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

/**
 * GET /api/messages/:id - Get single message
 */
app.get('/api/messages/:id', async (req, res) => {
  try {
    const messageId = validateUUID(req.params.id);
    if (!messageId) {
      return res.status(400).json({ error: 'Invalid message ID format' });
    }

    const result = await pool.query(`
      SELECT
        m.*,
        s.display_name as account_name,
        s.provider
      FROM inbox_messages m
      JOIN sender_accounts s ON s.id = m.account_id
      WHERE m.id = $1
    `, [messageId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Mark as read
    await pool.query('UPDATE inbox_messages SET is_read = TRUE WHERE id = $1', [messageId]);

    res.json({ message: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch message' });
  }
});

/**
 * POST /api/messages/:id/read - Mark message as read/unread
 */
app.post('/api/messages/:id/read', async (req, res) => {
  try {
    const { read = true } = req.body;
    await pool.query('UPDATE inbox_messages SET is_read = $1 WHERE id = $2', [read, req.params.id]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/threads/:threadId - Get all messages in a thread
 */
app.get('/api/threads/:threadId', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        m.*,
        s.display_name as account_name,
        s.provider
      FROM inbox_messages m
      JOIN sender_accounts s ON s.id = m.account_id
      WHERE m.thread_id = $1 OR m.id = $1
      ORDER BY m.sent_at ASC
    `, [req.params.threadId]);

    res.json({ messages: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/send - Send an email
 */
app.post('/api/send', async (req, res) => {
  try {
    const { account_id, to, subject, body_html, body_text, reply_to_message_id } = req.body;

    if (!account_id || !to || !subject || !body_html) {
      return res.status(400).json({ error: 'Missing required fields: account_id, to, subject, body_html' });
    }

    // Get account
    const accountResult = await pool.query(
      'SELECT * FROM sender_accounts WHERE id = $1',
      [account_id]
    );

    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const account = accountResult.rows[0] as SenderAccount;

    // Check daily limit - count ACTUAL sends today, not a counter
    const sentTodayResult = await pool.query(`
      SELECT COUNT(*) as sent_today
      FROM campaign_prospects
      WHERE sender_email = $1
        AND status = 'sent'
        AND last_sent_at >= CURRENT_DATE
        AND last_sent_at < CURRENT_DATE + INTERVAL '1 day'
    `, [account.email]);
    const sentToday = parseInt(sentTodayResult.rows[0].sent_today, 10);

    if (sentToday >= account.daily_limit) {
      return res.status(429).json({ error: `Daily limit reached (${sentToday}/${account.daily_limit})` });
    }

    // Get reply threading info if replying
    let inReplyTo: string | undefined;
    let references: string | undefined;
    let threadId: string | undefined;

    if (reply_to_message_id) {
      const replyMsg = await pool.query(
        'SELECT message_uid, thread_id, references_header FROM inbox_messages WHERE id = $1',
        [reply_to_message_id]
      );

      if (replyMsg.rows.length > 0) {
        inReplyTo = replyMsg.rows[0].message_uid;
        threadId = replyMsg.rows[0].thread_id;
        references = replyMsg.rows[0].references_header
          ? `${replyMsg.rows[0].references_header} ${inReplyTo}`
          : inReplyTo;
      }
    }

    // Send email
    const client = createEmailClient(account);

    const result = await client.sendEmail({
      to,
      subject,
      bodyHtml: body_html,
      bodyText: body_text,
      inReplyTo,
      references
    });

    client.close();

    // Record in database
    await pool.query(`
      INSERT INTO inbox_messages (
        account_id, account_email, message_uid, thread_id,
        in_reply_to, references_header, direction, folder,
        from_email, from_name, to_email, subject,
        body_text, body_html, snippet, is_read, sent_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
      RETURNING id
    `, [
      account.id,
      account.email,
      result.messageId,
      threadId || result.messageId,
      inReplyTo,
      references,
      'outbound',
      'Sent',
      account.email,
      account.display_name,
      to,
      subject,
      body_text || body_html.replace(/<[^>]*>/g, ''),
      body_html,
      body_html.replace(/<[^>]*>/g, '').substring(0, 200),
      true
    ]);

    // Update account stats
    await pool.query(`
      UPDATE sender_accounts
      SET emails_sent_today = emails_sent_today + 1,
          emails_sent_total = emails_sent_total + 1,
          last_sent_at = NOW()
      WHERE id = $1
    `, [account.id]);

    res.json({ success: true, message_id: result.messageId });
  } catch (err: any) {
    console.error('Send error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sync - Sync messages from all accounts
 */
app.post('/api/sync', async (req, res) => {
  try {
    const { account_id } = req.body;

    let accounts: SenderAccount[];

    if (account_id) {
      const result = await pool.query('SELECT * FROM sender_accounts WHERE id = $1', [account_id]);
      accounts = result.rows;
    } else {
      const result = await pool.query('SELECT * FROM sender_accounts WHERE status = $1', ['active']);
      accounts = result.rows;
    }

    const results: { email: string; synced: number; errors: string[] }[] = [];

    for (const account of accounts) {
      const syncResult = { email: account.email, synced: 0, errors: [] as string[] };

      try {
        const client = createEmailClient(account);

        // Sync inbox
        const since = account.last_sync_at
          ? new Date(account.last_sync_at)
          : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Last 7 days

        const messages = await client.fetchMessages({ since, limit: 100 });

        for (const msg of messages) {
          // Skip if already exists
          const existing = await pool.query(
            'SELECT id FROM inbox_messages WHERE account_id = $1 AND message_uid = $2',
            [account.id, msg.uid]
          );

          if (existing.rows.length > 0) continue;

          // Determine direction
          const direction = msg.from.address.toLowerCase() === account.email.toLowerCase()
            ? 'outbound'
            : 'inbound';

          await pool.query(`
            INSERT INTO inbox_messages (
              account_id, account_email, message_uid, thread_id,
              in_reply_to, references_header, direction, folder,
              from_email, from_name, to_email, to_name, subject,
              body_text, body_html, snippet, sent_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            ON CONFLICT (account_id, message_uid) DO NOTHING
          `, [
            account.id,
            account.email,
            msg.uid,
            msg.threadId,
            msg.inReplyTo,
            msg.references,
            direction,
            'INBOX',
            msg.from.address,
            msg.from.name,
            msg.to[0]?.address,
            msg.to[0]?.name,
            msg.subject,
            msg.bodyText,
            msg.bodyHtml,
            msg.snippet,
            msg.date
          ]);

          syncResult.synced++;
        }

        // Update last sync time
        await pool.query(
          'UPDATE sender_accounts SET last_sync_at = NOW() WHERE id = $1',
          [account.id]
        );

        client.close();
      } catch (err: any) {
        syncResult.errors.push(err.message);

        // Update account status
        await pool.query(
          'UPDATE sender_accounts SET status = $1, last_error = $2, last_error_at = NOW() WHERE id = $3',
          ['error', err.message, account.id]
        );
      }

      results.push(syncResult);
    }

    res.json({
      synced: results.reduce((sum, r) => sum + r.synced, 0),
      accounts: results
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/stats - Get inbox statistics
 */
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM sender_accounts) as total_accounts,
        (SELECT COUNT(*) FROM sender_accounts WHERE status = 'active') as active_accounts,
        (SELECT COUNT(*) FROM inbox_messages WHERE direction = 'inbound' AND is_read = FALSE) as unread_count,
        (SELECT COUNT(*) FROM inbox_messages WHERE direction = 'inbound') as total_inbound,
        (SELECT COUNT(*) FROM inbox_messages WHERE direction = 'outbound') as total_outbound,
        (SELECT SUM(emails_sent_today) FROM sender_accounts) as sent_today
    `);

    res.json(stats.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Frontend Routes
// ============================================================================

// Serve the frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================================
// Start Server
// ============================================================================

app.listen(PORT, () => {
  console.log(`\n📧 Unified Inbox running at http://localhost:${PORT}`);
  if (INBOX_PASSWORD) {
    console.log('   Password protection: ENABLED');
  }
  console.log('');
});
