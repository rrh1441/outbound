/**
 * Email Verifier Module
 *
 * Wrapper around EmailListChecker.io API for email verification.
 * Provides both single email and batch verification capabilities.
 */

import { createModuleLogger } from '../../apps/workers/core/logger.js';

const log = createModuleLogger('email-verifier');

const API_BASE_URL = 'https://platform.emaillistchecker.io/api';

export type EmailVerificationStatus = 'valid' | 'invalid' | 'catch_all' | 'unknown';

export interface EmailVerificationResult {
  email: string;
  status: EmailVerificationStatus;
  score?: number;
  details?: {
    deliverable?: boolean;
    catchAllDomain?: boolean;
    freeProvider?: boolean;
    disposable?: boolean;
    role?: boolean;
    spamTrap?: boolean;
  };
}

export class EmailVerifier {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Verify a single email address
   *
   * Uses POST /api/v1/verify endpoint.
   * Cost: ~$0.005 per email
   */
  async verifySingle(email: string): Promise<EmailVerificationResult> {
    try {
      const response = await fetch(`${API_BASE_URL}/v1/verify`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ email }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        log.error({ status: response.status, error: errorText }, 'Email verification API error');
        return { email, status: 'unknown' };
      }

      const data = await response.json();

      if (!data.success || !data.data) {
        log.warn({ email, response: data }, 'Unexpected API response format');
        return { email, status: 'unknown' };
      }

      const result = data.data;

      // Parse result: "deliverable", "undeliverable", "risky", "unknown"
      const status = this.parseStatus(result.result || result.reason || 'unknown');

      return {
        email,
        status,
        score: result.score,
        details: {
          deliverable: result.result === 'deliverable',
          catchAllDomain: result.reason === 'ACCEPT_ALL',
          freeProvider: result.free,
          disposable: result.disposable,
          role: result.role,
          spamTrap: result.spam_trap,
        },
      };
    } catch (error: any) {
      log.error({ err: error, email }, 'Email verification request failed');
      return { email, status: 'unknown' };
    }
  }

  /**
   * Verify multiple emails in a batch
   *
   * This is more efficient for large lists but requires polling for results.
   * Returns a map of email -> result
   */
  async verifyBatch(emails: string[]): Promise<Map<string, EmailVerificationResult>> {
    const results = new Map<string, EmailVerificationResult>();

    if (emails.length === 0) {
      return results;
    }

    // For small batches, use parallel single verification
    if (emails.length <= 10) {
      const promises = emails.map((email) => this.verifySingle(email));
      const verificationResults = await Promise.all(promises);

      for (const result of verificationResults) {
        results.set(result.email, result);
      }

      return results;
    }

    // For larger batches, use bulk upload endpoint
    try {
      // Create CSV content
      const csvContent = emails.join('\n');
      const formData = new FormData();
      formData.append('file', new Blob([csvContent], { type: 'text/csv' }), 'emails.csv');

      // Upload for verification
      const uploadResponse = await fetch(`${API_BASE_URL}/bulk-upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
        },
        body: formData,
      });

      if (!uploadResponse.ok) {
        log.error({ status: uploadResponse.status }, 'Bulk upload failed');
        // Fall back to returning all as unknown
        for (const email of emails) {
          results.set(email, { email, status: 'unknown' });
        }
        return results;
      }

      const uploadData = await uploadResponse.json();
      const listId = uploadData.list_id;

      if (!listId) {
        log.error('No list_id returned from bulk upload');
        for (const email of emails) {
          results.set(email, { email, status: 'unknown' });
        }
        return results;
      }

      // Poll for completion
      const maxWaitMs = 5 * 60 * 1000; // 5 minutes
      const pollIntervalMs = 5000; // 5 seconds
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitMs) {
        const statusResponse = await fetch(`${API_BASE_URL}/bulk-verification/${listId}/progress`, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
          },
        });

        if (statusResponse.ok) {
          const statusData = await statusResponse.json();

          if (statusData.data?.status === 'completed') {
            // Download results
            return await this.downloadBatchResults(listId, emails);
          }

          if (statusData.data?.status === 'failed') {
            log.error('Bulk verification failed');
            break;
          }
        }

        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }

      // Timeout or failure - return unknown for all
      log.warn('Bulk verification timed out or failed');
      for (const email of emails) {
        results.set(email, { email, status: 'unknown' });
      }
      return results;
    } catch (error: any) {
      log.error({ err: error }, 'Batch verification failed');
      for (const email of emails) {
        results.set(email, { email, status: 'unknown' });
      }
      return results;
    }
  }

  /**
   * Download and parse batch verification results
   */
  private async downloadBatchResults(
    listId: number,
    originalEmails: string[]
  ): Promise<Map<string, EmailVerificationResult>> {
    const results = new Map<string, EmailVerificationResult>();

    // Initialize with unknown for all emails
    for (const email of originalEmails) {
      results.set(email.toLowerCase(), { email, status: 'unknown' });
    }

    try {
      const response = await fetch(
        `${API_BASE_URL}/bulk-verification/${listId}/download?format=csv&filter=all`,
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        }
      );

      if (!response.ok) {
        log.error({ status: response.status }, 'Failed to download batch results');
        return results;
      }

      const csvContent = await response.text();
      const lines = csvContent.trim().split('\n');

      if (lines.length < 2) {
        return results;
      }

      // Parse header
      const header = lines[0].toLowerCase().split(',');
      const emailIdx = header.findIndex((h) => h.includes('email'));
      const statusIdx = header.findIndex((h) => h.includes('status') || h.includes('result'));

      if (emailIdx === -1) {
        log.error('Could not find email column in results');
        return results;
      }

      // Parse rows
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
        const email = cols[emailIdx]?.toLowerCase();
        const statusStr = statusIdx >= 0 ? cols[statusIdx]?.toLowerCase() : 'unknown';

        if (email) {
          const status = this.parseStatus(statusStr);
          results.set(email, { email, status });
        }
      }

      return results;
    } catch (error: any) {
      log.error({ err: error }, 'Failed to parse batch results');
      return results;
    }
  }

  /**
   * Parse verification status string to our enum
   *
   * API returns: "deliverable", "undeliverable", "risky", "unknown"
   * With reasons: "VALID", "INVALID", "ACCEPT_ALL", etc.
   */
  private parseStatus(statusStr: string): EmailVerificationStatus {
    const normalized = statusStr.toLowerCase();

    // Result values
    if (normalized === 'deliverable' || normalized === 'valid' || normalized === 'ok') {
      return 'valid';
    }

    if (normalized === 'undeliverable' || normalized === 'invalid' || normalized === 'bad') {
      return 'invalid';
    }

    // Reason values
    if (normalized === 'accept_all' || normalized === 'accept-all' || normalized === 'catch_all' || normalized === 'catch-all' || normalized === 'catchall') {
      return 'catch_all';
    }

    // Risky emails - treat as catch_all (proceed with caution)
    if (normalized === 'risky') {
      return 'catch_all';
    }

    return 'unknown';
  }
}

/**
 * Create email verifier from environment
 */
export function createEmailVerifierFromEnv(): EmailVerifier | null {
  const apiKey = process.env.EMAIL_VERIFIER_API_KEY;

  if (!apiKey) {
    log.warn('EMAIL_VERIFIER_API_KEY not found - email verification disabled');
    return null;
  }

  return new EmailVerifier(apiKey);
}
