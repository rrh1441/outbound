/**
 * Harvest API Client
 *
 * Integration with Harvest API for LinkedIn profile enrichment and email finding.
 * Used as a fallback when Apollo returns LinkedIn URL but no email.
 */

import axios from 'axios';
import { getPool } from '../../../lib/database.js';

async function logHarvestApiCall(
  domain: string | null,
  endpoint: string,
  success: boolean,
  profilesFound: number = 0,
  errorMessage: string | null = null
): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO harvest_api_calls (domain, endpoint, success, profiles_found, error_message)
       VALUES ($1, $2, $3, $4, $5)`,
      [domain, endpoint, success, profilesFound, errorMessage]
    );
  } catch (err) {
    // Don't fail the operation if logging fails
    console.error('Failed to log Harvest API call:', err);
  }
}

export interface HarvestProfileSearchParams {
  search?: string;
  firstName?: string;
  lastName?: string;
  currentCompany?: string;
  pastCompany?: string;
  title?: string;
  location?: string;
  geoId?: string;
  page?: number;
}

export interface HarvestProfileShort {
  id: string;
  publicIdentifier: string;
  name: string;
  position?: string;
  location?: string;
  linkedinUrl: string;
  photo?: string;
  hidden?: boolean;
}

export interface HarvestProfileSearchResponse {
  elements: HarvestProfileShort[];
  pagination: {
    totalPages: number;
    totalElements: number;
    pageNumber: number;
    pageSize: number;
    paginationToken?: string;
  };
  status: string;
  error?: string;
  query: any;
}

export interface HarvestProfileGetParams {
  url?: string;
  publicIdentifier?: string;
  profileId?: string;
  findEmail?: boolean;
  skipSmtp?: boolean;
  main?: boolean;
}

export interface HarvestEmailEntry {
  email: string;
  deliverable: boolean;
  catchAllDomain: boolean;
  validEmailServer: boolean;
  free: boolean;
  status: 'valid' | 'invalid' | 'risky' | 'catch_all';
  qualityScore: number;
}

export interface HarvestProfile {
  publicIdentifier: string;
  firstName: string;
  lastName: string;
  headline?: string;
  summary?: string;
  location?: string;
  email?: string;  // Legacy field, use emails[] instead
  emails?: HarvestEmailEntry[];  // Array of emails with status
  emailStatus?: 'verified' | 'catch_all' | 'risky' | 'invalid';
  experience?: any[];
  education?: any[];
  skills?: any[];
  verified?: boolean;
  linkedinUrl?: string;
}

export interface HarvestProfileGetResponse {
  element: HarvestProfile;
  status: string;
  error?: string;
  query: any;
}

export class HarvestClient {
  private apiKey: string;
  private baseUrl = 'https://api.harvest-api.com';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Search for LinkedIn profiles by various criteria
   */
  async searchProfiles(params: HarvestProfileSearchParams): Promise<HarvestProfileSearchResponse> {
    const domain = params.currentCompany || null;

    try {
      const response = await axios.get(
        `${this.baseUrl}/linkedin/profile-search`,
        {
          headers: {
            'X-API-Key': this.apiKey
          },
          params,
          timeout: 30000
        }
      );

      const profilesFound = response.data?.elements?.length || 0;
      await logHarvestApiCall(domain, 'profile-search', true, profilesFound, null);

      return response.data;
    } catch (error: any) {
      const errorMsg = error.response
        ? `${error.response.status} - ${JSON.stringify(error.response.data)}`
        : error.message;

      await logHarvestApiCall(domain, 'profile-search', false, 0, errorMsg);

      if (error.response) {
        throw new Error(`Harvest API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  /**
   * Get full LinkedIn profile with optional email finding
   *
   * @param params Profile identification (url, publicIdentifier, or profileId) + options
   * @param params.findEmail - Find email address (costs more credits, SMTP verified)
   * @param params.skipSmtp - Skip SMTP verification (faster, cheaper, less reliable)
   * @param params.main - Get condensed profile (cheaper, fewer credits)
   */
  async getProfile(params: HarvestProfileGetParams, contextDomain?: string): Promise<HarvestProfile | null> {
    // Try to extract domain from URL if present, or use context domain
    let domain: string | null = contextDomain || null;
    if (params.url) {
      try {
        const url = new URL(params.url);
        domain = url.hostname.replace('www.', '');
      } catch {
        // Not a valid URL, skip domain extraction
      }
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/linkedin/profile`,
        {
          headers: {
            'X-API-Key': this.apiKey
          },
          params,
          timeout: 30000
        }
      );

      // Harvest API returns { element: {...}, status: "ok" } or { element: null, status: "error" }
      if (response.data && response.data.element) {
        await logHarvestApiCall(domain, 'profile', true, 1, null);
        return response.data.element;
      }

      // No element returned (e.g., hidden profile, invalid identifier)
      await logHarvestApiCall(domain, 'profile', false, 0, 'No profile element returned');
      return null;
    } catch (error: any) {
      const errorMsg = error.response
        ? `${error.response.status} - ${JSON.stringify(error.response.data)}`
        : error.message;

      await logHarvestApiCall(domain, 'profile', false, 0, errorMsg);

      if (error.response) {
        throw new Error(`Harvest API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  /**
   * Find email for a LinkedIn profile URL
   * Uses skipSmtp by default for speed/cost, but optionally does full SMTP verification
   */
  async findEmailForLinkedInUrl(linkedinUrl: string, verifySmtp: boolean = false): Promise<string | null> {
    try {
      const profile = await this.getProfile({
        url: linkedinUrl,
        findEmail: true,
        skipSmtp: !verifySmtp, // Skip SMTP unless explicitly requested
        main: true // Get condensed profile to save credits
      });

      if (!profile) {
        return null;
      }

      // Extract email from emails array (new format)
      if (profile.emails && profile.emails.length > 0) {
        // Prioritize valid emails
        const validEmail = profile.emails.find(e => e.status === 'valid');
        if (validEmail) {
          return validEmail.email;
        }

        // Fall back to first email if no valid one
        const firstEmail = profile.emails[0];
        if (firstEmail.status === 'invalid') {
          console.log(`   ❌ Email found but marked invalid: ${firstEmail.email}`);
          return null;
        }

        if (firstEmail.status === 'catch_all' || firstEmail.status === 'risky') {
          console.log(`   ⚠️  Email found but marked as ${firstEmail.status}: ${firstEmail.email}`);
        }

        return firstEmail.email;
      }

      // Fallback to legacy email field
      if (profile.email) {
        return profile.email;
      }

      return null;
    } catch (error: any) {
      console.error(`   ⚠️  Harvest email lookup failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Search for a person at a company and find their email
   * Useful when we know name + company but don't have LinkedIn URL
   */
  async findPersonAtCompany(
    firstName: string,
    lastName: string,
    companyName: string,
    title?: string
  ): Promise<{ linkedinUrl: string; email: string | null } | null> {
    try {
      // Search for the person
      const searchResults = await this.searchProfiles({
        firstName,
        lastName,
        currentCompany: companyName,
        title,
        page: 1
      });

      if (!searchResults.elements || searchResults.elements.length === 0) {
        return null;
      }

      // Get the first match
      const match = searchResults.elements[0];

      // Try to find email for this profile
      const email = await this.findEmailForLinkedInUrl(match.linkedinUrl);

      return {
        linkedinUrl: match.linkedinUrl,
        email
      };
    } catch (error: any) {
      console.error(`   ⚠️  Harvest person search failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Find executives at a company using Harvest
   * Returns top executives with emails, prioritized by title
   */
  async findExecutivesAtCompany(
    companyDomain: string,
    titles?: string[]
  ): Promise<Array<{ name: string; title: string; email: string; linkedinUrl: string }>> {
    try {
      const executives: Array<{ name: string; title: string; email: string; linkedinUrl: string }> = [];

      // Search for executives at this company
      // Use company name from domain (remove .com, .io, etc and capitalize)
      const companyName = companyDomain.split('.')[0];
      const titleFilter = titles?.join(' OR ');

      const searchResults = await this.searchProfiles({
        currentCompany: companyName,
        title: titleFilter,
        page: 1
      });

      if (!searchResults.elements || searchResults.elements.length === 0) {
        return [];
      }

      // Try to get emails for top results (max 5 to avoid burning too many credits)
      const maxTries = Math.min(5, searchResults.elements.length);

      for (let i = 0; i < maxTries; i++) {
        const profileShort = searchResults.elements[i];

        // Skip hidden profiles
        if (profileShort.hidden || !profileShort.publicIdentifier) {
          continue;
        }

        // Get full profile with email using publicIdentifier
        try {
          const fullProfile = await this.getProfile({
            publicIdentifier: profileShort.publicIdentifier,
            profileId: profileShort.id,
            findEmail: true,
            skipSmtp: false, // Do SMTP verification for quality
            main: true // Condensed profile to save credits
          }, companyDomain); // Pass domain for tracking

          if (!fullProfile) {
            continue;
          }

          // Extract email from emails array
          let email: string | null = null;
          if (fullProfile.emails && fullProfile.emails.length > 0) {
            const validEmail = fullProfile.emails.find(e => e.status === 'valid');
            email = validEmail?.email || fullProfile.emails[0].email;
          } else if (fullProfile.email) {
            email = fullProfile.email;
          }

          if (email) {
            const linkedinUrl = fullProfile.linkedinUrl || `https://www.linkedin.com/in/${profileShort.publicIdentifier}`;
            executives.push({
              name: fullProfile.firstName + ' ' + fullProfile.lastName,
              title: fullProfile.headline || profileShort.position || 'Unknown',
              email,
              linkedinUrl
            });

            // If we found someone, we're done
            break;
          }
        } catch (profileError: any) {
          console.log(`   ⚠️  Failed to get profile for ${profileShort.name}: ${profileError.message}`);
          continue;
        }
      }

      return executives;
    } catch (error: any) {
      console.error(`   ⚠️  Harvest executive search failed: ${error.message}`);
      return [];
    }
  }
}

/**
 * Create Harvest client from environment
 */
export function createHarvestClientFromEnv(): HarvestClient | null {
  const apiKey = process.env.HARVEST_API_KEY;

  if (!apiKey) {
    console.warn('HARVEST_API_KEY not found in environment variables - LinkedIn fallback disabled');
    return null;
  }

  return new HarvestClient(apiKey);
}
