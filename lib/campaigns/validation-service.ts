/**
 * Validation Service
 *
 * Two validation gates for the infostealer pipeline:
 *
 * GATE 1: Finding Validation (validateFindings)
 *   - Validates exposed employee emails from LeakCheck
 *   - Runs BEFORE enrichment to avoid wasting credits
 *   - Checks: Are exposed employees still at the company?
 *
 * GATE 2: Contact Validation (validateContact)
 *   - Validates the executive we're reaching out to
 *   - Runs BEFORE outreach to avoid "I quit" responses
 *   - Checks: Is this person still at the company? Is email valid?
 *
 * Order of checks (cost-optimized):
 *   1. Apollo FREE preview - check employment (FREE)
 *   2. EmailListChecker - verify email deliverability (~$0.005)
 *   3. Harvest LinkedIn - additional signal if borderline (~$0.016)
 *
 * Scoring System (0-100):
 * - Apollo confirms person at company: +40 points (FREE)
 * - Email valid: +30 points
 * - Email catch-all: +15 points
 * - Harvest confirms employment: +20 points
 * - Harvest email quality >= 80: +10 points
 *
 * Decision Thresholds:
 * - >= 70: Valid/Fresh (proceed)
 * - 40-69: Stale (deprioritize)
 * - < 40: Invalid (reject)
 */

import { createModuleLogger } from '../../apps/workers/core/logger.js';
import { ApolloClient, createApolloClientFromEnv } from '../../apps/campaigns/core/apollo-client.js';
import { HarvestClient, createHarvestClientFromEnv } from '../../apps/campaigns/core/harvest-client.js';
import { EmailVerifier, createEmailVerifierFromEnv } from './email-verifier.js';

const log = createModuleLogger('validation-service');

// Scoring constants (Apollo first since it's FREE)
const SCORE = {
  // Apollo FREE - check first
  APOLLO_CONFIRMS_COMPANY: 40,
  // EmailListChecker - only if Apollo inconclusive
  EMAIL_VALID: 30,
  EMAIL_CATCH_ALL: 15,
  // Harvest - only for borderline cases
  HARVEST_CONFIRMS_COMPANY: 20,
  HARVEST_EMAIL_QUALITY_HIGH: 10,
};

// Decision thresholds
const THRESHOLD = {
  VALID: 70,
  STALE: 40,
};

export type EmailStatus = 'valid' | 'invalid' | 'catch_all' | 'unknown';
export type EmploymentStatus = 'current' | 'left' | 'unknown';
export type ValidationDecision = 'valid' | 'stale' | 'invalid';

export interface ValidationResult {
  // Email validation
  emailStatus: EmailStatus;
  emailVerifiedAt: Date | null;

  // Employment validation
  employmentStatus: EmploymentStatus;
  employmentVerifiedAt: Date | null;
  apolloCurrentCompany: string | null;
  apolloCurrentTitle: string | null;
  harvestFoundAtCompany: boolean | null;
  harvestEmailQualityScore: number | null;

  // Final decision
  score: number;
  decision: ValidationDecision;
  reasons: string[];
}

export interface ContactToValidate {
  email: string;
  firstName: string;
  lastName: string;
  targetDomain: string;
  targetCompany?: string;
  linkedinUrl?: string;
}

// GATE 1: Finding validation types
export type FindingValidationDecision = 'fresh' | 'stale' | 'invalid';

export interface ExposedEmployee {
  email: string;
  firstName?: string;
  lastName?: string;
}

export interface FindingValidationResult {
  // Summary
  decision: FindingValidationDecision;
  score: number;
  validatedAt: Date;

  // Details
  employeesChecked: number;
  employeesConfirmed: number;  // Still at company
  employeesLeft: number;       // Confirmed left
  employeesUnknown: number;    // Couldn't determine
  emailsValid: number;
  emailsInvalid: number;

  // Reasons for decision
  reasons: string[];
}

export class ValidationService {
  private apolloClient: ApolloClient | null;
  private harvestClient: HarvestClient | null;
  private emailVerifier: EmailVerifier | null;

  constructor(
    apolloClient: ApolloClient | null,
    harvestClient: HarvestClient | null,
    emailVerifier: EmailVerifier | null
  ) {
    this.apolloClient = apolloClient;
    this.harvestClient = harvestClient;
    this.emailVerifier = emailVerifier;
  }

