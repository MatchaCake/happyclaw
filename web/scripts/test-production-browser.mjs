// Run after deploying, with an authorized short-lived session in a private file:
// HAPPYCLAW_URL=https://example.com/ HAPPYCLAW_ACCEPTANCE_COOKIE_FILE=/private/cookie \
//   node web/scripts/test-production-browser.mjs
// The file contains the complete Cookie header value (an optional Cookie: prefix
// is accepted). No credentials, page contents, screenshots, traces or videos are
// recorded. Only one guarded same-value appearance save can reach the server.
import { readFile, stat } from 'node:fs/promises';

const report = {
  passed: false,
  checks: {
    inputs: false,
    loginBrand: false,
    loginTitle: false,
    loginLogosLoaded: false,
    authenticatedSidebarBrand: false,
    appearanceSameValue: false,
    appearancePendingControls: false,
    appearanceActualApi: false,
    balancingKeyboard: false,
    balancingLabels: false,
    balancingDraftOnly: false,
    balancingRestored: false,
    noUnexpectedWrites: false,
    noPageErrors: false,
    noFailedStaticResources: false,
  },
  counts: {
    cookies: 0,
    loginLogos: 0,
    sidebarLogos: 0,
    logoUploadButtons: 0,
    pendingDisabledButtons: 0,
    appearanceWriteRequests: 0,
    appearanceWritesReleased: 0,
    blockedWriteRequests: 0,
    routeErrors: 0,
    configWriteRequestsDuringDrafts: 0,
    numericDraftsChecked: 0,
    pageErrors: 0,
    staticResponses: 0,
    failedStaticResources: 0,
  },
};

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const appearanceMethods = new Set(['POST', 'PUT', 'PATCH']);
const staticTypes = new Set([
  'script',
  'stylesheet',
  'image',
  'font',
  'manifest',
]);
const contexts = [];
let browser;
let finishHeldSave;

