import type { NotificationType } from '@qa-flow-hub/shared';

/**
 * Typed email templates.
 *
 * A template is a pure function from typed variables to a rendered message.
 * It knows nothing about who the recipient is, why the mail is being sent or
 * which provider carries it; that is what makes it testable with a single
 * `expect` and reusable when a second channel (in-app, Slack) arrives.
 *
 * Every string variable is HTML-escaped before it reaches the HTML body. The
 * plain-text body is the source of truth: a client that strips HTML must lose
 * nothing but the styling.
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface OrganizationInvitationVars {
  organizationName: string;
  inviterName: string;
  role: string;
  /** Complete acceptance URL, token included. Rendered into the body, never logged. */
  acceptUrl: string;
  expiresAt: Date;
}

export interface PasswordChangedVars {
  fullName: string;
  changedAt: Date;
  /** Where the recipient can react if it was not them. */
  loginUrl: string;
}

export interface TestRunAssignmentVars {
  assigneeName: string;
  assignedByName: string;
  organizationName: string;
  projectName: string;
  runName: string;
  /** How many cases this operation put on the recipient's plate. */
  assignedCases: number;
  runUrl: string;
}

export interface DefectAssignmentVars {
  assigneeName: string;
  assignedByName: string;
  organizationName: string;
  projectName: string;
  defectTitle: string;
  severity: string;
  defectUrl: string;
}

export interface DefectStatusChangedVars {
  recipientName: string;
  changedByName: string;
  organizationName: string;
  projectName: string;
  defectTitle: string;
  fromStatus: string;
  toStatus: string;
  defectUrl: string;
}

export interface TestRunFailedVars {
  recipientName: string;
  completedByName: string;
  organizationName: string;
  projectName: string;
  runName: string;
  failedCases: number;
  blockedCases: number;
  totalCases: number;
  runUrl: string;
}

export interface EmailTemplateVars {
  organization_invitation: OrganizationInvitationVars;
  password_changed: PasswordChangedVars;
  test_run_assignment: TestRunAssignmentVars;
  defect_assignment: DefectAssignmentVars;
  defect_status_changed: DefectStatusChangedVars;
  test_run_failed: TestRunFailedVars;
}

/**
 * Bumped when the wording of a template changes in a way an operator may need
 * to tell apart in the ledger ("which version did this user receive?").
 */
export const TEMPLATE_KEYS: Record<NotificationType, string> = {
  organization_invitation: 'organization_invitation.v1',
  password_changed: 'password_changed.v1',
  test_run_assignment: 'test_run_assignment.v1',
  defect_assignment: 'defect_assignment.v1',
  defect_status_changed: 'defect_status_changed.v1',
  test_run_failed: 'test_run_failed.v1',
};

const PRODUCT = 'qa-flow-hub';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function humanize(value: string): string {
  return value.replaceAll('_', ' ');
}

