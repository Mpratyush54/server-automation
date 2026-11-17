// Clip: deploy an app from Git.
//
// Creates a project from a repository in the new-project wizard
// (platform/portal/src/app/pages/new-project), deploys a branch to
// production from the project page and opens the running app.
//
// Env: CAIRN_URL + sign-in (see README), APP_REPO_URL (a repository with a
// k8s/ folder: a Deployment and a Service on port 80, image already built),
// optional APP_BRANCH (main), APP_NAME (unique, default cairn-demo-<time>),
// APP_EXPECT_TEXT (text the app's page shows, to prove it is live),
// APP_PATH (folder with the deploy files when it is not k8s/).
import { cairnUrl, env } from '../lib/config.mjs';
import { Recording, beat, click, response, type } from '../lib/recorder.mjs';

export async function record() {
  const repo = env('APP_REPO_URL', { required: true });
  const branch = env('APP_BRANCH', { fallback: 'main' });
  const name = env('APP_NAME', { fallback: `cairn-demo-${Date.now().toString(36).slice(-5)}` });
  const expect = env('APP_EXPECT_TEXT');
  const appPath = env('APP_PATH');

  const rec = await Recording.open('deploy-from-git');
  try {
    const page = rec.page();
    await page.goto(`${cairnUrl()}/projects/new`);
    await page.getByRole('heading', { name: 'Name your app' }).waitFor();
    rec.mark('start');
    await beat(800);

    // 1. Name the app; the wizard checks the name is free.
    await type(page, page.getByTestId('np-name'), name);
    await page.getByText(`${name} is available`).waitFor();
    rec.mark('named');
    await click(page, page.getByTestId('np-next'));

    // 2. Connect the code.
    await page.getByRole('heading', { name: 'Connect the code' }).waitFor();
    await type(page, page.getByLabel('Repository address', { exact: true }), repo);
    await type(page, page.getByLabel('Branch to deploy', { exact: true }), branch);
    rec.mark('repo');
    await beat(500);

    // 3. Keep the defaults on the remaining steps until the review.
    const review = page.getByRole('heading', { name: 'Review and create' });
    for (let step = 0; step < 6 && !(await review.isVisible()); step++) {
      const next = page.getByTestId('np-next');
      await next.waitFor();
      await page.waitForFunction((el) => !el.disabled, await next.elementHandle());
      await click(page, next);
      await beat(350);
    }
    await review.waitFor();
    rec.mark('review');
    await beat(900);

    // 4. Create the project.
    const created = response(page, /\/api\/projects(\?|$)/, { status: [200, 201] });
    await click(page, page.getByTestId('np-create'));
    await created;
    await page.getByRole('heading', { name: `${name} is ready` }).waitFor({ timeout: 180_000 });
    rec.mark('created');
    await beat(900);

    // 5. Deploy the branch to production from the project page.
    await click(page, page.getByRole('link', { name: 'Open project and deploy', exact: true }));
    const form = page.locator('#deploy-form');
    if (!(await form.isVisible())) await click(page, page.getByRole('button', { name: 'Deploy', exact: true }).first());
    await form.waitFor();
    await page.locator('#deploy-env').selectOption({ label: 'production' });
    const branchField = page.locator('#deploy-branch');
    // The field is a text input until the repository's branches load, then a list.
    await page.waitForFunction(() => document.querySelector('#deploy-branch')?.tagName === 'SELECT', null, { timeout: 20_000 }).catch(() => {});
    if ((await branchField.evaluate((el) => el.tagName)) === 'SELECT') await branchField.selectOption(branch);
    else await type(page, branchField, branch);
    // The form defaults to "k8s"; a repository that keeps its files elsewhere names the folder.
    // It sits under the form's "Advanced" disclosure.
    if (appPath) {
      const advanced = form.locator('details.advanced');
      if (!(await advanced.evaluate((el) => el.open))) await click(page, advanced.locator('summary'));
      await type(page, page.locator('#deploy-path'), appPath);
    }
    const deployButton = form.getByRole('button', { name: 'Deploy', exact: true });
    await page.waitForFunction((el) => !el.disabled, await deployButton.elementHandle(), { timeout: 60_000 });
    rec.mark('deploy-form');
    const deployed = response(page, '/api/deploy', { status: [200, 201, 202] });
    await click(page, deployButton);
    await deployed;
    rec.mark('deploying');

    // 6. Wait for the deployment to turn healthy (cut: image pull and sync take a while).
    const history = page.locator('section[aria-labelledby="history-title"]');
    await rec.cut('sync', () => history.getByRole('row').nth(1).getByText('Deployed', { exact: true }).waitFor({ timeout: 600_000 }));
    rec.mark('deployed');
    await beat(1500);

    // 7. Open the app at its address.
    // The heading says "production" in the DOM and is capitalised by CSS: match either.
    const envItem = page.locator('#environments .env-item').filter({ has: page.getByRole('heading', { name: /^production$/i }) });
    const address = await envItem.locator('dd a.mono').first().getAttribute('href');
    await click(page, envItem.locator('dd a.mono').first());
    // The link opens a new tab; show the app in this recorded page instead.
    for (const other of page.context().pages()) if (other !== page) await other.close();
    await page.goto(address);
    if (expect) await page.getByText(expect).first().waitFor({ timeout: 60_000 });
    else await page.waitForLoadState('load');
    rec.mark('live');
    await beat(2500);
    rec.mark('end');
    await rec.close({ project: name });
  } catch (error) {
    await rec.abort();
    throw error;
  }
}
