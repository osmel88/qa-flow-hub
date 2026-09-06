import { describe, expect, it } from 'vitest';
import {
  integrationBaseUrlSchema,
  integrationProviderSchema,
  nonSensitiveSettingsSchema,
  upsertIntegrationSchema,
} from './integration.contracts.js';

describe('integrationProviderSchema', () => {
  it.each(['jira', 'testrail', 'github'])('accepts %s', (provider) => {
    expect(integrationProviderSchema.parse(provider)).toBe(provider);
  });

  it.each(['slack', 'github_actions', 'playwright', ''])('rejects %j', (provider) => {
    expect(integrationProviderSchema.safeParse(provider).success).toBe(false);
  });
});

describe('integrationBaseUrlSchema', () => {
  it('trims a valid absolute URL', () => {
    expect(integrationBaseUrlSchema.parse('  https://example.atlassian.net  ')).toBe(
      'https://example.atlassian.net',
    );
  });

  it.each(['example.atlassian.net', 'ftp://example.test', 'javascript:alert(1)', '/relative'])(
    'rejects %j',
    (value) => {
      expect(integrationBaseUrlSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('nonSensitiveSettingsSchema', () => {
  it('accepts a flat record of short strings', () => {
    expect(nonSensitiveSettingsSchema.parse({ projectKey: 'WEB' })).toEqual({ projectKey: 'WEB' });
  });

  it.each([
    ['apiToken', { apiToken: 'abc' }],
    ['password', { password: 'abc' }],
    ['a nested secret name', { github_secret: 'abc' }],
    ['a private key', { privateKey: 'abc' }],
  ])('refuses to store a credential under %s', (_name, value) => {
    expect(nonSensitiveSettingsSchema.safeParse(value).success).toBe(false);
  });
});

describe('upsertIntegrationSchema', () => {
  it('drops unknown fields, which is what keeps a credential out of the payload', () => {
    const parsed = upsertIntegrationSchema.parse({
      mode: 'mock',
      apiToken: 'super-secret',
      status: 'connected',
      enabled: true,
    });

    expect(parsed).toEqual({ mode: 'mock' });
  });

  it('rejects an unknown mode', () => {
    expect(upsertIntegrationSchema.safeParse({ mode: 'live' }).success).toBe(false);
  });

  it('accepts an explicit null base URL, which is how one is cleared', () => {
    expect(upsertIntegrationSchema.parse({ mode: 'mock', baseUrl: null }).baseUrl).toBeNull();
  });
});
