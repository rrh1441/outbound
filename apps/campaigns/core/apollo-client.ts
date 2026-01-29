/**
 * Apollo.io API Client
 *
 * Integration with Apollo's People Search API for finding executive contacts.
 */

import axios from 'axios';

export interface ApolloSearchParams {
  q_keywords?: string;  // Free text search (use for name search)
  q_organization_domains_list?: string[];
  person_titles?: string[];
  person_seniorities?: string[];
  include_similar_titles?: boolean;
  contact_email_status?: string[];
  per_page?: number;
  page?: number;
}

export interface ApolloOrganization {
  id: string;
  name: string;
  website_url: string;
  estimated_num_employees?: number;
  annual_revenue?: number;           // In dollars
  annual_revenue_printed?: string;   // e.g., "$10M - $50M"
  industry?: string;
}

export interface ApolloPerson {
  id: string;
  first_name: string;
  last_name: string;
  name: string;
  title: string;
  email: string | null;
  personal_emails?: string[];
  linkedin_url: string | null;
  organization?: ApolloOrganization;
}

export interface ApolloEnrichParams {
  id?: string;
  first_name?: string;
  last_name?: string;
  organization_name?: string;
  domain?: string;
  email?: string;
  reveal_personal_emails?: boolean;
  reveal_phone_number?: boolean;
}

export interface ApolloSearchResponse {
  people: ApolloPerson[];
  pagination: {
    page: number;
    per_page: number;
    total_entries: number;
    total_pages: number;
  };
}

