import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { LightMyRequestResponse } from 'fastify';

const PASSWORD = 'Str0ngPassword!';

export interface TestAccount {
  userId: string;
  email: string;
  accessToken: string;
}

export interface TestWorkspace {
  organizationId: string;
  projectId: string;
  owner: TestAccount;
  /** Registers a user, invites them in the given role and accepts for them. */
  addMember(role: string, emailPrefix?: string): Promise<TestAccount>;
}

export interface RequestOptions {
  payload?: object;
  token?: string;
  organizationId?: string;
}

export type Injector = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options?: RequestOptions,
) => Promise<LightMyRequestResponse>;

/**
 * Test suites get the app lazily, because Nest boots in `beforeAll` while the
 * helper is built at module scope.
 */
export function injector(getApp: () => NestFastifyApplication): Injector {
  return (method, url, options = {}) =>
    getApp().inject({
      method,
      url,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      headers: {
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...(options.organizationId === undefined
          ? {}
          : { 'x-organization-id': options.organizationId }),
      },
    });
}

export async function registerAccount(
  app: NestFastifyApplication,
  email: string,
): Promise<TestAccount> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: PASSWORD, fullName: 'Test Person' },
  });
  if (response.statusCode !== 201) {
    throw new Error(`Could not register ${email}: ${response.body}`);
  }
  const body = response.json();
  return { userId: body.user.id, email: body.user.email, accessToken: body.accessToken };
}

/**
 * An owner, an organization and one project — the starting point every
 * functional module needs before it can be tested at all.
 */
export async function createWorkspace(
  app: NestFastifyApplication,
  options: { emailPrefix?: string; slug?: string; projectKey?: string } = {},
): Promise<TestWorkspace> {
  const prefix = options.emailPrefix ?? 'owner';
  const slug = options.slug ?? 'acme';
  const request = injector(() => app);

  const owner = await registerAccount(app, `${prefix}@example.test`);

  const organization = await request('POST', '/api/v1/organizations', {
    payload: { name: `Org ${slug}`, slug },
    token: owner.accessToken,
  });
  const organizationId = organization.json().id;

  const project = await request('POST', '/api/v1/projects', {
    payload: { name: 'Website', key: options.projectKey ?? 'WEB' },
    token: owner.accessToken,
    organizationId,
  });

  return {
    organizationId,
    projectId: project.json().id,
    owner,
    async addMember(role, emailPrefix = role): Promise<TestAccount> {
      const member = await registerAccount(app, `${emailPrefix}.${slug}@example.test`);
      const invitation = await request('POST', '/api/v1/organizations/current/invitations', {
        payload: { email: member.email, role },
        token: owner.accessToken,
        organizationId,
      });
      await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token: invitation.json().token },
        token: member.accessToken,
      });
      return member;
    },
  };
}
