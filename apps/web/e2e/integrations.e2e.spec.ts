import { expect, test } from '@playwright/test';

/**
 * Settings → Integrations (S2-F1) and the Jira mock (S2-F2): an owner
 * configures Jira, sees the mock answer Test connection, connects, and pushes a
 * requirement and a defect to it; every action that cannot succeed yet says
 * which phase delivers it instead of pretending. The screen is checked against
 * a real API so the tenant header, the role gate and the secret-free response
 * shape are all exercised.
 */
const unique = Date.now();
const account = {
  email: `e2e-integrations-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Integration Owner',
};

test('an owner configures Jira and is told what is not available yet', async ({ page }) => {
  await test.step('register and create the organization', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill(account.fullName);
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();

    await page.getByLabel('Name').fill(`Integrations ${unique}`);
    await page.getByLabel('Slug').fill(`integrations-${unique}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  await test.step('open the integrations screen', async () => {
    await page.getByRole('link', { name: 'Integrations' }).click();
    await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible();
    for (const provider of ['Jira', 'TestRail', 'GitHub']) {
      await expect(page.getByRole('heading', { name: provider, level: 2 })).toBeVisible();
    }
  });

  const jira = page.getByRole('region', { name: 'Jira' });
  const github = page.getByRole('region', { name: 'GitHub' });

  await test.step('save a mock Jira configuration', async () => {
    await expect(jira.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
    await jira.getByLabel('Base URL').fill('https://jira.example.test');
    await jira.getByLabel('Configuration').fill('projectKey=WEB');
    await jira.getByRole('button', { name: 'Save' }).click();
    await expect(jira.getByRole('status')).toContainText('Configuration saved.');
    await expect(jira.locator('.ui-badge', { hasText: 'Mock' })).toBeVisible();
  });

  await test.step('a credential-like key is refused', async () => {
    await jira.getByLabel('Configuration').fill('apiToken=abc');
    await jira.getByRole('button', { name: 'Save' }).click();
    await expect(jira.getByRole('alert')).toContainText('Credentials cannot be stored');
    await jira.getByLabel('Configuration').fill('projectKey=WEB');
  });

  await test.step('test connection reaches the mock and records the attempt', async () => {
    await jira.getByRole('button', { name: 'Test connection' }).click();
    await expect(jira.getByRole('status')).toContainText('issues will be created in project WEB');
    await expect(jira.getByText('never')).toHaveCount(1);
  });

  await test.step('connect makes Jira connected, disconnect clears it', async () => {
    await jira.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(jira.locator('.ui-badge', { hasText: /^connected$/i })).toBeVisible();
    await expect(jira.locator('.ui-badge', { hasText: 'Enabled' })).toBeVisible();

    await jira.getByRole('button', { name: 'Disconnect' }).click();
    await expect(jira.locator('.ui-badge', { hasText: 'Disconnected' })).toBeVisible();
    await expect(jira.locator('.ui-badge', { hasText: 'Disabled' })).toBeVisible();

    await jira.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(jira.locator('.ui-badge', { hasText: /^connected$/i })).toBeVisible();
  });

  await test.step('GitHub has no base URL and its mock answers Test connection', async () => {
    await expect(github.getByLabel('Base URL')).toHaveCount(0);
    await github.getByRole('button', { name: 'Save' }).click();
    await expect(github.getByRole('status')).toContainText('Configuration saved.');
    await github.getByRole('button', { name: 'Test connection' }).click();
    await expect(github.getByRole('status')).toContainText('acme/web-checkout');
    await expect(github.locator('.ui-badge', { hasText: /^Connected$/ })).toHaveCount(0);
  });

  await test.step('create a project with a requirement and a defect', async () => {
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Web checkout');
    await page.getByLabel('Key').fill('WEB');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'WEB', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Requirements' }).click();
    await expect(page.getByRole('heading', { name: 'New requirement' })).toBeVisible();
    await page.getByLabel('Title').fill('The user can pay by card');
    await page.getByRole('button', { name: 'Create requirement' }).click();
    await expect(page.getByRole('cell', { name: 'WEB-R-1' })).toBeVisible();
  });

  await test.step('the requirement becomes a Jira mock issue, and re-sync keeps the key', async () => {
    const row = page.getByRole('row', { name: /WEB-R-1/ });
    await row.getByRole('button', { name: 'Sync to Jira' }).click();
    // WEB-1 is a seed issue of the mock, so the first one we create is WEB-2.
    const link = page.getByRole('link', { name: 'WEB-2' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', 'https://jira.example.test/browse/WEB-2');

    await row.getByRole('button', { name: 'Re-sync' }).click();
    await expect(page.getByRole('link', { name: 'WEB-2' })).toHaveCount(1);
  });

  await test.step('the defect becomes a Jira mock bug', async () => {
    await page.getByRole('link', { name: 'Defects' }).click();
    await expect(page.getByRole('heading', { name: 'Report a defect' })).toBeVisible();
    await page.getByLabel('Title').fill('Card payment fails with a valid card');
    await page.getByRole('button', { name: 'Report defect' }).click();
    await expect(page.getByRole('cell', { name: 'WEB-D-1' })).toBeVisible();

    await page
      .getByRole('row', { name: /WEB-D-1/ })
      .getByRole('button', { name: 'Sync to Jira' })
      .click();
    await expect(page.getByRole('link', { name: 'WEB-3' })).toBeVisible();
  });
});

/**
 * TestRail mock (S2-F3): the owner connects TestRail and, without leaving the
 * test-design and execution screens, pushes a case (which brings its suite),
 * a run and a result. Every sync leaves one reference behind and a re-sync
 * reuses it. The external ids are the deterministic ones of the mock seed:
 * suite 1, cases 1–2 and run 1 already exist, so ours are suite 2, case 3 and
 * run 2.
 */
test('an owner synchronizes suites, cases, runs and results with the TestRail mock', async ({
  page,
}) => {
  const suffix = `${unique}-tr`;

  await test.step('register, create the organization and connect TestRail', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill('TestRail Owner');
    await page.getByLabel('Email').fill(`e2e-testrail-${unique}@example.com`);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`TestRail ${suffix}`);
    await page.getByLabel('Slug').fill(`testrail-${suffix}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.getByRole('link', { name: 'Integrations' }).click();
    const testrail = page.getByRole('region', { name: 'TestRail' });
    await testrail.getByLabel('Base URL').fill('https://acme.testrail.test');
    await testrail.getByRole('button', { name: 'Save' }).click();
    await expect(testrail.getByRole('status')).toContainText('Configuration saved.');
    await testrail.getByRole('button', { name: 'Test connection' }).click();
    await expect(testrail.getByRole('status')).toContainText('TestRail mock');
    await testrail.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(testrail.locator('.ui-badge', { hasText: /^connected$/i })).toBeVisible();
  });

  await test.step('create a project, a suite and a case', async () => {
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Web checkout');
    await page.getByLabel('Key').fill('WEB');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'WEB', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Test cases' }).click();
    await page.getByLabel('New suite').fill('Checkout');
    await page.getByRole('button', { name: 'Add suite' }).click();
    await expect(page.getByRole('button', { name: /Checkout/ })).toBeVisible();
    await page.getByLabel('Title').fill('Pay with a valid card');
    await page.getByRole('button', { name: 'Create case' }).click();
    await expect(page.getByRole('cell', { name: 'WEB-C-1' })).toBeVisible();
  });

  await test.step('syncing the case brings its suite along', async () => {
    const row = page.getByRole('row', { name: /WEB-C-1/ });
    await row.getByRole('button', { name: 'Sync to TestRail' }).click();
    const caseLink = row.getByRole('link', { name: 'C3' });
    await expect(caseLink).toBeVisible();
    await expect(caseLink).toHaveAttribute(
      'href',
      'https://acme.testrail.test/index.php?/cases/view/3',
    );
    await expect(page.getByRole('link', { name: 'S2' })).toBeVisible();

    await row.getByRole('button', { name: 'Re-sync' }).click();
    await expect(page.getByRole('link', { name: 'C3' })).toHaveCount(1);
  });

  await test.step('the run becomes a TestRail run', async () => {
    await page.getByRole('link', { name: 'Test runs' }).click();
    await page.getByLabel('Name').fill('Release 1.0');
    await page.getByRole('button', { name: 'Create run' }).click();
    const row = page.getByRole('row', { name: /Release 1\.0/ });
    await row.getByRole('button', { name: 'Sync to TestRail' }).click();
    await expect(row.getByRole('link', { name: 'R2' })).toBeVisible();
  });

  await test.step('a recorded result is pushed and kept on re-sync', async () => {
    await page.getByRole('link', { name: 'Release 1.0' }).click();
    await page.getByRole('button', { name: 'Start run' }).click();
    await page.getByRole('button', { name: /WEB-C-1/ }).click();
    await page.getByRole('button', { name: 'passed', exact: true }).click();
    await expect(page.getByText(/Latest result: passed/)).toBeVisible();

    // Results have no key in TestRail: the reference shows the result id (the
    // seed holds one, so ours is 2) and links to the run test it belongs to.
    await page.getByRole('button', { name: 'Sync to TestRail' }).click();
    const resultLink = page.getByRole('link', { name: '2', exact: true });
    await expect(resultLink).toHaveAttribute(
      'href',
      'https://acme.testrail.test/index.php?/tests/view/3',
    );
    await page.getByRole('button', { name: 'Re-sync' }).last().click();
    await expect(resultLink).toHaveCount(1);
  });
});

/**
 * GitHub mock (S2-F4): the owner connects GitHub, links a test run to a
 * workflow run picked from the mock repository without leaving the execution
 * screen, and imports its Playwright results. Results whose `@C-n` tag matches
 * a case of the run become `TestResult` rows; the rest are reported, not
 * dropped. A second import brings nothing new.
 */
test('an owner links a run to a GitHub mock workflow run and imports its results', async ({
  page,
}) => {
  const suffix = `${unique}-gh`;

  await test.step('register, create the organization and connect GitHub', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill('GitHub Owner');
    await page.getByLabel('Email').fill(`e2e-github-${unique}@example.com`);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await page.getByLabel('Name').fill(`GitHub ${suffix}`);
    await page.getByLabel('Slug').fill(`github-${suffix}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.getByRole('link', { name: 'Integrations' }).click();
    const github = page.getByRole('region', { name: 'GitHub' });
    await github.getByRole('button', { name: 'Save' }).click();
    await expect(github.getByRole('status')).toContainText('Configuration saved.');
    await github.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(github.locator('.ui-badge', { hasText: /^connected$/i })).toBeVisible();
  });

  await test.step('create a project with two cases and a run', async () => {
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByLabel('Name').fill('Web checkout');
    await page.getByLabel('Key').fill('WEB');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('cell', { name: 'WEB', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Test cases' }).click();
    await page.getByLabel('New suite').fill('Checkout');
    await page.getByRole('button', { name: 'Add suite' }).click();
    await expect(page.getByRole('button', { name: /Checkout/ })).toBeVisible();
    await page.getByLabel('Title').fill('Pay with a valid card');
    await page.getByRole('button', { name: 'Create case' }).click();
    await expect(page.getByRole('cell', { name: 'WEB-C-1' })).toBeVisible();
    await page.getByLabel('Title').fill('Reject an expired card');
    await page.getByRole('button', { name: 'Create case' }).click();
    await expect(page.getByRole('cell', { name: 'WEB-C-2' })).toBeVisible();

    await page.getByRole('link', { name: 'Test runs' }).click();
    await page.getByLabel('Name').fill('Nightly');
    await page.getByRole('button', { name: 'Create run' }).click();
    const row = page.getByRole('row', { name: /Nightly/ });
    await expect(row.getByText('—')).toBeVisible();
    await page.getByRole('link', { name: 'Nightly' }).click();
    await page.getByRole('button', { name: 'Start run' }).click();
  });

  const panel = page.getByRole('region', { name: 'GitHub workflow run' });

  await test.step('pick a workflow run of the mock repository and link it', async () => {
    await expect(panel.getByText('No workflow run linked.')).toBeVisible();
    await panel.getByRole('button', { name: 'Link workflow run' }).click();
    await panel.getByLabel('Repository').selectOption({ label: 'acme/web-checkout' });
    await panel.getByLabel('Workflow run').selectOption('1001');
    await panel.getByRole('button', { name: 'Link', exact: true }).click();

    const link = panel.getByRole('link', { name: 'acme/web-checkout#41' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute(
      'href',
      'https://github.example.com/acme/web-checkout/actions/runs/1001',
    );
    await expect(panel.locator('.ui-badge', { hasText: 'success' })).toBeVisible();
    await expect(panel.getByText(/Playwright E2E · main @/)).toBeVisible();
  });

  await test.step('import brings the tagged results and reports the rest', async () => {
    await panel.getByRole('button', { name: 'Import results' }).click();
    const report = panel.getByRole('status');
    await expect(report).toContainText('Imported 2 results, skipped 2.');
    await expect(report).toContainText('case is not part of this run');
    await expect(report).toContainText('no @C-n tag in the title');

    await page.getByRole('button', { name: /WEB-C-1/ }).click();
    await expect(page.getByText(/Latest result: passed/)).toBeVisible();
    await expect(page.getByText(/From GitHub:/)).toBeVisible();
    await expect(
      page.getByRole('link', {
        name: /playwright · e2e\/checkout\.spec\.ts › checkout › pays with a valid card @C-1/,
      }),
    ).toBeVisible();
  });

  await test.step('a second import is a no-op and the runs table shows the link', async () => {
    await panel.getByRole('button', { name: 'Import results' }).click();
    await expect(panel.getByRole('status')).toContainText('Imported 0 results, skipped 4.');
    await expect(panel.getByRole('status')).toContainText('already imported');

    await page.getByRole('link', { name: 'Back to runs' }).click();
    const row = page.getByRole('row', { name: /Nightly/ });
    await expect(row.getByRole('link', { name: 'acme/web-checkout#41' })).toBeVisible();
  });
});
