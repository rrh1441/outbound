/**
 * Shared email utilities for campaign loaders
 *
 * Centralizes email validation and extraction logic used across
 * infostealer, wordpress, and github_secrets campaign loaders.
 */

import type { ApolloPerson } from '../../apps/campaigns/core/apollo-client.js';

// Campaign type enum - single source of truth
export const CAMPAIGN_TYPES = ['infostealer_credentials', 'wordpress', 'github_secrets'] as const;
export type CampaignType = (typeof CAMPAIGN_TYPES)[number];

/**
 * Check if an email is a placeholder that Apollo hasn't unlocked
 */
export function isPlaceholderEmail(email: string | undefined): boolean {
  return !email || email.includes('not_unlocked') || email.includes('@domain.com');
}

/**
 * Extract the best real email from an Apollo person record
 * Prefers work email, falls back to personal emails
 */
export function getRealEmail(person: ApolloPerson | null): string | null {
  if (!person) return null;

  // Try work email first
  if (person.email && !isPlaceholderEmail(person.email)) {
    return person.email;
  }

  // Fall back to personal emails
  if (person.personal_emails && person.personal_emails.length > 0) {
    const realPersonal = person.personal_emails.find((e) => !isPlaceholderEmail(e));
    if (realPersonal) return realPersonal;
  }

  return null;
}

/**
 * Escape HTML special characters for safe inclusion in email templates
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
