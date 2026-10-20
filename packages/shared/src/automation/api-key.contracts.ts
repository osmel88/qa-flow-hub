import { z } from 'zod';

/**
 * Machine credentials for CI. A key belongs to one project of one organization
 * and carries scopes; the only scope today is result ingestion. The secret is
 * shown once, at creation, and only its SHA-256 is stored.
 */
export const API_KEY_SCOPES = ['results:ingest'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export const apiKeyScopeSchema = z.enum(API_KEY_SCOPES);

/** `qfh_<prefix>_<secret>`: the prefix finds the row, the secret proves possession. */
export const API_KEY_TOKEN_PATTERN = /^qfh_([A-Za-z0-9]{12})_([A-Za-z0-9_-]{43})$/;

export const API_KEY_MAX_TTL_DAYS = 365;

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(apiKeyScopeSchema).min(1).max(API_KEY_SCOPES.length).default(['results:ingest']),
  /** Days until the key stops working; omitted or null means it never expires. */
  expiresInDays: z.number().int().min(1).max(API_KEY_MAX_TTL_DAYS).nullable().optional(),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

export type ApiKeyState = 'active' | 'expired' | 'revoked';

export interface ApiKeyView {
  id: string;
  projectId: string;
  name: string;
  /** Public part of the token, safe to display to identify a key. */
  prefix: string;
  scopes: ApiKeyScope[];
  state: ApiKeyState;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdById: string | null;
  createdAt: string;
}

export interface CreatedApiKeyView {
  key: ApiKeyView;
  /** The full token. Returned exactly once; it cannot be recovered later. */
  token: string;
}
