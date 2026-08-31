/**
 * Development seed.
 *
 * Creates two organizations with overlapping members. That overlap is the
 * point: it is the fixture that makes cross-tenant leaks visible by hand.
 * `qa@acme.test` is a qa-lead in Acme and only a viewer in Globex, so if the
 * UI or the API ever shows Globex data with Acme selected, you will see it.
 *
 * All data is fictional. Passwords are the same on purpose and are only ever
 * used locally.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  AutomationStatus,
  DefectSeverity,
  DefectStatus,
  InvitationStatus,
  OrganizationPlan,
  OrganizationRole,
  Priority,
  PrismaClient,
  RequirementStatus,
  RequirementType,
  TestCaseStatus,
  TestCaseType,
  TestResultStatus,
  TestRunStatus,
  TraceLinkType,
} from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

const DEMO_PASSWORD = 'Password123!';

async function main(): Promise<void> {
  const passwordHash = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id });

  // Named after the role each one actually holds: a seed user called "viewer"
  // who owns an organization sends every permission test down a false path.
  const [owner, qaLead, tester, globexOwner] = await Promise.all([
    upsertUser('owner@acme.test', 'Olivia Owner', passwordHash),
    upsertUser('qa@acme.test', 'Quentin Lead', passwordHash),
    upsertUser('tester@acme.test', 'Tania Tester', passwordHash),
    upsertUser('owner@globex.test', 'Gabriel Globex', passwordHash),
  ]);

  const acme = await upsertOrganization('Acme QA', 'acme', OrganizationPlan.team);
  const globex = await upsertOrganization('Globex Testing', 'globex', OrganizationPlan.free);

  await Promise.all([
    upsertMember(acme.id, owner.id, OrganizationRole.organization_owner),
    upsertMember(acme.id, qaLead.id, OrganizationRole.qa_lead),
    upsertMember(acme.id, tester.id, OrganizationRole.tester),
    // The same person, a different role in the other organization: this is the
    // only viewer in the seed, and the account to use for a viewer test.
    upsertMember(globex.id, qaLead.id, OrganizationRole.viewer),
    upsertMember(globex.id, globexOwner.id, OrganizationRole.organization_owner),
  ]);

  // A pending invitation, with its token hashed exactly as the application
  // does it. The plaintext is printed once and never stored.
  const invitationToken = randomBytes(32).toString('base64url');
  await prisma.organizationInvitation.deleteMany({
    where: { organizationId: acme.id, email: 'newcomer@acme.test' },
  });
  await prisma.organizationInvitation.create({
    data: {
      organizationId: acme.id,
      email: 'newcomer@acme.test',
      role: OrganizationRole.tester,
      tokenHash: createHash('sha256').update(invitationToken).digest('hex'),
      status: InvitationStatus.pending,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      invitedById: owner.id,
    },
  });

  await seedProject(acme.id, 'Web Portal', 'WEB', owner.id, tester.id);
  await seedProject(acme.id, 'Mobile App', 'MOB', owner.id, tester.id);
  // Globex data exists purely so that isolation failures have something to leak.
  await seedProject(globex.id, 'Legacy ERP', 'ERP', globexOwner.id, globexOwner.id);

  console.log('Seed complete.');
  console.log(`  users:      owner@acme.test (owner) / qa@acme.test (viewer in Globex) / tester@acme.test / owner@globex.test`);
  console.log(`  password:   ${DEMO_PASSWORD}`);
  console.log(`  invitation: newcomer@acme.test -> ${invitationToken}`);
}

async function upsertUser(email: string, fullName: string, passwordHash: string) {
  return prisma.user.upsert({
    where: { email },
    update: { fullName },
    create: { email, fullName, passwordHash },
  });
}

async function upsertOrganization(name: string, slug: string, plan: OrganizationPlan) {
  return prisma.organization.upsert({
    where: { slug },
    update: { name, plan },
    create: { name, slug, plan },
  });
}

async function upsertMember(organizationId: string, userId: string, role: OrganizationRole) {
  return prisma.organizationMember.upsert({
    where: { organizationId_userId: { organizationId, userId } },
    update: { role },
    create: { organizationId, userId, role },
  });
}

async function seedProject(
  organizationId: string,
  name: string,
  key: string,
  ownerId: string,
  testerId: string,
): Promise<void> {
  const project = await prisma.project.upsert({
    where: { organizationId_key: { organizationId, key } },
    update: { name },
    create: {
      organizationId,
      name,
      key,
      description: `${name} — fictional seed data`,
      requirementCounter: 2,
      testCaseCounter: 2,
      defectCounter: 1,
    },
  });

  const existing = await prisma.requirement.count({ where: { projectId: project.id } });
  if (existing > 0) {
    return;
  }

  const requirement = await prisma.requirement.create({
    data: {
      organizationId,
      projectId: project.id,
      key: `${key}-R-1`,
      title: 'A user can recover a forgotten password',
      description: 'Password recovery by email with a single-use, time-limited link.',
      acceptanceCriteria: '- The link expires after 30 minutes\n- The link works only once',
      type: RequirementType.user_story,
      priority: Priority.high,
      status: RequirementStatus.approved,
      tags: ['auth', 'mvp'],
      createdById: ownerId,
    },
  });

  await prisma.requirement.create({
    data: {
      organizationId,
      projectId: project.id,
      key: `${key}-R-2`,
      title: 'Sessions can be revoked from the profile page',
      type: RequirementType.functional,
      priority: Priority.medium,
      // Deliberately left without test cases: this is the coverage gap the
      // traceability matrix must surface.
      status: RequirementStatus.draft,
      createdById: ownerId,
    },
  });

  const suite = await prisma.testSuite.create({
    data: { organizationId, projectId: project.id, name: 'Regression', position: 0 },
  });

  const section = await prisma.testSection.create({
    data: { organizationId, suiteId: suite.id, name: 'Authentication', position: 0 },
  });

  const passingCase = await prisma.testCase.create({
    data: {
      organizationId,
      projectId: project.id,
      suiteId: suite.id,
      sectionId: section.id,
      key: `${key}-C-1`,
      title: 'Recovery link works once',
      preconditions: 'A registered user with a known email address',
      expectedResult: 'The password is changed and the link stops working',
      type: TestCaseType.functional,
      priority: Priority.high,
      status: TestCaseStatus.active,
      automationStatus: AutomationStatus.candidate,
      createdById: ownerId,
      steps: {
        create: [
          { organizationId, position: 1, action: 'Request password recovery', expectedResult: 'A link is issued' },
          { organizationId, position: 2, action: 'Open the link and set a new password', expectedResult: 'The password changes' },
          { organizationId, position: 3, action: 'Open the same link again', expectedResult: 'The link is rejected' },
        ],
      },
    },
    include: { steps: true },
  });

  const failingCase = await prisma.testCase.create({
    data: {
      organizationId,
      projectId: project.id,
      suiteId: suite.id,
      sectionId: section.id,
      key: `${key}-C-2`,
      title: 'Recovery link expires after 30 minutes',
      expectedResult: 'An expired link is rejected with a clear message',
      type: TestCaseType.functional,
      priority: Priority.critical,
      status: TestCaseStatus.active,
      createdById: ownerId,
      steps: {
        create: [
          { organizationId, position: 1, action: 'Request password recovery', expectedResult: 'A link is issued' },
          { organizationId, position: 2, action: 'Wait 31 minutes and open the link', expectedResult: 'The link is rejected' },
        ],
      },
    },
    include: { steps: true },
  });

  await prisma.traceabilityLink.createMany({
    data: [passingCase.id, failingCase.id].map((testCaseId) => ({
      organizationId,
      sourceType: 'requirement' as const,
      sourceId: requirement.id,
      targetType: 'test_case' as const,
      targetId: testCaseId,
      linkType: TraceLinkType.verifies,
      createdById: ownerId,
    })),
  });

  const run = await prisma.testRun.create({
    data: {
      organizationId,
      projectId: project.id,
      name: 'Release 1.0 — smoke',
      milestone: '1.0',
      environment: 'staging',
      status: TestRunStatus.in_progress,
      startedAt: new Date(),
      createdById: ownerId,
    },
  });

  for (const [index, testCase] of [passingCase, failingCase].entries()) {
    const status = index === 0 ? TestResultStatus.passed : TestResultStatus.failed;

    const runCase = await prisma.testRunCase.create({
      data: {
        organizationId,
        testRunId: run.id,
        testCaseId: testCase.id,
        caseVersion: testCase.version,
        caseSnapshot: {
          key: testCase.key,
          title: testCase.title,
          preconditions: testCase.preconditions,
          expectedResult: testCase.expectedResult,
          steps: testCase.steps.map((s) => ({
            position: s.position,
            action: s.action,
            expectedResult: s.expectedResult,
          })),
        },
        assignedToId: testerId,
        latestStatus: status,
        position: index,
      },
    });

    const result = await prisma.testResult.create({
      data: {
        organizationId,
        testRunId: run.id,
        testRunCaseId: runCase.id,
        status,
        comment: status === TestResultStatus.failed ? 'The link is still valid after 45 minutes' : null,
        elapsedSeconds: 120 + index * 60,
        executedById: testerId,
      },
    });

    if (status === TestResultStatus.failed) {
      await prisma.defect.create({
        data: {
          organizationId,
          projectId: project.id,
          key: `${key}-D-1`,
          title: 'Recovery link does not expire',
          description: 'The token is accepted well past its stated lifetime.',
          severity: DefectSeverity.critical,
          priority: Priority.high,
          status: DefectStatus.open,
          environment: 'staging',
          testResultId: result.id,
          testCaseId: testCase.id,
          testRunId: run.id,
          reportedById: testerId,
          assigneeId: ownerId,
        },
      });
    }
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
