import { describe, expect, it } from 'vitest';
import { EnvSecretResolver } from './env-secret-resolver';
import { InvalidSecretReferenceError } from './secret-resolver';

const orgA = 'cmabc123orga';
const orgB = 'cmxyz789orgb';

const env = {
  [EnvSecretResolver.variableFor(orgA, 'github_token')]: 'token-of-a',
  [EnvSecretResolver.variableFor(orgB, 'github_token')]: 'token-of-b',
  JWT_ACCESS_SECRET: 'the-api-signing-key',
};

describe('EnvSecretResolver', () => {
  const resolver = new EnvSecretResolver(env);

  it('resolves a reference the organization owns', async () => {
    const ref = `env:${EnvSecretResolver.variableFor(orgA, 'github_token')}`;

    await expect(resolver.resolve(ref, { organizationId: orgA })).resolves.toBe('token-of-a');
  });

  it("refuses another organization's variable", async () => {
    const ref = `env:${EnvSecretResolver.variableFor(orgB, 'github_token')}`;

    await expect(resolver.resolve(ref, { organizationId: orgA })).rejects.toBeInstanceOf(
      InvalidSecretReferenceError,
    );
  });

  it('refuses variables outside the secret prefix, such as the API signing keys', async () => {
    await expect(
      resolver.resolve('env:JWT_ACCESS_SECRET', { organizationId: orgA }),
    ).rejects.toBeInstanceOf(InvalidSecretReferenceError);
  });

  it.each([
    'github_token',
    'vault:kv/a',
    'env:',
    'env:lower_case',
    `env:QAFLOW_SECRET_${orgA.toUpperCase()}_`,
  ])('refuses the malformed reference %s', async (ref) => {
    await expect(resolver.resolve(ref, { organizationId: orgA })).rejects.toBeInstanceOf(
      InvalidSecretReferenceError,
    );
  });

  it('answers null when the reference is valid but nothing is stored', async () => {
    const ref = `env:${EnvSecretResolver.variableFor(orgA, 'jira_token')}`;

    await expect(resolver.resolve(ref, { organizationId: orgA })).resolves.toBeNull();
  });

  it('never puts the value in an error message', async () => {
    const ref = `env:${EnvSecretResolver.variableFor(orgB, 'github_token')}`;
    const error = await resolver.resolve(ref, { organizationId: orgA }).catch((e: unknown) => e);

    expect(String(error)).not.toContain('token-of-b');
  });
});