  /**
   * Validate a single contact (GATE 2: Before outreach)
   *
   * Order (cost-optimized):
   * 1. Apollo FREE first - check if person still at company
   * 2. EmailListChecker - verify email (only if Apollo inconclusive)
   * 3. Harvest - additional signal (only for borderline cases)
   */
  async validateContact(contact: ContactToValidate): Promise<ValidationResult> {
    const reasons: string[] = [];
    let score = 0;

    // Initialize result
    const result: ValidationResult = {
      emailStatus: 'unknown',
      emailVerifiedAt: null,
      employmentStatus: 'unknown',
      employmentVerifiedAt: null,
      apolloCurrentCompany: null,
      apolloCurrentTitle: null,
      harvestFoundAtCompany: null,
      harvestEmailQualityScore: null,
      score: 0,
      decision: 'invalid',
      reasons: [],
    };

    log.info({ email: contact.email, domain: contact.targetDomain }, 'Starting contact validation');

    // =========================================================
    // STEP 1: Apollo FREE first (check employment - costs nothing)
    // =========================================================
    const apolloResult = await this.validateEmploymentViaApollo(contact);

    result.apolloCurrentCompany = apolloResult.currentCompany;
    result.apolloCurrentTitle = apolloResult.currentTitle;
    result.employmentVerifiedAt = new Date();

    if (apolloResult.status === 'left') {
      // Immediate rejection - person confirmed at different company
      log.info(
        { email: contact.email, currentCompany: apolloResult.currentCompany },
        'Person at different company - rejecting (FREE check)'
      );
      result.employmentStatus = 'left';
      result.decision = 'invalid';
      result.reasons = [`Person now at ${apolloResult.currentCompany}, not ${contact.targetDomain}`];
      return result;
    }

    if (apolloResult.status === 'current') {
      score += SCORE.APOLLO_CONFIRMS_COMPANY;
      reasons.push(`Apollo confirms employment (+${SCORE.APOLLO_CONFIRMS_COMPANY})`);
      result.employmentStatus = 'current';
    } else {
      result.employmentStatus = 'unknown';
    }

    // =========================================================
    // STEP 2: EmailListChecker (only if Apollo didn't confirm)
    // =========================================================
    // If Apollo confirmed (score >= 40), we might already be valid
    // But we should still verify email to avoid bounces
    const emailResult = await this.verifyEmail(contact.email);

    result.emailStatus = emailResult.status;
    result.emailVerifiedAt = new Date();

    if (emailResult.status === 'invalid') {
      // Email doesn't exist - reject even if Apollo confirmed employment
      log.info({ email: contact.email }, 'Email invalid - rejecting');
      result.decision = 'invalid';
      result.reasons = [...reasons, 'Email is invalid/undeliverable'];
      return result;
    }

    if (emailResult.status === 'valid') {
      score += SCORE.EMAIL_VALID;
      reasons.push(`Email valid (+${SCORE.EMAIL_VALID})`);
    } else if (emailResult.status === 'catch_all') {
      score += SCORE.EMAIL_CATCH_ALL;
      reasons.push(`Email catch-all (+${SCORE.EMAIL_CATCH_ALL})`);
    }

    // =========================================================
    // STEP 3: Harvest (only for borderline cases with LinkedIn URL)
    // =========================================================
    const isBorderline = score >= THRESHOLD.STALE && score < THRESHOLD.VALID;

    if (isBorderline && this.harvestClient && contact.linkedinUrl) {
      log.info({ email: contact.email }, 'Score borderline, checking Harvest');

      const harvestResult = await this.validateEmploymentViaHarvest(contact);

      result.harvestFoundAtCompany = harvestResult.foundAtCompany;
      result.harvestEmailQualityScore = harvestResult.emailQualityScore;

      if (harvestResult.status === 'left') {
        log.info({ email: contact.email }, 'Harvest confirms person left - rejecting');
        result.employmentStatus = 'left';
        result.decision = 'invalid';
        result.reasons = ['LinkedIn shows person at different company'];
        return result;
      }

      if (harvestResult.foundAtCompany) {
        score += SCORE.HARVEST_CONFIRMS_COMPANY;
        reasons.push(`LinkedIn confirms employment (+${SCORE.HARVEST_CONFIRMS_COMPANY})`);
        result.employmentStatus = 'current';
      }

      if (harvestResult.emailQualityScore !== null && harvestResult.emailQualityScore >= 80) {
        score += SCORE.HARVEST_EMAIL_QUALITY_HIGH;
        reasons.push(`Harvest email quality high (+${SCORE.HARVEST_EMAIL_QUALITY_HIGH})`);
      }
    }

    // =========================================================
    // STEP 4: Final decision
    // =========================================================
    result.score = score;
    result.reasons = reasons;

    if (score >= THRESHOLD.VALID) {
      result.decision = 'valid';
      log.info({ email: contact.email, score }, 'Contact validated');
    } else if (score >= THRESHOLD.STALE) {
      result.decision = 'stale';
      log.info({ email: contact.email, score }, 'Contact marked stale');
    } else {
      result.decision = 'invalid';
      log.info({ email: contact.email, score }, 'Contact marked invalid');
    }

    return result;
  }

