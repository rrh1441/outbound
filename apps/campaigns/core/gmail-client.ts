/**
 * Gmail API Client
 *
 * Reusable wrapper around Google Gmail API with OAuth token management.
 */

import { google, gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  refreshToken: string;
}

export class GmailClient {
  private oauth2Client: OAuth2Client;
  private gmail: gmail_v1.Gmail;

  constructor(config: GmailConfig) {
    this.oauth2Client = new google.auth.OAuth2(
      config.clientId,
      config.clientSecret,
      config.redirectUri
    );

    this.oauth2Client.setCredentials({
      refresh_token: config.refreshToken
    });

    this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
  }

  /**
   * Get authenticated email address
   */
  async getProfile(): Promise<gmail_v1.Schema$Profile> {
    const response = await this.gmail.users.getProfile({ userId: 'me' });
    return response.data;
  }

  /**
   * Send an email with optional tracking
   */
  async sendEmail(options: {
    to: string;
    subject: string;
    bodyHtml: string;
    bodyText?: string;
    from?: string;
    replyTo?: string;
    headers?: Record<string, string>;
  }): Promise<gmail_v1.Schema$Message> {
    const { to, subject, bodyHtml, bodyText, from, replyTo, headers } = options;

    // Build MIME message
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36)}`;

    let message = [
      `From: ${from || 'me'}`,
      `To: ${to}`,
      `Subject: ${subject}`,
    ];

    if (replyTo) {
      message.push(`Reply-To: ${replyTo}`);
    }

    // Add custom headers
    if (headers) {
      Object.entries(headers).forEach(([key, value]) => {
        message.push(`${key}: ${value}`);
      });
    }

    message.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    message.push('');

    // Text part
    if (bodyText) {
      message.push(`--${boundary}`);
      message.push('Content-Type: text/plain; charset=UTF-8');
      message.push('');
      message.push(bodyText);
      message.push('');
    }

    // HTML part
    message.push(`--${boundary}`);
    message.push('Content-Type: text/html; charset=UTF-8');
    message.push('');
    message.push(bodyHtml);
    message.push('');
    message.push(`--${boundary}--`);

    const rawMessage = message.join('\r\n');
    const encodedMessage = Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const response = await this.gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage
      }
    });

    return response.data;
  }

  /**
   * Get a message by ID
   */
  async getMessage(messageId: string, format: 'full' | 'metadata' | 'minimal' = 'full'): Promise<gmail_v1.Schema$Message> {
    const response = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format
    });

    return response.data;
  }

  /**
   * Get a thread by ID
   */
  async getThread(threadId: string): Promise<gmail_v1.Schema$Thread> {
    const response = await this.gmail.users.threads.get({
      userId: 'me',
      id: threadId
    });

    return response.data;
  }

  /**
   * List messages matching a query
   */
  async listMessages(options: {
    query?: string;
    labelIds?: string[];
    maxResults?: number;
    pageToken?: string;
  }): Promise<{ messages: gmail_v1.Schema$Message[]; nextPageToken?: string }> {
    const response = await this.gmail.users.messages.list({
      userId: 'me',
      q: options.query,
      labelIds: options.labelIds,
      maxResults: options.maxResults || 100,
      pageToken: options.pageToken
    });

    return {
      messages: response.data.messages || [],
      nextPageToken: response.data.nextPageToken || undefined
    };
  }

  /**
   * List threads matching a query
   */
  async listThreads(options: {
    query?: string;
    labelIds?: string[];
    maxResults?: number;
    pageToken?: string;
  }): Promise<{ threads: gmail_v1.Schema$Thread[]; nextPageToken?: string }> {
    const response = await this.gmail.users.threads.list({
      userId: 'me',
      q: options.query,
      labelIds: options.labelIds,
      maxResults: options.maxResults || 100,
      pageToken: options.pageToken
    });

    return {
      threads: response.data.threads || [],
      nextPageToken: response.data.nextPageToken || undefined
    };
  }

  /**
   * Extract headers from a message
   */
  extractHeaders(message: gmail_v1.Schema$Message): Record<string, string> {
    const headers: Record<string, string> = {};

    if (message.payload?.headers) {
      message.payload.headers.forEach(header => {
        if (header.name && header.value) {
          headers[header.name.toLowerCase()] = header.value;
        }
      });
    }

    return headers;
  }

  /**
   * Extract plain text body from a message
   */
  extractTextBody(message: gmail_v1.Schema$Message): string {
    if (!message.payload) return '';

    // Check if it's a simple message (not multipart)
    if (message.payload.body?.data) {
      return this.decodeBase64(message.payload.body.data);
    }

    // Check parts for text/plain
    if (message.payload.parts) {
      for (const part of message.payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return this.decodeBase64(part.body.data);
        }
      }

      // Check nested parts
      for (const part of message.payload.parts) {
        if (part.parts) {
          for (const subpart of part.parts) {
            if (subpart.mimeType === 'text/plain' && subpart.body?.data) {
              return this.decodeBase64(subpart.body.data);
            }
          }
        }
      }
    }

    return '';
  }

  /**
   * Extract HTML body from a message
   */
  extractHtmlBody(message: gmail_v1.Schema$Message): string {
    if (!message.payload) return '';

    // Check parts for text/html
    if (message.payload.parts) {
      for (const part of message.payload.parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          return this.decodeBase64(part.body.data);
        }
      }

      // Check nested parts
      for (const part of message.payload.parts) {
        if (part.parts) {
          for (const subpart of part.parts) {
            if (subpart.mimeType === 'text/html' && subpart.body?.data) {
              return this.decodeBase64(subpart.body.data);
            }
          }
        }
      }
    }

    return '';
  }

  /**
   * Decode base64url-encoded string
   */
  private decodeBase64(data: string): string {
    const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(normalized, 'base64').toString('utf-8');
  }

  /**
   * Refresh access token
   */
  async refreshAccessToken(): Promise<void> {
    await this.oauth2Client.refreshAccessToken();
  }
}

/**
 * Create Gmail client from environment variables
 */
export function createGmailClientFromEnv(): GmailClient {
  const requiredVars = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'];
  const missing = requiredVars.filter(v => !process.env[v]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}\n\nRun: npm run campaign:auth`);
  }

  return new GmailClient({
    clientId: process.env.GMAIL_CLIENT_ID!,
    clientSecret: process.env.GMAIL_CLIENT_SECRET!,
    redirectUri: process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/oauth/callback',
    refreshToken: process.env.GMAIL_REFRESH_TOKEN!
  });
}
