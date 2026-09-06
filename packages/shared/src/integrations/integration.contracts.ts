import { z } from 'zod';

/**
 * The providers the settings screen configures. A deliberate subset of the
 * `IntegrationProvider` enum: `github_actions`, `playwright` and `generic_ci`
 * are ingestion surfaces of the GitHub connection, not separate things a user
 * connects, and offering them as such would ask for four credentials where one
 * exists.
 */
export const CONFIGURABLE_INTEGRATION_PROVIDERS = ['jira', 'testrail', 'github'] as const;
export type ConfigurableIntegrationProvider = (typeof CONFIGURABLE_INTEGRATION_PROVIDERS)[number];

export const INTEGRATION_MODES = ['mock', 'real'] as const;
export type IntegrationMode = (typeof INTEGRATION_MODES)[number];

export const INTEGRATION_STATUSES = ['disconnected', 'pending', 'connected', 'error'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const integrationProviderSchema = z.enum(CONFIGURABLE_INTEGRATION_PROVIDERS);

/**
 * A base URL is validated as an absolute `http(s)` URL rather than a free
 * string: the value is later used to build requests, and "jira.example.com"
 * without a scheme resolves to a relative path, which fails at the worst moment
 * with the least informative error.
 */
export const integrationBaseUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'Use an absolute http(s) URL',
  });

/**
 * Non-sensitive values only, and shallow on purpose: a flat record of short
 * strings can be shown in a form, audited and diffed. Anything that needs
 * nesting is a provider-specific mapping, which arrives with its provider's
 * phase and its own contract.
 */
const nonSensitiveRecordSchema = z
  .record(z.string().trim().max(512))
  .refine((value) => Object.keys(value).length <= 32, {
    message: 'Too many configuration entries',
  });

/**
 * Rejects the keys a secret would most likely arrive under. This is a guard
 * rail, not a security boundary — the boundary is that no endpoint in this
 * phase accepts a credential at all — but a mistyped field name is exactly how
 * a token ends up in a JSON column that is returned to the browser.
 */
const SECRET_LIKE_KEY = /(token|secret|password|apikey|api_key|credential|private)/i;

export const nonSensitiveSettingsSchema = nonSensitiveRecordSchema.refine(
  (value) => !Object.keys(value).some((key) => SECRET_LIKE_KEY.test(key)),
  { message: 'Credentials cannot be stored in non-sensitive configuration' },
);

export const upsertIntegrationSchema = z.object({
  displayName: z.string().trim().min(2).max(120).optional(),
  mode: z.enum(INTEGRATION_MODES),
  baseUrl: integrationBaseUrlSchema.nullish(),
  settings: nonSensitiveSettingsSchema.optional(),
  accountMetadata: nonSensitiveSettingsSchema.optional(),
});
export type UpsertIntegrationInput = z.infer<typeof upsertIntegrationSchema>;

/**
 * What a connection looks like from outside the API.
 *
 * There is no credential field and no partial credential field. `hasCredential`
 * is the only thing said about it: presence, never a prefix, a length or a
 * masked tail, because those are the pieces an attacker uses to confirm a
 * guessed token.
 */
export interface IntegrationConnectionView {
  id: string | null;
  provider: ConfigurableIntegrationProvider;
  displayName: string;
  mode: IntegrationMode;
  enabled: boolean;
  status: IntegrationStatus;
  baseUrl: string | null;
  settings: Record<string, string>;
  accountMetadata: Record<string, string>;
  hasCredential: boolean;
  lastSyncedAt: string | null;
  lastConnectionTestAt: string | null;
  lastError: string | null;
  /**
   * Which modes this provider accepts today, and why the others are refused.
   * Sent by the API so the UI does not carry a second copy of the roadmap:
   * Jira and TestRail stay on mocks until dedicated accounts exist, and GitHub
   * cannot connect for real until the credential store exists (S2-F4).
   */
  availableModes: IntegrationMode[];
  /**
   * Whether a real connection can be established today. When false, `Connect`
   * still saves and enables the configuration and leaves the connection
   * `pending`: the settings are real, the provider implementation is not.
   */
  connectable: boolean;
  unavailableReason: string | null;
  updatedAt: string | null;
}

export interface IntegrationTestResultView {
  provider: ConfigurableIntegrationProvider;
  reachable: boolean;
  message: string;
  checkedAt: string;
  connection: IntegrationConnectionView;
}
