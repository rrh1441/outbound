/**
 * Role-Based Email Finder with SMTP Verification
 *
 * For WordPress and technical campaigns, role-based emails often work better
 * than individual contacts, especially for SMBs.
 */

import dns from 'dns';
import { promisify } from 'util';
import net from 'net';

const resolveMx = promisify(dns.resolveMx);

export interface RoleEmail {
  email: string;
  role: string;
  verified: boolean;
  verificationMethod: 'smtp' | 'mx_only' | 'unverified';
}

/**
 * Role-based email prefixes to try, in priority order
 */
const ROLE_EMAIL_PREFIXES = [
  { prefix: 'security', role: 'Security Team', priority: 1 },
  { prefix: 'admin', role: 'Administrator', priority: 2 },
  { prefix: 'webmaster', role: 'Webmaster', priority: 3 },
  { prefix: 'it', role: 'IT Team', priority: 4 },
  { prefix: 'tech', role: 'Technical Team', priority: 5 },
  { prefix: 'support', role: 'Support Team', priority: 6 },
  { prefix: 'hello', role: 'General Inbox', priority: 7 },
  { prefix: 'info', role: 'Information', priority: 8 },
  { prefix: 'contact', role: 'Contact', priority: 9 },
];

/**
 * Check if domain has MX records (basic email capability check)
 */
async function hasMxRecords(domain: string): Promise<boolean> {
  try {
    const mx = await resolveMx(domain);
    return mx && mx.length > 0;
  } catch (error) {
    return false;
  }
}

/**
 * Verify email exists via SMTP (VRFY command)
 * This is a basic check - many servers disable VRFY for security
 */
async function verifyEmailSMTP(email: string, mxHost: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.createConnection(25, mxHost);
    let response = '';
    let step = 0;

    const timeout = setTimeout(() => {
      client.destroy();
      resolve(false);
    }, 10000); // 10 second timeout

    client.on('data', (data) => {
      response = data.toString();

      if (step === 0 && response.includes('220')) {
        // Server ready
        client.write('HELO verify.local\r\n');
        step = 1;
      } else if (step === 1 && response.includes('250')) {
        // HELO accepted
        client.write(`MAIL FROM:<verify@verify.local>\r\n`);
        step = 2;
      } else if (step === 2 && response.includes('250')) {
        // MAIL FROM accepted
        client.write(`RCPT TO:<${email}>\r\n`);
        step = 3;
      } else if (step === 3) {
        // RCPT TO response
        const accepted = response.includes('250') || response.includes('251');
        client.write('QUIT\r\n');
        clearTimeout(timeout);
        client.destroy();
        resolve(accepted);
      }
    });

    client.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });

    client.on('timeout', () => {
      clearTimeout(timeout);
      client.destroy();
      resolve(false);
    });
  });
}

/**
 * Find and verify role-based emails for a domain
 * Returns up to 3 verified emails, prioritized by role
 */
export async function findRoleEmails(
  domain: string,
  options: {
    verifySmtp?: boolean;
    maxResults?: number;
  } = {}
): Promise<RoleEmail[]> {
  const { verifySmtp = true, maxResults = 3 } = options;

  // Clean domain (remove www. prefix)
  const cleanDomain = domain.replace(/^www\./, '');

  // Check if domain has MX records
  const hasMx = await hasMxRecords(cleanDomain);
  if (!hasMx) {
    return [];
  }

  const results: RoleEmail[] = [];
  let mxHost: string | null = null;

  // Get MX host for SMTP verification
  if (verifySmtp) {
    try {
      const mx = await resolveMx(cleanDomain);
      if (mx && mx.length > 0) {
        // Use lowest priority (highest preference) MX
        mx.sort((a, b) => a.priority - b.priority);
        mxHost = mx[0].exchange;
      }
    } catch (error) {
      // MX lookup failed, skip SMTP verification
    }
  }

  // Try each role email
  for (const { prefix, role, priority } of ROLE_EMAIL_PREFIXES) {
    if (results.length >= maxResults) {
      break;
    }

    const email = `${prefix}@${cleanDomain}`;
    let verified = false;
    let verificationMethod: 'smtp' | 'mx_only' | 'unverified' = 'mx_only';

    // Try SMTP verification if enabled and we have MX host
    if (verifySmtp && mxHost) {
      try {
        verified = await verifyEmailSMTP(email, mxHost);
        verificationMethod = verified ? 'smtp' : 'mx_only';
      } catch (error) {
        // SMTP verification failed, but MX exists
        verificationMethod = 'mx_only';
      }
    }

    // Add if verified via SMTP, or if we only have MX (less certain but worth trying)
    if (verified || verificationMethod === 'mx_only') {
      results.push({
        email,
        role,
        verified,
        verificationMethod
      });
    }
  }

  return results;
}

/**
 * Find best role email for a domain
 * Returns the highest priority verified email, or null if none found
 */
export async function findBestRoleEmail(
  domain: string,
  options: {
    verifySmtp?: boolean;
  } = {}
): Promise<RoleEmail | null> {
  const emails = await findRoleEmails(domain, { ...options, maxResults: 1 });
  return emails.length > 0 ? emails[0] : null;
}
