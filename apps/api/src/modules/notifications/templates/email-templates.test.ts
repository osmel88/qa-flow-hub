import { describe, expect, it } from 'vitest';
import { NOTIFICATION_TYPES } from '@qa-flow-hub/shared';
import { escapeHtml, renderEmail, TEMPLATE_KEYS } from './email-templates';

const expiresAt = new Date('2026-10-01T12:30:00.000Z');

describe('email templates', () => {
  it('has a versioned template key for every notification type', () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(TEMPLATE_KEYS[type]).toMatch(new RegExp(`^${type}\\.v\\d+$`));
    }
  });

  it('renders the invitation with the accept link in both bodies and a readable expiry', () => {
    const mail = renderEmail('organization_invitation', {
      organizationName: 'Acme QA',
      inviterName: 'Grace Hopper',
      role: 'qa_lead',
      acceptUrl: 'https://app.local/invitations/accept?token=abc123',
      expiresAt,
    });

    expect(mail.subject).toBe("You're invited to join Acme QA on qa-flow-hub");
    expect(mail.text).toContain('Grace Hopper has invited you');
    expect(mail.text).toContain('as qa lead');
    expect(mail.text).toContain('2026-10-01 12:30 UTC');
    expect(mail.text).toContain('https://app.local/invitations/accept?token=abc123');
    expect(mail.html).toContain('href="https://app.local/invitations/accept?token=abc123"');
    expect(mail.html).toContain('Accept invitation');
  });

  it('renders the security notice without depending on any organization', () => {
    const mail = renderEmail('password_changed', {
      fullName: 'Ada Lovelace',
      changedAt: expiresAt,
      loginUrl: 'https://app.local/login',
    });

    expect(mail.subject).toMatch(/password/i);
    expect(mail.text).toContain('Ada Lovelace');
    expect(mail.text).toContain('2026-10-01 12:30 UTC');
    expect(mail.text).toContain('https://app.local/login');
  });

  it('pluralises the assigned case count', () => {
    const one = renderEmail('test_run_assignment', {
      assigneeName: 'Ada',
      assignedByName: 'Grace',
      organizationName: 'Acme QA',
      projectName: 'Web',
      runName: 'Sprint 12 regression',
      assignedCases: 1,
      runUrl: 'https://app.local/test-runs/run_1',
    });
    const many = renderEmail('test_run_assignment', {
      assigneeName: 'Ada',
      assignedByName: 'Grace',
      organizationName: 'Acme QA',
      projectName: 'Web',
      runName: 'Sprint 12 regression',
      assignedCases: 3,
      runUrl: 'https://app.local/test-runs/run_1',
    });

    expect(one.text).toContain('1 test case');
    expect(one.text).not.toContain('1 test cases');
    expect(many.text).toContain('3 test cases');
    expect(many.subject).toContain('Sprint 12 regression');
  });

  it('names the defect and severity for an assignment, and the transition for a status change', () => {
    const assigned = renderEmail('defect_assignment', {
      assigneeName: 'Ada',
      assignedByName: 'Grace',
      organizationName: 'Acme QA',
      projectName: 'Web',
      defectTitle: 'Checkout total is wrong',
      severity: 'critical',
      defectUrl: 'https://app.local/defects/d_1',
    });
    const moved = renderEmail('defect_status_changed', {
      recipientName: 'Ada',
      changedByName: 'Grace',
      organizationName: 'Acme QA',
      projectName: 'Web',
      defectTitle: 'Checkout total is wrong',
      fromStatus: 'in_progress',
      toStatus: 'resolved',
      defectUrl: 'https://app.local/defects/d_1',
    });

    expect(assigned.subject).toContain('Checkout total is wrong');
    expect(assigned.text).toContain('critical');
    expect(moved.text).toContain('in progress');
    expect(moved.text).toContain('resolved');
    expect(moved.html).toContain('href="https://app.local/defects/d_1"');
  });

  it('escapes every variable in the HTML body but leaves the plain text untouched', () => {
    const mail = renderEmail('defect_assignment', {
      assigneeName: 'Ada',
      assignedByName: 'Grace',
      organizationName: 'Acme <script>alert(1)</script>',
      projectName: 'Web',
      defectTitle: 'Tom & Jerry "quoted"',
      severity: 'major',
      defectUrl: 'https://app.local/defects/d_1',
    });

    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('Tom &amp; Jerry &quot;quoted&quot;');
    expect(mail.text).toContain('Tom & Jerry "quoted"');
    expect(escapeHtml(`<a href='x'>&</a>`)).toBe('&lt;a href=&#39;x&#39;&gt;&amp;&lt;/a&gt;');
  });
});
