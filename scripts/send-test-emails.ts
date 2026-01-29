import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import 'dotenv/config';
import { getPool } from '../lib/database.js';

const pool = getPool();

function decryptCredentials(encrypted: string, iv: string, tag: string): any {
  const key = Buffer.from(process.env.SENDER_ENCRYPTION_KEY!, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

async function sendTestEmails() {
  const result = await pool.query('SELECT * FROM sender_accounts ORDER BY email');
  const accounts = result.rows;

  console.log(`Sending test emails from ${accounts.length} accounts to ryanrheger@gmail.com\n`);

  let success = 0;
  let failed = 0;

  for (const account of accounts) {
    try {
      const credentials = decryptCredentials(
        account.credentials_encrypted,
        account.credentials_iv,
        account.credentials_tag
      );

      const timestamp = new Date().toISOString();
      const subject = `Test from ${account.email}`;
      const bodyHtml = `<p>This is a test email from <strong>${account.email}</strong> sent at ${timestamp}</p>`;
      const bodyText = `This is a test email from ${account.email} sent at ${timestamp}`;

      if (account.provider === 'gmail' && account.auth_type === 'oauth') {
        // Gmail API
        const oauth2Client = new google.auth.OAuth2(
          process.env.GMAIL_CLIENT_ID,
          process.env.GMAIL_CLIENT_SECRET,
          process.env.GMAIL_REDIRECT_URI
        );
        oauth2Client.setCredentials({ refresh_token: credentials.refresh_token });
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        const boundary = `boundary_${Date.now()}`;
        const message = [
          `From: ${account.email}`,
          `To: ryanrheger@gmail.com`,
          `Subject: ${subject}`,
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          '',
          `--${boundary}`,
          'Content-Type: text/plain; charset=UTF-8',
          '',
          bodyText,
          '',
          `--${boundary}`,
          'Content-Type: text/html; charset=UTF-8',
          '',
          bodyHtml,
          '',
          `--${boundary}--`
        ].join('\r\n');

        const rawMessage = Buffer.from(message)
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');

        await gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw: rawMessage }
        });
      } else {
        // SMTP for Microsoft
        const transporter = nodemailer.createTransport({
          host: account.smtp_host || 'smtp.office365.com',
          port: account.smtp_port || 587,
          secure: false,
          auth: { user: account.email, pass: credentials.password },
          tls: { ciphers: 'SSLv3', rejectUnauthorized: false }
        });

        await transporter.sendMail({
          from: account.email,
          to: 'ryanrheger@gmail.com',
          subject,
          text: bodyText,
          html: bodyHtml
        });
      }

      console.log(`✓ ${account.email}`);
      success++;
    } catch (err: any) {
      console.log(`✗ ${account.email}: ${err.message}`);
      failed++;
    }

    // Small delay between sends
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nDone: ${success} sent, ${failed} failed`);
  await pool.end();
}

sendTestEmails().catch(console.error);