export class ApolloClient {
  private apiKey: string;
  private baseUrl = 'https://api.apollo.io/api/v1';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Search for people by company domain and filters
   */
  async searchPeople(params: ApolloSearchParams): Promise<ApolloSearchResponse> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/mixed_people/api_search`,
        params,
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': this.apiKey
          },
          timeout: 30000
        }
      );

      return response.data;
    } catch (error: any) {
      if (error.response) {
        throw new Error(`Apollo API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  /**
   * Enrich person data to get full contact details (name, email, phone)
   * This endpoint costs credits but returns actual email addresses
   */
  async enrichPerson(params: ApolloEnrichParams): Promise<ApolloPerson> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/people/enrich`,
        params,
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': this.apiKey
          },
          timeout: 30000
        }
      );

      return response.data.person;
    } catch (error: any) {
      if (error.response) {
        throw new Error(`Apollo Enrich API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  /**
   * Look up company/organization by domain
   * Returns company info including estimated revenue
   * This is a FREE endpoint - doesn't cost credits
   */
  async getOrganization(domain: string): Promise<ApolloOrganization | null> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/organizations/enrich`,
        { domain },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': this.apiKey
          },
          timeout: 15000
        }
      );

      return response.data.organization || null;
    } catch (error: any) {
      // Don't throw - just return null if company not found
      if (error.response?.status === 404) {
        return null;
      }
      console.error(`  ⚠️  Org lookup error: ${error.message}`);
      return null;
    }
  }

  /**
   * Find best executive contact for a company domain with full enrichment
   * Prioritizes: CISO > CTO > VP Security/IT > VP Engineering > Head of Engineering > COO > CFO > CSO > CEO > General Counsel > President > Founder > Owner > Lead Engineer
   * Continues searching until a contact with an email is found
   * Uses enrichment API to get actual email addresses (costs credits)
   *
   * OPTIMIZED: Uses single batch search instead of 11 separate calls
   */
  async findExecutiveContact(domain: string, enrichEmail: boolean = true): Promise<ApolloPerson | null> {
    // STRICT title priority - only people who own security decisions
    // Lower index = higher priority
    const titlePriority = [
      // Tier 1: Security Leadership (BEST - they own security)
      'ciso', 'chief information security officer', 'chief info security officer',
      'information security officer', 'infosec officer',
      'vp security', 'vp of security', 'vice president security', 'vice president of security',
      'vp infosec', 'vp of infosec', 'vp information security', 'vp of information security',
      'director of security', 'security director', 'director security',
      'director of infosec', 'infosec director', 'director of information security', 'information security director',
      'head of security', 'head of infosec', 'head of information security',
      'security lead', 'infosec lead', 'information security lead',

      // Tier 2: IT Leadership (good - security often reports to them)
      'vp it', 'vp of it', 'vice president it', 'vp information technology',
      'it director', 'director of it', 'director of information technology',
      'head of it', 'head of infrastructure',

      // Tier 3: Technology Leadership (solid fallback)
      'cto', 'chief technology officer', 'chief technical officer',
      'vp engineering', 'vp of engineering', 'vice president engineering',
      'director of engineering', 'engineering director', 'head of engineering',

      // Tier 4: Operations (may own IT/security at smaller companies)
      'coo', 'chief operating officer',

      // Tier 5: Executive (ONLY for small companies, will likely delegate)
      'ceo', 'chief executive officer',
      'founder', 'co-founder',
      'owner',
    ];

    // REJECT these titles entirely - they don't own security decisions
    const rejectTitles = [
      // HR/People/Talent
      'recruiter', 'recruiting', 'recruitment', 'talent acquisition', 'talent partner', 'talent director', 'of talent', 'talent strategy',
      'hr ', 'human resources', 'people operations', 'people partner', 'people success', 'people experience', 'people and culture', 'of people', 'people &',
      'learning officer', 'chief learning', ' clo ',
      // Sales/Business Development/Partnerships
      'sales', 'account executive', 'business development', 'bdr', 'sdr', 'revenue officer', ' cro',
      'partnerships', 'partner director', 'alliances', 'alliance ', ' bd ', 'head of bd',
      'growth', 'gtm', 'go to market', 'commercial', 'corporate development',
      'client solutions', 'customer solutions', 'business director', 'chief business officer',
      // Marketing/Brand/Creative
      'marketing', 'content', 'social media', 'communications', 'brand',
      'animation', 'creative director', 'design director', 'product design',
      // Customer-facing
      'customer success', 'customer support', 'account manager',
      // Finance
      'finance', 'accountant', 'controller', 'bookkeeper',
      // Legal
      'legal', 'counsel', 'paralegal', 'compliance',
      // Admin/Support
      'admin', 'assistant', 'coordinator', 'specialist',
      'intern', 'trainee', 'junior',
      // Other non-security
      'staffing', 'fulfillment',
    ];

    // Helper to check if title should be rejected
    const shouldReject = (title: string): boolean => {
      const normalized = title.toLowerCase();
      return rejectTitles.some(reject => normalized.includes(reject));
    };

    try {
      // Single API call - only get c_suite, vp, head, director (not manager - too broad)
      const result = await this.searchPeople({
        q_organization_domains_list: [domain],
        person_seniorities: ['c_suite', 'founder', 'owner', 'vp', 'head', 'director'],
        contact_email_status: ['verified', 'guessed'],
        per_page: 25,
        page: 1
      });

      if (!result.people || result.people.length === 0) {
        return null;
      }

      // Helper function to get priority score (lower = better)
      const getPriorityScore = (title: string): number => {
        const normalizedTitle = title.toLowerCase();
        for (let i = 0; i < titlePriority.length; i++) {
          if (normalizedTitle.includes(titlePriority[i])) {
            return i;
          }
        }
        return 9999; // No match
      };

      // Filter out rejected titles, then sort by priority
      const filteredPeople = result.people.filter(person => {
        if (!person.title) return false;
        if (shouldReject(person.title)) {
          console.log(`   ❌ Rejecting ${person.title} (not security-relevant)`);
          return false;
        }
        return true;
      });

      if (filteredPeople.length === 0) {
        console.log(`   ⚠️  No valid contacts found for ${domain} after filtering`);
        return null;
      }

      const sortedPeople = filteredPeople.sort((a, b) => {
        return getPriorityScore(a.title) - getPriorityScore(b.title);
      });

      // Try to find someone with an email, in priority order
      for (const person of sortedPeople) {
        let candidatePerson = person;

        // Check if person already has email from free search
        const hasEmailFromSearch = person.email ||
                                   (person.personal_emails && person.personal_emails.length > 0);

        // Only enrich if we don't have an email yet (saves credits!)
        if (enrichEmail && !hasEmailFromSearch && person.id) {
          try {
            console.log(`   🔄 Enriching ${person.name || person.title}...`);
            const enriched = await this.enrichPerson({
              id: person.id,
              reveal_personal_emails: true
            });
            candidatePerson = enriched;
            console.log(`   ✅ Enrichment successful`);
          } catch (enrichError: any) {
            console.error(`  ⚠️  Enrichment failed: ${enrichError.message}`);
            // Fall back to search result
          }
        } else if (hasEmailFromSearch) {
          console.log(`   💰 Using email from free search (saved enrichment credit)`);
        } else if (enrichEmail && !person.id) {
          console.log(`   ⚠️  No person.id for ${person.title}, can't enrich`);
        }

        // Check if we have an email
        const hasEmail = candidatePerson.email ||
                        (candidatePerson.personal_emails && candidatePerson.personal_emails.length > 0);

        if (hasEmail) {
          return candidatePerson;
        }
      }

      // No one had an email
      return null;
    } catch (error: any) {
      // Re-throw rate limit errors so caller can handle them
      if (error.message?.includes('429') || error.message?.includes('rate limit')) {
        throw error;
      }
      console.error(`Error searching domain ${domain}: ${error.message}`);
      return null;
    }
  }

  /**
   * BATCHED pre-fetch: Get person IDs for multiple domains at once
   * Uses /people/search which costs 1 credit per 100 domains
   * Returns map of domain → best candidate person (without email)
   */
  async batchPreFetchExecutives(domains: string[]): Promise<Map<string, ApolloPerson | null>> {
    const results = new Map<string, ApolloPerson | null>();
    if (domains.length === 0) return results;

    // STRICT title priority - only people who own security decisions
    const titlePriority = [
      // Tier 1: Security Leadership
      'ciso', 'chief information security officer', 'chief info security officer',
      'information security officer', 'infosec officer',
      'vp security', 'vp of security', 'vice president security', 'vice president of security',
      'vp infosec', 'vp of infosec', 'vp information security', 'vp of information security',
      'director of security', 'security director', 'director security',
      'director of infosec', 'infosec director', 'director of information security', 'information security director',
      'head of security', 'head of infosec', 'head of information security',
      'security lead', 'infosec lead', 'information security lead',

      // Tier 2: IT Leadership
      'vp it', 'vp of it', 'vice president it', 'vp information technology',
      'it director', 'director of it', 'director of information technology',
      'head of it', 'head of infrastructure',

      // Tier 3: Technology Leadership
      'cto', 'chief technology officer', 'chief technical officer',
      'vp engineering', 'vp of engineering', 'vice president engineering',
      'director of engineering', 'engineering director', 'head of engineering',

      // Tier 4: Operations
      'coo', 'chief operating officer',

      // Tier 5: Executive (small companies only)
      'ceo', 'chief executive officer',
      'founder', 'co-founder', 'owner',
    ];

    // REJECT these titles - not security decision makers
    const rejectTitles = [
      // HR/People/Talent
      'recruiter', 'recruiting', 'recruitment', 'talent acquisition', 'talent partner', 'talent director', 'of talent', 'talent strategy',
      'hr ', 'human resources', 'people operations', 'people partner', 'people success', 'people experience', 'people and culture', 'of people', 'people &',
      'learning officer', 'chief learning', ' clo ',
      // Sales/Business Development/Partnerships
      'sales', 'account executive', 'business development', 'bdr', 'sdr', 'revenue officer', ' cro',
      'partnerships', 'partner director', 'alliances', 'alliance ', ' bd ', 'head of bd',
      'growth', 'gtm', 'go to market', 'commercial', 'corporate development',
      'client solutions', 'customer solutions', 'business director', 'chief business officer',
      // Marketing/Brand/Creative
      'marketing', 'content', 'social media', 'communications', 'brand',
      'animation', 'creative director', 'design director', 'product design',
      // Customer-facing
      'customer success', 'customer support', 'account manager',
      // Finance
      'finance', 'accountant', 'controller', 'bookkeeper',
      // Legal
      'legal', 'counsel', 'paralegal', 'compliance',
      // Admin/Support
      'admin', 'assistant', 'coordinator', 'specialist',
      'intern', 'trainee', 'junior',
      // Other non-security
      'staffing', 'fulfillment',
    ];

    const shouldReject = (title: string): boolean => {
      const normalized = title.toLowerCase();
      return rejectTitles.some(reject => normalized.includes(reject));
    };

    const getPriorityScore = (title: string): number => {
      const normalized = title.toLowerCase();
      for (let i = 0; i < titlePriority.length; i++) {
        if (normalized.includes(titlePriority[i])) return i;
      }
      return 9999;
    };

    try {
      // Single API call for up to 100 domains
      // Only get c_suite, vp, head, director (not manager - too broad)
      const response = await axios.post(
        `${this.baseUrl}/people/search`,
        {
          per_page: 100,
          page: 1,
          q_organization_domains: domains.join('\n'),
          person_seniorities: ['c_suite', 'founder', 'owner', 'vp', 'head', 'director'],
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': this.apiKey,
          },
          timeout: 30000,
        }
      );

      const people = response.data.people || [];

      // Group people by domain, filtering out rejected titles
      const byDomain = new Map<string, ApolloPerson[]>();
      for (const person of people) {
        const domain = person.organization?.primary_domain?.toLowerCase();
        if (!domain || person.email_status === 'unavailable') continue;
        if (!person.title || shouldReject(person.title)) continue;

        if (!byDomain.has(domain)) byDomain.set(domain, []);
        byDomain.get(domain)!.push(person);
      }

      // For each domain, pick the best candidate
      Array.from(byDomain.entries()).forEach(([domain, candidates]) => {
        candidates.sort((a, b) => getPriorityScore(a.title) - getPriorityScore(b.title));
        results.set(domain, candidates[0]);
      });

      // Mark domains with no results as null
      for (const domain of domains) {
        if (!results.has(domain.toLowerCase())) {
          results.set(domain.toLowerCase(), null);
        }
      }

      return results;
    } catch (error: any) {
      console.error(`Batch pre-fetch error: ${error.message}`);
      // Return empty results on error
      for (const domain of domains) {
        results.set(domain.toLowerCase(), null);
      }
      return results;
    }
  }

  /**
   * Enrich a pre-fetched person to get their email (1 credit)
   * Use after batchPreFetchExecutives to minimize credit usage
   */
  async enrichPreFetchedPerson(person: ApolloPerson): Promise<ApolloPerson | null> {
    if (!person.id) {
      console.log(`   ⚠️  No person.id, can't enrich`);
      return null;
    }

    try {
      const enriched = await this.enrichPerson({
        id: person.id,
        reveal_personal_emails: true
      });
      return enriched;
    } catch (error: any) {
      console.error(`   ⚠️  Enrich failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Batch find executives for multiple domains with enrichment
   * Returns map of domain → person
   */
  async batchFindExecutives(domains: string[], enrichEmail: boolean = true): Promise<Map<string, ApolloPerson | null>> {
    const results = new Map<string, ApolloPerson | null>();

    for (const domain of domains) {
      try {
        console.log(`  Searching ${domain}...`);
        const person = await this.findExecutiveContact(domain, enrichEmail);
        results.set(domain, person);

        if (person) {
          const bestEmail = person.email || (person.personal_emails && person.personal_emails[0]);
          const emailStatus = bestEmail ? `✉️  ${bestEmail}` : '⚠️  No email';
          console.log(`    ✅ Found: ${person.name || person.first_name + ' ' + person.last_name} (${person.title}) - ${emailStatus}`);
        } else {
          console.log(`    ⚠️  No executive found`);
        }

        // Rate limiting: ~1 request per second (conservative)
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error: any) {
        console.error(`    ❌ Error: ${error.message}`);
        results.set(domain, null);
      }
    }

    return results;
  }
}

/**
 * Create Apollo client from environment
 */
export function createApolloClientFromEnv(): ApolloClient {
  const apiKey = process.env.APOLLO_API_KEY;

  if (!apiKey) {
    throw new Error('APOLLO_API_KEY not found in environment variables');
  }

  return new ApolloClient(apiKey);
}
