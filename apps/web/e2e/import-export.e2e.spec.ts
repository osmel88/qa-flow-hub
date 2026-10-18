import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Download, Page } from '@playwright/test';

/**
 * Import & Export (S3-F1): a dry run that reports a broken row by row and
 * column and refuses to import it, the corrected file imported atomically with
 * its steps and requirement link, a TestRail export file (no connection to
 * TestRail), the three CSV exports, the printable views, and a viewer who can
 * export but is never offered the import.
 */
const unique = Date.now();
const owner = {
  email: `e2e-import-owner-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Import Owner',
};
const viewer = {
  email: `e2e-import-viewer-${unique}@example.com`,
  password: 'Str0ngPassword!',
  fullName: 'Import Viewer',
};

const BROKEN_CSV = [
  'ref,title,priority,references,step_action,step_expected',
  'A,Lo,high,IMP-R-1,Open the login page,The form is shown',
  '',
].join('\n');
const FIXED_CSV = [
  'ref,title,section,priority,references,step_action,step_expected',
  'A,Login with a valid password,Auth > Password,high,IMP-R-1,Open the login page,The form is shown',
  'A,,,,,Submit valid credentials,The dashboard opens',
  'B,Login with a wrong password,Auth > Password,medium,,Submit a wrong password,An error is shown',
  '',
].join('\n');

async function uploadAndDryRun(page: Page, name: string, contents: string | Buffer): Promise<void> {
  await page.getByLabel('CSV file').setInputFiles({
    name,
    mimeType: 'text/csv',
    buffer: typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents,
  });
  await page.getByRole('button', { name: 'Run dry run' }).click();
}

async function readDownload(download: Download): Promise<string> {
  const path = await download.path();
  return readFile(path, 'utf8');
}

test('dry run, atomic import, TestRail file, CSV exports and printable views', async ({
  browser,
}) => {
  const ownerPage = await (await browser.newContext()).newPage();
  const viewerPage = await (await browser.newContext()).newPage();
  let token = '';

  await test.step('the owner sets up an organization, a project and a requirement', async () => {
    await ownerPage.goto('/register');
    await ownerPage.getByLabel('Full name').fill(owner.fullName);
    await ownerPage.getByLabel('Email').fill(owner.email);
    await ownerPage.getByLabel('Password').fill(owner.password);
    await ownerPage.getByRole('button', { name: 'Create account' }).click();
    await expect(ownerPage.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await ownerPage.getByLabel('Name').fill(`Import ${unique}`);
    await ownerPage.getByLabel('Slug').fill(`import-${unique}`);
    await ownerPage.getByRole('button', { name: 'Create' }).click();
    await expect(ownerPage.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await ownerPage.getByRole('link', { name: 'Projects' }).click();
    await ownerPage.getByLabel('Name').fill('Imports');
    await ownerPage.getByLabel('Key').fill('IMP');
    await ownerPage.getByRole('button', { name: 'Create project' }).click();
    await expect(ownerPage.getByRole('cell', { name: 'IMP', exact: true })).toBeVisible();

    await ownerPage.getByRole('link', { name: 'Requirements' }).click();
    await ownerPage.getByLabel('Title').fill('Users sign in with a password');
    await ownerPage.getByRole('button', { name: 'Create requirement' }).click();
    await expect(ownerPage.getByRole('cell', { name: 'IMP-R-1' })).toBeVisible();
  });

  await test.step('a broken file is reported by row and column and cannot be imported', async () => {
    await ownerPage.getByRole('link', { name: 'Test cases' }).click();
    await ownerPage.getByRole('link', { name: 'Import CSV' }).click();
    await expect(ownerPage.getByRole('heading', { name: 'Import test cases' })).toBeVisible();
    await uploadAndDryRun(ownerPage, 'broken.csv', BROKEN_CSV);

    const report = ownerPage.getByRole('region', { name: 'Dry run report' });
    await expect(report.getByText('invalid', { exact: true })).toBeVisible();
    const issue = report.getByRole('table', { name: 'Import issues' }).getByRole('row').nth(1);
    await expect(issue).toContainText('2');
    await expect(issue).toContainText('title');
    await expect(issue).toContainText('TOO_SHORT');
    await expect(report.getByRole('button', { name: /^Import \d+ test cases$/ })).toBeDisabled();
  });

  await test.step('the corrected file imports cases, steps, sections and the link at once', async () => {
    await uploadAndDryRun(ownerPage, 'fixed.csv', FIXED_CSV);
    const report = ownerPage.getByRole('region', { name: 'Dry run report' });
    await expect(report.getByText('ready', { exact: true })).toBeVisible();
    await expect(report).toContainText('2 new cases, 3 steps');
    await report.getByRole('button', { name: 'Import 2 test cases' }).click();
    await expect(ownerPage.getByRole('status')).toContainText('Imported 2 test cases with 3 steps');

    const history = ownerPage.getByRole('table', { name: 'Import history' });
    await expect(history.getByRole('row', { name: /fixed\.csv/ })).toContainText('committed');
    await expect(history.getByRole('row', { name: /broken\.csv/ })).toContainText('invalid');

    await ownerPage
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Test cases' })
      .click();
    await ownerPage
      .getByRole('button', { name: /Imported/ })
      .first()
      .click();
    await ownerPage.getByRole('link', { name: 'Login with a valid password' }).click();
    await expect(ownerPage.getByLabel('Step 2 action')).toHaveValue('Submit valid credentials');
  });

  await test.step('importing the same file again creates nothing', async () => {
    await ownerPage.goto('/imports');
    await uploadAndDryRun(ownerPage, 'fixed.csv', FIXED_CSV);
    const report = ownerPage.getByRole('region', { name: 'Dry run report' });
    await expect(report).toContainText('0 new cases');
    await expect(report).toContainText('2 duplicates skipped');
  });

  await test.step('a TestRail export file is imported without any TestRail connection', async () => {
    await ownerPage.getByLabel('Format').selectOption('testrail_csv');
    await ownerPage.getByLabel('Suite name').fill('TestRail');
    const fixture = await readFile(new URL('./fixtures/testrail-export.csv', import.meta.url));
    await uploadAndDryRun(ownerPage, 'testrail-export.csv', fixture);
    const report = ownerPage.getByRole('region', { name: 'Dry run report' });
    await expect(report.getByText('ready', { exact: true })).toBeVisible();
    await expect(report.getByRole('table', { name: 'Import issues' })).toContainText(
      'Custom Browser',
    );
    await report.getByRole('button', { name: 'Import 2 test cases' }).click();
    await expect(ownerPage.getByRole('status')).toContainText('Imported 2 test cases with 3 steps');
  });

  await test.step('the owner downloads the test cases and the matrix as CSV', async () => {
    await ownerPage
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Test cases' })
      .click();
    const [cases] = await Promise.all([
      ownerPage.waitForEvent('download'),
      ownerPage.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    expect(cases.suggestedFilename()).toMatch(/^imp-test-cases-.*\.csv$/i);
    const casesCsv = await readDownload(cases);
    expect(casesCsv).toContain('Login with a valid password');
    expect(casesCsv).toContain('Checkout with card');

    await ownerPage.getByRole('link', { name: 'Traceability' }).click();
    await expect(ownerPage.getByText('1 of 1 covered')).toBeVisible();
    const [matrix] = await Promise.all([
      ownerPage.waitForEvent('download'),
      ownerPage.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    const matrixCsv = await readDownload(matrix);
    expect(matrixCsv).toContain('IMP-R-1');
    expect(matrixCsv).toContain('Checkout with card');
  });

  await test.step('the printable matrix opens without the app chrome', async () => {
    const [printable] = await Promise.all([
      ownerPage.context().waitForEvent('page'),
      ownerPage.getByRole('link', { name: 'Printable view' }).click(),
    ]);
    await expect(
      printable.getByRole('heading', { name: 'Traceability matrix — Imports' }),
    ).toBeVisible();
    await expect(printable.getByRole('table', { name: 'Traceability matrix' })).toContainText(
      'IMP-R-1',
    );
    await expect(printable.getByRole('button', { name: 'Print / Save as PDF' })).toBeVisible();
    await expect(printable.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await printable.close();
  });

  await test.step('a run exports its snapshot as CSV and as a printable summary', async () => {
    await ownerPage.getByRole('link', { name: 'Test runs' }).click();
    await ownerPage.getByLabel('Name').fill('Imported regression');
    await ownerPage.getByRole('button', { name: 'Create run' }).click();
    await ownerPage.getByRole('link', { name: 'Imported regression' }).click();
    const [run] = await Promise.all([
      ownerPage.waitForEvent('download'),
      ownerPage.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    const runCsv = await readDownload(run);
    expect(runCsv.split('\r\n')[0]).toContain('key,title,priority,type,case_version,status');
    expect(runCsv).toContain('Login with a valid password');

    const [printable] = await Promise.all([
      ownerPage.context().waitForEvent('page'),
      ownerPage.getByRole('link', { name: 'Printable view' }).click(),
    ]);
    await expect(
      printable.getByRole('heading', { name: 'Test run — Imported regression' }),
    ).toBeVisible();
    await expect(printable.getByRole('table', { name: 'Run cases' })).toContainText(
      'Refund an order',
    );
    await printable.close();
  });

  await test.step('the owner invites a viewer', async () => {
    await ownerPage.getByRole('link', { name: 'Members' }).click();
    await ownerPage.getByLabel('Email').fill(viewer.email);
    await ownerPage.getByLabel('Role', { exact: true }).selectOption('viewer');
    await ownerPage.getByRole('button', { name: 'Send invitation' }).click();
    const issued = ownerPage.getByRole('status').locator('code');
    await expect(issued).toBeVisible();
    token = (await issued.textContent()) ?? '';
    expect(token.length).toBeGreaterThan(20);
  });

  await test.step('the viewer can export but is never offered the import', async () => {
    await viewerPage.goto('/register');
    await viewerPage.getByLabel('Full name').fill(viewer.fullName);
    await viewerPage.getByLabel('Email').fill(viewer.email);
    await viewerPage.getByLabel('Password').fill(viewer.password);
    await viewerPage.getByRole('button', { name: 'Create account' }).click();
    await expect(viewerPage.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await viewerPage.getByLabel('Invitation token').fill(token);
    await viewerPage.getByRole('button', { name: 'Join' }).click();
    await expect(viewerPage.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await expect(viewerPage.getByRole('option', { name: 'No projects yet' })).toHaveCount(1);

    await ownerPage.getByRole('link', { name: 'Project access' }).click();
    const access = ownerPage.getByRole('row', { name: new RegExp(viewer.email) });
    await expect(access).toContainText('No access');
    await ownerPage
      .getByLabel(`Set the project role of ${viewer.email}`)
      .selectOption({ label: 'Access with their organization role' });
    await expect(access).toContainText('Inherited');
    await viewerPage.reload();
    await expect(viewerPage.getByRole('option', { name: 'No projects yet' })).toHaveCount(0);

    await viewerPage
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Test cases' })
      .click();
    await expect(viewerPage.getByRole('button', { name: 'Export CSV' })).toBeVisible();
    await expect(viewerPage.getByRole('link', { name: 'Import CSV' })).toHaveCount(0);
    const [cases] = await Promise.all([
      viewerPage.waitForEvent('download'),
      viewerPage.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    expect(await readDownload(cases)).toContain('Refund an order');

    await viewerPage.goto('/imports');
    await expect(viewerPage.getByText(/do not have permission to import/)).toBeVisible();
    await expect(viewerPage.getByLabel('CSV file')).toHaveCount(0);
  });
});