function formatDate(value: Date): string {
  return value.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

interface LayoutInput {
  title: string;
  greeting: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  footer: string;
}

/**
 * One layout for every message. The text version is built from the same
 * parts, so the two bodies cannot drift apart.
 */
function layout(input: LayoutInput): { text: string; html: string } {
  const textLines = [input.greeting, '', ...input.paragraphs.flatMap((p) => [p, ''])];
  if (input.action !== undefined) {
    textLines.push(`${input.action.label}: ${input.action.url}`, '');
  }
  textLines.push(`— ${PRODUCT}`, '', input.footer);

  const htmlParagraphs = input.paragraphs
    .map((p) => `<p style="margin:0 0 12px 0;">${escapeHtml(p)}</p>`)
    .join('\n      ');
  const htmlAction =
    input.action === undefined
      ? ''
      : `<p style="margin:20px 0;">
        <a href="${escapeHtml(input.action.url)}" style="background:#1d4ed8;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block;">${escapeHtml(input.action.label)}</a>
      </p>
      <p style="margin:0 0 12px 0;color:#6b7280;font-size:12px;">If the button does not work, copy this link: ${escapeHtml(input.action.url)}</p>`;

  const html = `<!doctype html>
<html>
  <body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f3f4f6;margin:0;padding:24px;color:#111827;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px;">
      <h1 style="font-size:18px;margin:0 0 16px 0;">${escapeHtml(input.title)}</h1>
      <p style="margin:0 0 12px 0;">${escapeHtml(input.greeting)}</p>
      ${htmlParagraphs}
      ${htmlAction}
      <p style="margin:24px 0 0 0;color:#6b7280;font-size:12px;">${escapeHtml(input.footer)}</p>
    </div>
  </body>
</html>`;

  return { text: textLines.join('\n'), html };
}

const NO_REPLY = 'This message was sent automatically by qa-flow-hub; replies are not monitored.';

export const emailTemplates: {
  [T in NotificationType]: (vars: EmailTemplateVars[T]) => RenderedEmail;
} = {
  organization_invitation: (vars) => {
    const subject = `You're invited to join ${vars.organizationName} on ${PRODUCT}`;
    return {
      subject,
      ...layout({
        title: subject,
        greeting: 'Hello,',
        paragraphs: [
          `${vars.inviterName} has invited you to join the organization "${vars.organizationName}" as ${humanize(vars.role)}.`,
          `This invitation expires on ${formatDate(vars.expiresAt)}. If you were not expecting it, you can ignore this message.`,
        ],
        action: { label: 'Accept invitation', url: vars.acceptUrl },
        footer: NO_REPLY,
      }),
    };
  },

  password_changed: (vars) => {
    const subject = `Your ${PRODUCT} password was changed`;
    return {
      subject,
      ...layout({
        title: subject,
        greeting: `Hello ${vars.fullName},`,
        paragraphs: [
          `The password of your account was changed on ${formatDate(vars.changedAt)}. Every other session has been signed out.`,
          'If this was you, no action is needed. If it was not, sign in with your new credentials as soon as possible and contact your organization owner.',
        ],
        action: { label: 'Sign in', url: vars.loginUrl },
        footer: NO_REPLY,
      }),
    };
  },

  test_run_assignment: (vars) => {
    const cases = vars.assignedCases === 1 ? '1 test case' : `${vars.assignedCases} test cases`;
    const subject = `[${vars.projectName}] ${cases} assigned to you in "${vars.runName}"`;
    return {
      subject,
      ...layout({
        title: 'New test run assignment',
        greeting: `Hello ${vars.assigneeName},`,
        paragraphs: [
          `${vars.assignedByName} assigned you ${cases} in the test run "${vars.runName}" (${vars.organizationName} / ${vars.projectName}).`,
        ],
        action: { label: 'Open test run', url: vars.runUrl },
        footer: NO_REPLY,
      }),
    };
  },

  defect_assignment: (vars) => {
    const subject = `[${vars.projectName}] Defect assigned to you: ${vars.defectTitle}`;
    return {
      subject,
      ...layout({
        title: 'New defect assignment',
        greeting: `Hello ${vars.assigneeName},`,
        paragraphs: [
          `${vars.assignedByName} assigned you the defect "${vars.defectTitle}" (severity: ${humanize(vars.severity)}) in ${vars.organizationName} / ${vars.projectName}.`,
        ],
        action: { label: 'Open defect', url: vars.defectUrl },
        footer: NO_REPLY,
      }),
    };
  },

  defect_status_changed: (vars) => {
    const subject = `[${vars.projectName}] Defect ${humanize(vars.toStatus)}: ${vars.defectTitle}`;
    return {
      subject,
      ...layout({
        title: 'Defect status changed',
        greeting: `Hello ${vars.recipientName},`,
        paragraphs: [
          `${vars.changedByName} moved the defect "${vars.defectTitle}" from ${humanize(vars.fromStatus)} to ${humanize(vars.toStatus)} in ${vars.organizationName} / ${vars.projectName}.`,
        ],
        action: { label: 'Open defect', url: vars.defectUrl },
        footer: NO_REPLY,
      }),
    };
  },

  test_run_failed: (vars) => {
    const failed = vars.failedCases === 1 ? '1 failed case' : `${vars.failedCases} failed cases`;
    const subject = `[${vars.projectName}] Test run "${vars.runName}" completed with ${failed}`;
    const blocked = vars.blockedCases === 0 ? '' : `, ${vars.blockedCases} blocked`;
    return {
      subject,
      ...layout({
        title: 'Test run completed with failures',
        greeting: `Hello ${vars.recipientName},`,
        paragraphs: [
          `${vars.completedByName} completed the test run "${vars.runName}" in ${vars.organizationName} / ${vars.projectName}: ${vars.failedCases} of ${vars.totalCases} cases failed${blocked}.`,
        ],
        action: { label: 'Open test run', url: vars.runUrl },
        footer: NO_REPLY,
      }),
    };
  },
};

export function renderEmail<T extends NotificationType>(
  type: T,
  vars: EmailTemplateVars[T],
): RenderedEmail {
  return emailTemplates[type](vars);
}