  /**
   * Validate findings (GATE 1: Before enrichment)
   *
   * Checks exposed employee emails from LeakCheck to determine if
   * the finding is worth enriching.
   *
   * Uses Apollo People Enrichment (1 credit/email) to check if person
   * is still at the target company. Falls back to email verification.
   *
   * Strategy: Check 3 employees at a time. If any left, check 3 more.
   * Stop early if we find someone confirmed. Max 12 total.
   *
   * @param domain - The target company domain
   * @param exposedEmployees - Employee emails from breach findings
   */
  async validateFindings(
    domain: string,
    exposedEmployees: ExposedEmployee[]
  ): Promise<FindingValidationResult> {
    const result: FindingValidationResult = {
      decision: 'invalid',
      score: 0,
      validatedAt: new Date(),
      employeesChecked: 0,
      employeesConfirmed: 0,
      employeesLeft: 0,
      employeesUnknown: 0,
      emailsValid: 0,
      emailsInvalid: 0,
      reasons: [],
    };

    if (exposedEmployees.length === 0) {
      result.reasons.push('No exposed employees to validate');
      return result;
    }

    log.info({ domain, count: exposedEmployees.length }, 'Starting finding validation');

    // Normalize target domain for comparison
    const targetDomain = domain.toLowerCase().replace(/^www\./, '');

    // Strategy: Check in batches of 3, up to 12 total
    // Stop early if we find someone confirmed still there
    const BATCH_SIZE = 3;
    const MAX_TO_CHECK = 12;
    let checkedCount = 0;

    // =========================================================
    // STEP 1: Apollo Enrichment - Check current employment by EMAIL
    // Costs 1 credit per email, but gives definitive answer
    // Check in batches, expand if we find people who left
    // =========================================================
    if (this.apolloClient) {
      while (checkedCount < Math.min(exposedEmployees.length, MAX_TO_CHECK)) {
        const batchStart = checkedCount;
        const batchEnd = Math.min(checkedCount + BATCH_SIZE, exposedEmployees.length, MAX_TO_CHECK);
        const batch = exposedEmployees.slice(batchStart, batchEnd);

        if (batch.length === 0) break;

        log.info({ domain, batchStart, batchEnd, batchSize: batch.length }, 'Checking employee batch');

        for (const employee of batch) {
          checkedCount++;
          result.employeesChecked++;

          try {
            // Enrich by email - Apollo looks up the PERSON and returns their CURRENT company
            const enriched = await this.apolloClient.enrichPerson({
              email: employee.email,
            });

            if (enriched && enriched.organization) {
              // Got a result - check if they're still at the target company
              const currentDomain = this.extractDomainFromOrg(enriched.organization);

              if (currentDomain === targetDomain) {
                // Still at the company! We can stop early.
                result.employeesConfirmed++;
                log.info(
                  { email: employee.email, company: enriched.organization.name },
                  'Employee confirmed still at company'
                );
              } else if (currentDomain) {
                // At a DIFFERENT company now
                result.employeesLeft++;
                log.info(
                  { email: employee.email, oldDomain: targetDomain, newDomain: currentDomain, newCompany: enriched.organization.name },
                  'Employee now at different company'
                );
              } else {
                result.employeesUnknown++;
              }
            } else {
              // Apollo couldn't find this person
              result.employeesUnknown++;
            }
          } catch (error: any) {
            // Check for "not found" vs actual error
            if (error.message?.includes('404') || error.message?.includes('not found')) {
              log.debug({ email: employee.email }, 'Person not in Apollo database');
              result.employeesUnknown++;
            } else {
              log.error({ err: error, email: employee.email }, 'Apollo enrichment failed');
              result.employeesUnknown++;
            }
          }

          // Rate limiting between API calls
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        // Decision: Should we check more?
        // If we found someone confirmed → stop (finding is fresh)
        if (result.employeesConfirmed > 0) {
          log.info({ domain, confirmed: result.employeesConfirmed }, 'Found confirmed employee, stopping early');
          break;
        }

        // If no one left in this batch → stop (no evidence of staleness)
        const batchHadLeavers = result.employeesLeft > (batchStart > 0 ? result.employeesLeft : 0);
        if (!batchHadLeavers && result.employeesLeft === 0) {
          log.info({ domain }, 'No employees left company in batch, stopping');
          break;
        }

        // If people left → continue checking (need more signal)
        if (result.employeesLeft > 0 && checkedCount < MAX_TO_CHECK) {
          log.info({ domain, left: result.employeesLeft }, 'Some employees left, checking more');
        }
      }
    } else {
      result.employeesUnknown = Math.min(exposedEmployees.length, BATCH_SIZE);
      result.employeesChecked = result.employeesUnknown;
      result.reasons.push('Apollo not configured');
    }

    // =========================================================
    // STEP 2: EmailListChecker - Verify emails for unknowns (BULK)
    // If Apollo couldn't find them, email validity is our signal
    // Only run if we have unknowns and no confirmed employees
    // =========================================================
    if (this.emailVerifier && result.employeesUnknown > 0 && result.employeesConfirmed === 0) {
      log.info({ unknowns: result.employeesUnknown }, 'Falling back to bulk email verification for unknowns');

      try {
        // Verify the emails we already checked
        const emailsToVerify = exposedEmployees.slice(0, result.employeesChecked).map((e) => e.email);
        const verificationResults = await this.emailVerifier.verifyBatch(emailsToVerify);

        for (const [, emailResult] of verificationResults) {
          if (emailResult.status === 'valid') {
            result.emailsValid++;
          } else if (emailResult.status === 'invalid') {
            result.emailsInvalid++;
          }
        }
      } catch (error: any) {
        log.error({ err: error }, 'Bulk email verification failed');
      }
    }

    // =========================================================
    // STEP 3: Calculate score and decision
    // =========================================================
    const confirmedRatio = result.employeesConfirmed / result.employeesChecked;
    const leftRatio = result.employeesLeft / result.employeesChecked;
    const validEmailRatio = result.emailsValid / result.employeesChecked;
    const invalidEmailRatio = result.emailsInvalid / result.employeesChecked;

    // Decision logic (in priority order):

    // 1. If most employees confirmed LEFT → finding is STALE
    if (leftRatio >= 0.5) {
      result.score = 20;
      result.decision = 'stale';
      result.reasons.push(`${result.employeesLeft}/${result.employeesChecked} employees confirmed at different companies`);
    }
    // 2. If any employees confirmed STILL THERE → finding is FRESH
    else if (result.employeesConfirmed > 0) {
      result.score = 85;
      result.decision = 'fresh';
      result.reasons.push(`${result.employeesConfirmed}/${result.employeesChecked} employees confirmed still at company`);
    }
    // 3. Apollo couldn't find anyone - use email verification as signal
    // If emails are VALID → probably still there → FRESH
    else if (validEmailRatio > 0.3) {
      result.score = 65;
      result.decision = 'fresh';
      result.reasons.push(`${result.emailsValid}/${result.employeesChecked} emails verified valid (Apollo no data)`);
    }
    // 4. If emails are INVALID → probably left → STALE
    else if (invalidEmailRatio > 0.3) {
      result.score = 25;
      result.decision = 'stale';
      result.reasons.push(`${result.emailsInvalid}/${result.employeesChecked} emails invalid (likely left)`);
    }
    // 5. Some left, none confirmed → leaning STALE
    else if (result.employeesLeft > 0) {
      result.score = 35;
      result.decision = 'stale';
      result.reasons.push(`${result.employeesLeft} left, 0 confirmed at company`);
    }
    // 6. Unknown - can't determine, treat as borderline
    else {
      result.score = 50;
      result.decision = 'stale';
      result.reasons.push('Could not determine employee status (not in Apollo, email check inconclusive)');
    }

    log.info(
      {
        domain,
        score: result.score,
        decision: result.decision,
        confirmed: result.employeesConfirmed,
        left: result.employeesLeft,
        unknown: result.employeesUnknown,
        emailsValid: result.emailsValid,
        emailsInvalid: result.emailsInvalid,
      },
      'Finding validation complete'
    );

    return result;
  }

  /**
   * Extract normalized domain from Apollo organization data
   */
  private extractDomainFromOrg(org: { website_url?: string; primary_domain?: string; name?: string }): string | null {
    // Try primary_domain first (if Apollo returns it)
    if ((org as any).primary_domain) {
      return (org as any).primary_domain.toLowerCase().replace(/^www\./, '');
    }

    // Fall back to parsing website_url
    if (org.website_url) {
      try {
        const url = new URL(org.website_url.startsWith('http') ? org.website_url : `https://${org.website_url}`);
        return url.hostname.toLowerCase().replace(/^www\./, '');
      } catch {
        // Invalid URL, try direct parse
        return org.website_url
          .toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/^www\./, '')
          .split('/')[0];
      }
    }

    return null;
  }

