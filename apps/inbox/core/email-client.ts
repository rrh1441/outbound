/**
 * Unified Email Client
 *
 * SMTP/IMAP client that works with both Gmail and Microsoft accounts.
 * Gmail with OAuth uses Gmail API directly; Microsoft uses SMTP/IMAP with XOAUTH2.
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import Imap from 'imap';
import { simpleParser, ParsedMail } from 'mailparser';
import { google, gmail_v1 } from 'googleapis';
import { AgentMailClient } from 'agentmail';
import { decryptCredentials } from './crypto.js';

// Microsoft OAuth token refresh
async function refreshMicrosoftToken(refreshToken: string): Promise<{ access_token: string; refresh_token: string }> {
  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID || '',
    client_secret: process.env.MS_CLIENT_SECRET || '',
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access'
  });

  const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Token refresh failed: ${error.error_description || error.error}`);
  }

  return response.json();
}

// Build XOAUTH2 token for IMAP
function buildXOAuth2Token(user: string, accessToken: string): string {
  const authString = `user=${user}\x01auth=Bearer ${accessToken}\x01\x01`;
  return Buffer.from(authString).toString('base64');
}

export interface SenderAccount {
  id: string;
  email: string;
  display_name: string | null;
  provider: 'gmail' | 'microsoft' | 'agentmail';
  auth_type: 'oauth' | 'password' | 'api_key';
  credentials_encrypted: string;
  credentials_iv: string;
  credentials_tag: string;
  smtp_host: string | null;
  smtp_port: number | null;
  imap_host: string | null;
  imap_port: number | null;
  status: string;
  daily_limit: number;
  emails_sent_today: number;
  agentmail_inbox_id: string | null;
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
  headers?: Record<string, string>;
}

export interface EmailMessage {
  uid: string;
  messageId: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  from: { address: string; name?: string };
  to: { address: string; name?: string }[];
  cc?: { address: string; name?: string }[];
  subject: string;
  date: Date;
  bodyText?: string;
  bodyHtml?: string;
  snippet?: string;
  headers: Record<string, string>;
}

// Provider-specific configurations (agentmail doesn't use SMTP/IMAP)
const PROVIDER_CONFIG: Record<string, { smtp: { host: string; port: number; secure: boolean }; imap: { host: string; port: number; tls: boolean } }> = {
  gmail: {
    smtp: { host: 'smtp.gmail.com', port: 587, secure: false },
    imap: { host: 'imap.gmail.com', port: 993, tls: true }
  },
  microsoft: {
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    imap: { host: 'outlook.office365.com', port: 993, tls: true }
  }
};

export class EmailClient {
  private account: SenderAccount;
  private credentials: Record<string, string>;
  private transporter: Transporter | null = null;
  private gmailClient: gmail_v1.Gmail | null = null;

  constructor(account: SenderAccount) {
    this.account = account;
    this.credentials = decryptCredentials(
      account.credentials_encrypted,
      account.credentials_iv,
      account.credentials_tag
    );
  }

  /**
   * Get Gmail API client (for OAuth Gmail accounts)
   */
  private getGmailClient(): gmail_v1.Gmail {
    if (this.gmailClient) {
      return this.gmailClient;
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/oauth/callback'
    );

    oauth2Client.setCredentials({
      refresh_token: this.credentials.refresh_token
    });

    this.gmailClient = google.gmail({ version: 'v1', auth: oauth2Client });
    return this.gmailClient;
  }

  /**
   * Get SMTP transporter (for password-based auth)
   */
  private async getTransporter(): Promise<Transporter> {
    if (this.transporter) {
      return this.transporter;
    }

    const config = PROVIDER_CONFIG[this.account.provider];
    const smtpHost = this.account.smtp_host || config.smtp.host;
    const smtpPort = this.account.smtp_port || config.smtp.port;

    // Password-based auth (Microsoft, or Gmail with app password)
    this.transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: false,
      auth: {
        user: this.account.email,
        pass: this.credentials.password
      },
      tls: {
        ciphers: 'SSLv3',
        rejectUnauthorized: false
      }
    });

    // Verify connection
    await this.transporter.verify();

    return this.transporter;
  }

  /**
   * Send an email
   */
  async sendEmail(options: SendEmailOptions): Promise<{ messageId: string }> {
    // Use AgentMail for agentmail accounts
    if (this.account.provider === 'agentmail') {
      return this.sendViaAgentMail(options);
    }

    // Use Gmail API for OAuth Gmail accounts
    if (this.account.provider === 'gmail' && this.account.auth_type === 'oauth') {
      return this.sendViaGmailApi(options);
    }

    // Use SMTP for everything else
    return this.sendViaSmtp(options);
  }

  /**
   * Send via AgentMail API
   */
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
      replyTo: options.replyTo ? [options.replyTo] : undefined,
      headers: options.headers,
    });

    return { messageId: result.messageId };
  }

  /**
   * Strip HTML tags to get plain text
   */
  private stripHtml(html: string): string {
    return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Send via Gmail API (for OAuth)
   */
  private async sendViaGmailApi(options: SendEmailOptions): Promise<{ messageId: string }> {
    const gmail = this.getGmailClient();

    const fromAddress = this.account.display_name
      ? `${this.account.display_name} <${this.account.email}>`
      : this.account.email;

    // Build MIME message
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36)}`;

    let message = [
      `From: ${fromAddress}`,
      `To: ${options.to}`,
      `Subject: ${options.subject}`,
    ];

    if (options.replyTo) {
      message.push(`Reply-To: ${options.replyTo}`);
    }

    if (options.inReplyTo) {
      message.push(`In-Reply-To: ${options.inReplyTo}`);
    }

    if (options.references) {
      message.push(`References: ${options.references}`);
    }

    if (options.headers) {
      Object.entries(options.headers).forEach(([key, value]) => {
        message.push(`${key}: ${value}`);
      });
    }

    message.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    message.push('');

    // Text part
    const bodyText = options.bodyText || options.bodyHtml.replace(/<[^>]*>/g, '');
    message.push(`--${boundary}`);
    message.push('Content-Type: text/plain; charset=UTF-8');
    message.push('');
    message.push(bodyText);
    message.push('');

    // HTML part
    message.push(`--${boundary}`);
    message.push('Content-Type: text/html; charset=UTF-8');
    message.push('');
    message.push(options.bodyHtml);
    message.push('');
    message.push(`--${boundary}--`);

    const rawMessage = message.join('\r\n');
    const encodedMessage = Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage
      }
    });

    return { messageId: response.data.id || '' };
  }

  /**
   * Send via SMTP (for password auth)
   */
  private async sendViaSmtp(options: SendEmailOptions): Promise<{ messageId: string }> {
    const transporter = await this.getTransporter();

    const fromAddress = this.account.display_name
      ? `${this.account.display_name} <${this.account.email}>`
      : this.account.email;

    const mailOptions: nodemailer.SendMailOptions = {
      from: fromAddress,
      to: options.to,
      subject: options.subject,
      text: options.bodyText || options.bodyHtml.replace(/<[^>]*>/g, ''),
      html: options.bodyHtml,
      replyTo: options.replyTo,
      headers: options.headers || {}
    };

    // Threading headers for replies
    if (options.inReplyTo) {
      mailOptions.inReplyTo = options.inReplyTo;
    }
    if (options.references) {
      mailOptions.references = options.references;
    }

    const result = await transporter.sendMail(mailOptions);

    return { messageId: result.messageId };
  }

  /**
   * Create IMAP connection
   */
  private async createImapConnection(): Promise<Imap> {
    const config = PROVIDER_CONFIG[this.account.provider];
    const imapHost = this.account.imap_host || config.imap.host;
    const imapPort = this.account.imap_port || config.imap.port;

    // For Microsoft OAuth, refresh token and use XOAUTH2
    if (this.account.provider === 'microsoft' && this.account.auth_type === 'oauth') {
      // Refresh the access token
      const tokens = await refreshMicrosoftToken(this.credentials.refresh_token);
      const xoauth2Token = buildXOAuth2Token(this.account.email, tokens.access_token);

      return new Promise((resolve, reject) => {
        const imap = new Imap({
          user: this.account.email,
          xoauth2: xoauth2Token,
          host: imapHost,
          port: imapPort,
          tls: true,
          tlsOptions: { rejectUnauthorized: false },
          authTimeout: 15000,
          connTimeout: 15000
        });

        imap.once('ready', () => resolve(imap));
        imap.once('error', reject);

        imap.connect();
      });
    }

    // Default: password auth
    return new Promise((resolve, reject) => {
      const imap = new Imap({
        user: this.account.email,
        password: this.credentials.password,
        host: imapHost,
        port: imapPort,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 10000,
        connTimeout: 10000
      });

      imap.once('ready', () => resolve(imap));
      imap.once('error', reject);

      imap.connect();
    });
  }

  /**
   * Fetch messages from inbox
   */
  async fetchMessages(options: {
    folder?: string;
    since?: Date;
    limit?: number;
    sinceUid?: string;
  } = {}): Promise<EmailMessage[]> {
    const { folder = 'INBOX', since, limit = 50, sinceUid } = options;

    const imap = await this.createImapConnection();

    return new Promise((resolve, reject) => {
      imap.openBox(folder, true, (err, box) => {
        if (err) {
          imap.end();
          return reject(err);
        }

        // Build search criteria
        let searchCriteria: any[] = ['ALL'];

        if (since) {
          searchCriteria = [['SINCE', since]];
        }

        if (sinceUid) {
          searchCriteria = [[`UID`, `${sinceUid}:*`]];
        }

        imap.search(searchCriteria, (searchErr, results) => {
          if (searchErr) {
            imap.end();
            return reject(searchErr);
          }

          if (!results || results.length === 0) {
            imap.end();
            return resolve([]);
          }

          // Limit results
          const uidsToFetch = results.slice(-limit);

          const fetch = imap.fetch(uidsToFetch, {
            bodies: '',
            struct: true
          });

          // Collect message parsing promises to properly wait for all async operations
          const messagePromises: Promise<EmailMessage | null>[] = [];

          fetch.on('message', (msg, seqno) => {
            const messagePromise = new Promise<EmailMessage | null>((resolveMsg) => {
              let uid = '';
              let buffer = '';

              msg.on('attributes', (attrs) => {
                uid = String(attrs.uid);
              });

              msg.on('body', (stream) => {
                stream.on('data', (chunk) => {
                  buffer += chunk.toString('utf8');
                });

                stream.on('end', async () => {
                  try {
                    const parsed = await simpleParser(buffer);
                    const message = this.parsedMailToMessage(parsed, uid);
                    resolveMsg(message);
                  } catch (parseErr) {
                    console.error('Failed to parse message:', parseErr);
                    resolveMsg(null);
                  }
                });
              });
            });

            messagePromises.push(messagePromise);
          });

          fetch.once('error', (fetchErr) => {
            imap.end();
            reject(fetchErr);
          });

          fetch.once('end', async () => {
            // Wait for all message parsing to complete
            const parsedMessages = await Promise.all(messagePromises);
            const messages = parsedMessages.filter((m): m is EmailMessage => m !== null);

            imap.end();
            // Sort by date descending
            messages.sort((a, b) => b.date.getTime() - a.date.getTime());
            resolve(messages);
          });
        });
      });
    });
  }

  /**
   * Fetch sent messages
   */
  async fetchSentMessages(options: {
    since?: Date;
    limit?: number;
  } = {}): Promise<EmailMessage[]> {
    // Try common sent folder names
    const sentFolders = this.account.provider === 'microsoft'
      ? ['Sent Items', 'Sent', 'INBOX.Sent']
      : ['[Gmail]/Sent Mail', 'Sent', 'INBOX.Sent'];

    for (const folder of sentFolders) {
      try {
        return await this.fetchMessages({ ...options, folder });
      } catch {
        // Try next folder name
        continue;
      }
    }

    return [];
  }

  /**
   * Convert parsed mail to our message format
   */
  private parsedMailToMessage(parsed: ParsedMail, uid: string): EmailMessage {
    const fromAddr = parsed.from?.value?.[0] || { address: 'unknown', name: '' };
    const toAddrs = parsed.to?.value || [];

    // Extract snippet from text body
    const snippet = parsed.text
      ? parsed.text.substring(0, 200).replace(/\s+/g, ' ').trim()
      : '';

    // Build headers map
    const headers: Record<string, string> = {};
    if (parsed.headers) {
      parsed.headers.forEach((value, key) => {
        headers[key] = String(value);
      });
    }

    // Try to extract thread ID from headers
    let threadId = parsed.messageId;
    if (parsed.references && parsed.references.length > 0) {
      // Use first reference as thread root
      threadId = parsed.references[0];
    } else if (parsed.inReplyTo) {
      threadId = parsed.inReplyTo;
    }

    return {
      uid,
      messageId: parsed.messageId || `${uid}@${this.account.email}`,
      threadId,
      inReplyTo: parsed.inReplyTo,
      references: Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references,
      from: { address: fromAddr.address || '', name: fromAddr.name },
      to: toAddrs.map(t => ({ address: t.address || '', name: t.name })),
      cc: parsed.cc?.value?.map(c => ({ address: c.address || '', name: c.name })),
      subject: parsed.subject || '(no subject)',
      date: parsed.date || new Date(),
      bodyText: parsed.text,
      bodyHtml: parsed.html || undefined,
      snippet,
      headers
    };
  }

  /**
   * Test connection (both SMTP and IMAP)
   */
  async testConnection(): Promise<{ smtp: boolean; imap: boolean; errors: string[] }> {
    const errors: string[] = [];
    let smtp = false;
    let imap = false;

    // Test SMTP
    try {
      const transporter = await this.getTransporter();
      await transporter.verify();
      smtp = true;
    } catch (err: any) {
      errors.push(`SMTP: ${err.message}`);
    }

    // Test IMAP
    try {
      const imapConn = await this.createImapConnection();
      imapConn.end();
      imap = true;
    } catch (err: any) {
      errors.push(`IMAP: ${err.message}`);
    }

    return { smtp, imap, errors };
  }

  /**
   * Close connections
   */
  close(): void {
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
    }
  }
}

/**
 * Create email client from account record
 */
export function createEmailClient(account: SenderAccount): EmailClient {
  return new EmailClient(account);
}
