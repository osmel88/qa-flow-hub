import { expect, test } from '@playwright/test';

/**
 * Code reviews (S5-F3), everything local: the owner records a pull request of
 * a story and opens a review of it for a QA lead. The author gets no approve
 * button; the reviewer approves, the review becomes ready to merge and the
 * story shows the approval in its development status. The owner dismisses the
 * approval and, after a reload, the review is no longer ready.
 */
const unique = Date.now();
const owner = {
  email: `e2e-cr-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Review Owner',
};
const reviewer = {
  email: `e2e-cr-reviewer-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Review Lead',
};

test('a local code review is approved by its reviewer and drives merge readiness', async ({
  browser,
}) => {
  const ownerPage = await (await browser.newContext()).newPage();
  const reviewerPage = await (await browser.newContext()).newPage();

  let token = '';
  await test.step('the owner sets up a project, a story, a pull request and a reviewer', async () => {
    await ownerPage.goto('/register');
    await ownerPage.getByLabel('Full name').fill(owner.fullName);
    await ownerPage.getByLabel('Email').fill(owner.email);
    await ownerPage.getByLabel('Password').fill(owner.password);
    await ownerPage.getByRole('button', { name: 'Create account' }).click();
    await expect(ownerPage.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await ownerPage.getByLabel('Name').fill(`Reviews ${unique}`);
    await ownerPage.getByLabel('Slug').fill(`reviews-${unique}`);
    await ownerPage.getByRole('button', { name: 'Create' }).click();
    await expect(ownerPage.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await ownerPage.getByRole('link', { name: 'Projects' }).click();
    await ownerPage.getByLabel('Name').fill('Reviews');
    await ownerPage.getByLabel('Key').fill('REV');
    await ownerPage.getByRole('button', { name: 'Create project' }).click();
    await expect(ownerPage.getByRole('cell', { name: 'REV', exact: true })).toBeVisible();

    await ownerPage.getByRole('link', { name: 'Work items' }).click();
    await ownerPage.getByLabel('Title').fill('Card payment form');
    await ownerPage.getByRole('button', { name: 'Add work item' }).click();
    await expect(ownerPage.getByRole('link', { name: 'Card payment form' })).toBeVisible();

    await ownerPage.getByRole('link', { name: 'Development', exact: true }).click();
    await ownerPage.getByLabel('Pull request number').fill('21');
    await ownerPage.getByLabel('Title').fill('Card form');
    await ownerPage.getByLabel('Artifact status').selectOption('open');
    await ownerPage
      .getByLabel('Link to work item')
      .selectOption({ label: 'REV-W-1 Card payment form' });
    await ownerPage.getByRole('button', { name: 'Record activity' }).click();
    await expect(ownerPage.getByRole('status')).toContainText('#21');

    await ownerPage.getByRole('link', { name: 'Members' }).click();
    await ownerPage.getByLabel('Email').fill(reviewer.email);
    await ownerPage.getByLabel('Role', { exact: true }).selectOption('qa_lead');
    await ownerPage.getByRole('button', { name: 'Send invitation' }).click();
    const issued = ownerPage.getByRole('status').locator('code');
    await expect(issued).toBeVisible();
    token = (await issued.textContent()) ?? '';

    await reviewerPage.goto('/register');
    await reviewerPage.getByLabel('Full name').fill(reviewer.fullName);
    await reviewerPage.getByLabel('Email').fill(reviewer.email);
    await reviewerPage.getByLabel('Password').fill(reviewer.password);
    await reviewerPage.getByRole('button', { name: 'Create account' }).click();
    await expect(reviewerPage.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await reviewerPage.getByLabel('Invitation token').fill(token);
    await reviewerPage.getByRole('button', { name: 'Join' }).click();
    await expect(reviewerPage.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await ownerPage.getByRole('link', { name: 'Project access' }).click();
    await ownerPage
      .getByLabel(`Set the project role of ${reviewer.email}`)
      .selectOption({ label: 'Access with their organization role' });
    await expect(ownerPage.getByRole('row', { name: new RegExp(reviewer.email) })).toContainText(
      'Inherited',
    );
  });

  await test.step('the owner opens a review and cannot approve it', async () => {
    await ownerPage.getByRole('link', { name: 'Code reviews' }).click();
    await expect(ownerPage.getByText('No code reviews match.')).toBeVisible();
    await ownerPage.getByLabel('Review title').fill('Review the card form');
    await ownerPage
      .getByLabel('Reviewer', { exact: true })
      .selectOption({ label: reviewer.fullName });
    await ownerPage
      .getByLabel('Pull request', { exact: true })
      .selectOption({ label: '#21 Card form' });
    await ownerPage
      .getByLabel('Work item', { exact: true })
      .selectOption({ label: 'REV-W-1 · Card payment form' });
    await ownerPage.getByRole('button', { name: 'Open review' }).click();
    await expect(ownerPage.getByRole('heading', { name: 'Review the card form' })).toBeVisible();
    await expect(ownerPage.getByTestId('review-status')).toHaveText('pending');
    await expect(ownerPage.getByTestId('merge-readiness')).toContainText(
      'Not ready (0/1 approvals)',
    );
    await expect(ownerPage.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  });

  await test.step('the reviewer approves and the review is ready to merge', async () => {
    await reviewerPage.reload();
    await reviewerPage.getByRole('link', { name: 'Code reviews' }).click();
    await reviewerPage.getByLabel('Reviewer filter').selectOption('me');
    await reviewerPage.getByRole('link', { name: 'Review the card form' }).click();
    await reviewerPage.getByLabel('Review comment').fill('Looks good');
    await reviewerPage.getByRole('button', { name: 'Approve' }).click();
    await expect(reviewerPage.getByTestId('review-status')).toHaveText('approved');
    await expect(reviewerPage.getByTestId('merge-readiness')).toHaveText('Ready to merge');
    await expect(reviewerPage.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  await test.step('the story shows the review and the approval in its development status', async () => {
    await ownerPage.reload();
    await expect(ownerPage.getByTestId('review-status')).toHaveText('approved');
    await ownerPage.getByRole('link', { name: 'REV-W-1 · Card payment form' }).click();
    const development = ownerPage.getByRole('region', { name: 'Development' });
    await expect(development.getByTestId('development-status')).toHaveText('pr approved');
    const reviews = ownerPage.getByRole('region', { name: 'Code reviews' });
    await expect(reviews.getByTestId('merge-readiness')).toHaveText('Ready to merge');
    await reviews.getByRole('link', { name: 'Review the card form' }).click();
  });

  await test.step('the owner dismisses the approval and it stays dismissed after a reload', async () => {
    await ownerPage.getByRole('button', { name: 'Dismiss decision' }).click();
    await expect(ownerPage.getByTestId(`reviewer-${reviewer.fullName}`)).toContainText('dismissed');
    await ownerPage.reload();
    await expect(ownerPage.getByTestId('review-status')).toHaveText('in review');
    await expect(ownerPage.getByTestId('merge-readiness')).toContainText(
      'Not ready (0/1 approvals)',
    );
    await expect(ownerPage.getByRole('list', { name: 'Review history' })).toContainText(
      'approval dismissed',
    );
  });
});