  /**
   * Parse first/last name from email address
   */
  private parseNameFromEmail(
    email: string,
    providedFirst?: string,
    providedLast?: string
  ): { firstName: string; lastName: string } {
    if (providedFirst && providedLast) {
      return { firstName: providedFirst, lastName: providedLast };
    }

    // Try to parse from email local part (e.g., john.smith@company.com)
    const localPart = email.split('@')[0] || '';
    const parts = localPart.split(/[._-]/);

    if (parts.length >= 2) {
      return {
        firstName: providedFirst || parts[0],
        lastName: providedLast || parts[parts.length - 1],
      };
    }

    return {
      firstName: providedFirst || localPart,
      lastName: providedLast || '',
    };
  }

  /**
   * Verify email deliverability via EmailListChecker
   */
  private async verifyEmail(email: string): Promise<{ status: EmailStatus }> {
    if (!this.emailVerifier) {
      log.warn('Email verifier not configured, assuming valid');
      return { status: 'unknown' };
    }

    try {
      const result = await this.emailVerifier.verifySingle(email);
      return { status: result.status };
    } catch (error: any) {
      log.error({ err: error, email }, 'Email verification failed');
      return { status: 'unknown' };
    }
  }

  /**
   * Validate employment via Apollo FREE preview endpoint
   *
   * Uses the new /Mixed_people/api_search endpoint which returns
   * shallow profiles (name, title, company) at no cost.
   */
  private async validateEmploymentViaApollo(
    contact: ContactToValidate
  ): Promise<{
    status: EmploymentStatus;
    currentCompany: string | null;
    currentTitle: string | null;
  }> {
    if (!this.apolloClient) {
      log.warn('Apollo client not configured');
      return { status: 'unknown', currentCompany: null, currentTitle: null };
    }

    try {
      // Use the FREE /Mixed_people/api_search endpoint
      // Search by name and expected company
      const result = await this.apolloClient.searchPeople({
        q_organization_domains_list: [contact.targetDomain],
        per_page: 10,
        page: 1,
      });

      if (!result.people || result.people.length === 0) {
        // No results - can't confirm or deny
        return { status: 'unknown', currentCompany: null, currentTitle: null };
      }

      // Look for a match by name
      const targetFirstName = contact.firstName.toLowerCase();
      const targetLastName = contact.lastName.toLowerCase();

      const match = result.people.find((person) => {
        const firstName = (person.first_name || '').toLowerCase();
        const lastName = (person.last_name || '').toLowerCase();
        return firstName === targetFirstName && lastName === targetLastName;
      });

      if (match) {
        // Found the person at the target company
        const currentCompany = match.organization?.name || null;
        const currentTitle = match.title || null;

        return {
          status: 'current',
          currentCompany,
          currentTitle,
        };
      }

      // Person not found at target company - try searching by name directly
      // This could indicate they've left
      try {
        // Search for the person by name (without domain filter)
        // This uses the same FREE endpoint
        const nameSearch = await this.apolloClient.searchPeople({
          per_page: 5,
          page: 1,
        });

        // Check if any result matches the name
        const personByName = nameSearch.people?.find((person) => {
          const firstName = (person.first_name || '').toLowerCase();
          const lastName = (person.last_name || '').toLowerCase();
          return firstName === targetFirstName && lastName === targetLastName;
        });

        if (personByName && personByName.organization) {
          // Found person at a DIFFERENT company
          const currentDomain = personByName.organization.website_url
            ?.replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .split('/')[0];

          if (currentDomain && currentDomain !== contact.targetDomain) {
            return {
              status: 'left',
              currentCompany: personByName.organization.name || currentDomain,
              currentTitle: personByName.title || null,
            };
          }
        }
      } catch {
        // Name search failed, continue with unknown
      }

      return { status: 'unknown', currentCompany: null, currentTitle: null };
    } catch (error: any) {
      log.error({ err: error, email: contact.email }, 'Apollo validation failed');
      return { status: 'unknown', currentCompany: null, currentTitle: null };
    }
  }