function requireCondition(condition) {
  if (!condition) throw new Error('Acceptance check failed');
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within(promise, timeoutMs = 3000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Acceptance check timed out')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function run() {
  // Playwright debug traces can include cookie headers and DOM input values.
  delete process.env.DEBUG;
  delete process.env.PWDEBUG;
  const { chromium, expect: baseExpect } = await import('@playwright/test');
  const expect = baseExpect.configure({ timeout: 15000 });

  const target = process.env.HAPPYCLAW_URL;
  const cookieFile = process.env.HAPPYCLAW_ACCEPTANCE_COOKIE_FILE;
  requireCondition(Boolean(target && cookieFile));
  const base = new URL(target);
  requireCondition(
    ['https:', 'http:'].includes(base.protocol) &&
      !base.username &&
      !base.password &&
      !base.search &&
      !base.hash,
  );
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const appUrl = (path) => new URL(path.replace(/^\/+/, ''), base).href;
  const file = await stat(cookieFile);
  requireCondition(
    file.isFile() &&
      file.size > 0 &&
      file.size <= 65536 &&
      !(file.mode & 0o077),
  );
  const header = (await readFile(cookieFile, 'utf8'))
    .trim()
    .replace(/^Cookie:\s*/i, '');
  requireCondition(Boolean(header) && !/[\r\n\0]/.test(header));
  const cookies = header.split(';').map((part) => {
    const separator = part.indexOf('=');
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    requireCondition(
      separator > 0 && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name),
    );
    return {
      name,
      value,
      url: `${base.origin}/`,
      httpOnly: true,
      secure: base.protocol === 'https:',
      sameSite: 'Lax',
    };
  });
  requireCondition(
    new Set(cookies.map(({ name }) => name)).size === cookies.length,
  );
  report.counts.cookies = cookies.length;
  report.checks.inputs = true;

  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });

  async function context() {
    const result = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: 'block',
    });
    result.setDefaultTimeout(15000);
    result.setDefaultNavigationTimeout(30000);
    contexts.push(result);
    return result;
  }

  function observe(page) {
    page.on('pageerror', () => report.counts.pageErrors++);
    page.on('response', (response) => {
      if (!staticTypes.has(response.request().resourceType())) return;
      report.counts.staticResponses++;
      if (response.status() >= 400) report.counts.failedStaticResources++;
    });
    page.on('requestfailed', (request) => {
      if (staticTypes.has(request.resourceType())) {
        report.counts.failedStaticResources++;
      }
    });
  }

  async function getJson(context, path) {
    const response = await context.request.get(appUrl(path), {
      timeout: 15000,
    });
    requireCondition(response.ok());
    return response.json();
  }

  function safelyRoute(handler) {
    return async (route) => {
      try {
        await handler(route);
      } catch {
        report.counts.routeErrors++;
        await route.abort('blockedbyclient').catch(() => {});
      }
    };
  }

  async function verifyLoadedImages(locator, expectedUrl) {
    const count = await locator.count();
    requireCondition(count > 0);
    for (let index = 0; index < count; index++) {
      const image = locator.nth(index);
      await expect
        .poll(() =>
          image.evaluate(
            (element) => element.complete && element.naturalWidth > 0,
          ),
        )
        .toBe(true);
      requireCondition(
        (await image.evaluate((element) => element.currentSrc)) === expectedUrl,
      );
    }
    return count;
  }

  const publicContext = await context();
  await publicContext.route(
    '**/*',
    safelyRoute(async (route) => {
      if (!safeMethods.has(route.request().method())) {
        report.counts.blockedWriteRequests++;
        await route.abort('blockedbyclient');
      } else {
        await route.continue();
      }
    }),
  );
  const publicAppearance = await getJson(
    publicContext,
    '/api/config/appearance/public',
  );
  requireCondition(typeof publicAppearance.appName === 'string');
  const appName = publicAppearance.appName.trim() || 'HappyClaw';
  const iconUrl = appUrl(
    publicAppearance.brandIconUrl || '/icons/icon-192.png',
  );
  const login = await publicContext.newPage();
  observe(login);
  await login.goto(appUrl('/login'), { waitUntil: 'networkidle' });
  await expect(
    login.locator('header').getByText(appName, { exact: true }),
  ).toBeVisible();
  report.checks.loginBrand = true;
  await expect(login).toHaveTitle(appName);
  report.checks.loginTitle = true;
  report.counts.loginLogos = await verifyLoadedImages(
    login.getByRole('img', { name: appName, exact: true }),
    iconUrl,
  );
  requireCondition(report.counts.loginLogos >= 2);
  report.checks.loginLogosLoaded = true;

  const authenticated = await context();
  await authenticated.addCookies(cookies);
  const originalAppearance = await getJson(
    authenticated,
    '/api/config/appearance',
  );
  requireCondition(
    originalAppearance.appName === publicAppearance.appName &&
      originalAppearance.brandIconUrl === publicAppearance.brandIconUrl &&
      originalAppearance.brandBannerUrl === publicAppearance.brandBannerUrl,
  );
  const saveCaptured = deferred();
  const saveDecision = deferred();
  finishHeldSave = () => saveDecision.resolve(false);
  let allowAppearanceSave = false;
  let draftPhase = false;
  const appearancePath = new URL(appUrl('/api/config/appearance')).pathname;

  await authenticated.route(
    '**/*',
    safelyRoute(async (route) => {
      const request = route.request();
      if (safeMethods.has(request.method())) {
        await route.continue();
        return;
      }
      const url = new URL(request.url());
      if (draftPhase && url.pathname.includes('/api/config/')) {
        report.counts.configWriteRequestsDuringDrafts++;
      }
      let sameValueSave = false;
      if (
        allowAppearanceSave &&
        url.origin === base.origin &&
        url.pathname === appearancePath &&
        !url.search &&
        appearanceMethods.has(request.method())
      ) {
        try {
          const body = request.postDataJSON();
          sameValueSave =
            Object.keys(body).length === 1 &&
            body.appName === originalAppearance.appName &&
            body.appName === originalAppearance.appName.trim();
        } catch {
          // Malformed or extra fields cannot reach the production write endpoint.
        }
      }
      if (!sameValueSave) {
        report.counts.blockedWriteRequests++;
        await route.abort('blockedbyclient');
        return;
      }
      allowAppearanceSave = false;
      report.counts.appearanceWriteRequests++;
      saveCaptured.resolve();
      // Gate the genuine outbound request, not a fabricated successful response.
      // Failed pending assertions release it as an abort in finally.
      const released = await within(saveDecision.promise, 6000).catch(
        () => false,
      );
      if (released) {
        // Refuse a stale same-value save if another administrator changed the
        // appearance between reading the page and releasing the held request.
        const latest = await getJson(authenticated, '/api/config/appearance');
        if (JSON.stringify(latest) !== JSON.stringify(originalAppearance)) {
          report.counts.blockedWriteRequests++;
          await route.abort('blockedbyclient');
          return;
        }
        report.counts.appearanceWritesReleased++;
        await route.continue();
      } else {
        await route.abort('blockedbyclient');
      }
    }),
  );

  const page = await authenticated.newPage();
  observe(page);
  await page.goto(appUrl('/settings?tab=appearance'), {
    waitUntil: 'networkidle',
  });
  report.counts.sidebarLogos = await verifyLoadedImages(
    page.locator('nav').getByRole('img', { name: appName, exact: true }),
    iconUrl,
  );
  report.checks.authenticatedSidebarBrand = true;
  const nameInput = page.getByLabel('名称', { exact: true });
  await expect(nameInput).toHaveValue(originalAppearance.appName);
  const saveButton = page.getByRole('button', {
    name: '保存系统品牌',
    exact: true,
  });
  const logoUploads = page.getByRole('button', {
    name: '上传图片',
    exact: true,
  });
  const logoResets = page.getByRole('button', {
    name: '恢复默认',
    exact: true,
  });
  await expect(saveButton).toBeEnabled();
  await expect(logoUploads).toHaveCount(2);
  for (let index = 0; index < 2; index++) {
    await expect(logoUploads.nth(index)).toBeEnabled();
  }
  report.counts.logoUploadButtons = 2;
  report.checks.appearanceSameValue = true;
  const saveResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).origin === base.origin &&
      new URL(response.url()).pathname === appearancePath &&
      appearanceMethods.has(response.request().method()),
    { timeout: 15000 },
  );
  // Handle timeout rejections even if an earlier pending-state assertion fails.
  saveResponse.catch(() => {});
  allowAppearanceSave = true;
  await saveButton.click();
  await within(saveCaptured.promise);
  await expect(saveButton).toBeDisabled({ timeout: 1000 });
  report.counts.pendingDisabledButtons++;
  for (let index = 0; index < 2; index++) {
    await expect(logoUploads.nth(index)).toBeDisabled({ timeout: 1000 });
    report.counts.pendingDisabledButtons++;
  }
  for (let index = 0; index < (await logoResets.count()); index++) {
    await expect(logoResets.nth(index)).toBeDisabled({ timeout: 1000 });
    report.counts.pendingDisabledButtons++;
  }
  report.checks.appearancePendingControls = true;
  saveDecision.resolve(true);
  const response = await saveResponse;
  requireCondition(response.ok());
  const saved = await response.json();
  const currentAppearance = await getJson(
    authenticated,
    '/api/config/appearance',
  );
  requireCondition(
    JSON.stringify(saved) === JSON.stringify(originalAppearance) &&
      JSON.stringify(currentAppearance) === JSON.stringify(originalAppearance),
  );
  await expect(saveButton).toBeEnabled();
  await expect(nameInput).toHaveValue(originalAppearance.appName);
  report.checks.appearanceActualApi = true;

  const originalProviders = await getJson(
    authenticated,
    '/api/config/claude/providers',
  );
  requireCondition(
    originalProviders.providers?.length >= 2 && originalProviders.balancing,
  );
  await page.goto(appUrl('/settings?tab=claude'), { waitUntil: 'networkidle' });
  const toggle = page.getByRole('button', { name: /负载均衡设置/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAttribute(
    'aria-controls',
    'balancing-settings-panel',
  );
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await toggle.press('Enter');
  const panel = page.getByRole('region', { name: '负载均衡设置', exact: true });
  await expect(panel).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toHaveCount(0);
  await toggle.press('Space');
  await expect(panel).toBeVisible();
  report.checks.balancingKeyboard = true;
  const strategy = panel.getByLabel('策略', { exact: true });
  const threshold = panel.getByLabel('不健康阈值（连续失败次数）', {
    exact: true,
  });
  const recovery = panel.getByLabel('自动恢复间隔（秒）', { exact: true });
  await expect(strategy).toBeEnabled();
  await expect(threshold).toBeEnabled();
  await expect(recovery).toBeEnabled();
  requireCondition(
    (await threshold.getAttribute('type')) === 'number' &&
      (await recovery.getAttribute('type')) === 'number',
  );
  report.checks.balancingLabels = true;
  draftPhase = true;
  for (const input of [threshold, recovery]) {
    const original = await input.inputValue();
    const minimum = Number(await input.getAttribute('min'));
    const maximum = Number(await input.getAttribute('max'));
    const changed =
      Number(original) === maximum ? minimum : Number(original) + 1;
    await input.focus();
    await input.fill(String(changed));
    await expect(input).toHaveValue(String(changed));
    await expect(input).toBeFocused();
    // Observe real debounced/autosave behaviour without blur or Enter, then
    // restore the draft before focus moves anywhere that could commit it.
    await page.waitForTimeout(1200);
    requireCondition(report.counts.configWriteRequestsDuringDrafts === 0);
    await input.fill(original);
    await expect(input).toHaveValue(original);
    await input.press('Tab');
    await page.waitForTimeout(300);
    requireCondition(report.counts.configWriteRequestsDuringDrafts === 0);
    report.counts.numericDraftsChecked++;
  }
  report.checks.balancingDraftOnly = true;
  const currentProviders = await getJson(
    authenticated,
    '/api/config/claude/providers',
  );
  requireCondition(
    JSON.stringify(currentProviders.balancing) ===
      JSON.stringify(originalProviders.balancing),
  );
  await expect(threshold).toHaveValue(
    String(originalProviders.balancing.unhealthyThreshold),
  );
  await expect(recovery).toHaveValue(
    String(Math.round(originalProviders.balancing.recoveryIntervalMs / 1000)),
  );
  report.checks.balancingRestored = true;
  report.checks.noUnexpectedWrites =
    report.counts.blockedWriteRequests === 0 &&
    report.counts.routeErrors === 0 &&
    report.counts.appearanceWriteRequests === 1 &&
    report.counts.appearanceWritesReleased === 1 &&
    report.counts.configWriteRequestsDuringDrafts === 0;
}

try {
  await run();
} catch {
  // Browser and assertion errors can embed input values, URLs or private DOM.
  // Deliberately emit only the fixed check names with booleans and counts.
} finally {
  finishHeldSave?.();
  await Promise.allSettled(contexts.map((context) => context.close()));
  await browser?.close().catch(() => {});
  report.checks.noPageErrors = report.counts.pageErrors === 0;
  report.checks.noFailedStaticResources =
    report.counts.staticResponses > 0 &&
    report.counts.failedStaticResources === 0;
  report.passed = Object.values(report.checks).every(Boolean);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}