  /**
   * Validate employment via Harvest LinkedIn lookup
   *
   * Uses LinkedIn profile to check if person still shows target company.
   */
  private async validateEmploymentViaHarvest(
    contact: ContactToValidate
  ): Promise<{
    status: EmploymentStatus;
    foundAtCompany: boolean;
    emailQualityScore: number | null;
    emailDeliverable: boolean | null;
    profileHidden: boolean;
  }> {
    if (!this.harvestClient) {
      return {
        status: 'unknown',
        foundAtCompany: false,
        emailQualityScore: null,
        emailDeliverable: null,
        profileHidden: false,
      };
    }

    try {
      let profile;

      if (contact.linkedinUrl) {
        // Fetch profile directly using LinkedIn URL
        profile = await this.harvestClient.getProfile({
          url: contact.linkedinUrl,
          findEmail: true,
          skipSmtp: true, // Skip SMTP for speed
          main: true, // Condensed profile
        });
      } else {
        // Search by name + company
        const searchResult = await this.harvestClient.searchProfiles({
          firstName: contact.firstName,
          lastName: contact.lastName,
          currentCompany: contact.targetCompany || contact.targetDomain.split('.')[0],
        });

        if (searchResult.elements && searchResult.elements.length > 0) {
          const match = searchResult.elements[0];

          if (match.hidden) {
            return {
              status: 'unknown',
              foundAtCompany: false,
              emailQualityScore: null,
              emailDeliverable: null,
              profileHidden: true,
            };
          }

          // Get full profile
          profile = await this.harvestClient.getProfile({
            publicIdentifier: match.publicIdentifier,
            findEmail: true,
            skipSmtp: true,
            main: true,
          });
        }
      }

      if (!profile) {
        return {
          status: 'unknown',
          foundAtCompany: false,
          emailQualityScore: null,
          emailDeliverable: null,
          profileHidden: false,
        };
      }

      // Check headline for company match
      const headline = (profile.headline || '').toLowerCase();
      const targetCompanyLower = (contact.targetCompany || contact.targetDomain.split('.')[0]).toLowerCase();
      const foundAtCompany = headline.includes(targetCompanyLower);

      // Check if headline shows a DIFFERENT company
      // This is a heuristic - headline usually shows "Title at Company"
      const headlineHasCompany = headline.includes(' at ') || headline.includes('@');
      const showsDifferentCompany = headlineHasCompany && !foundAtCompany;

      // Extract email quality if available
      let emailQualityScore: number | null = null;
      let emailDeliverable: boolean | null = null;

      if (profile.emails && profile.emails.length > 0) {
        const bestEmail = profile.emails[0];
        emailQualityScore = bestEmail.qualityScore;
        emailDeliverable = bestEmail.deliverable;
      }

      return {
        status: showsDifferentCompany ? 'left' : foundAtCompany ? 'current' : 'unknown',
        foundAtCompany,
        emailQualityScore,
        emailDeliverable,
        profileHidden: false,
      };
    } catch (error: any) {
      log.error({ err: error, email: contact.email }, 'Harvest validation failed');
      return {
        status: 'unknown',
        foundAtCompany: false,
        emailQualityScore: null,
        emailDeliverable: null,
        profileHidden: false,
      };
    }
  }
}

/**
 * Create validation service from environment
 */
export function createValidationServiceFromEnv(): ValidationService {
  let apolloClient: ApolloClient | null = null;
  let harvestClient: HarvestClient | null = null;
  let emailVerifier: EmailVerifier | null = null;

  try {
    apolloClient = createApolloClientFromEnv();
  } catch {
    log.warn('Apollo client not available');
  }

  harvestClient = createHarvestClientFromEnv();
  emailVerifier = createEmailVerifierFromEnv();

  return new ValidationService(apolloClient, harvestClient, emailVerifier);
}
