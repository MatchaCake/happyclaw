// Real deployed Web chat acceptance. Creates one disposable managed AgentProfile
// and host workspace, sends four short real-provider turns, then removes only
// resources whose IDs were returned by this run's creation calls.
// HAPPYCLAW_URL=https://example.com/ HAPPYCLAW_ACCEPTANCE_COOKIE_FILE=/private/cookie \
//   node web/scripts/test-production-chat-usage.mjs
// Output contains only booleans/counts. No screenshots, traces, videos, messages,
// model names, usage values, user identities or credentials are recorded.
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

const caseNames = ['mainCold', 'mainWarm', 'sessionCold', 'sessionWarm'];
const caseChecks = () => ({
  finalReceived: false,
  authoritativeRestUsage: false,
  finalBubbleFound: false,
  usageVisible: false,
  exactUsageMatchesRest: false,
  displayedTotalMatchesRest: false,
  tooltipMatchesRest: false,
  immutableUsageTurnMatches: false,
  priorUsageUnchanged: false,
  withoutReload: false,
  warmInputToActiveRunner: false,
});
const report = {
  passed: false,
  checks: {
    inputs: false,
    authorizedOwner: false,
    managedProfile: false,
    ownedWorkspace: false,
    independentSession: false,
    noUnexpectedWrites: false,
    noPageErrors: false,
    noFailedStaticResources: false,
    cleanup: false,
  },
  cases: Object.fromEntries(caseNames.map((name) => [name, caseChecks()])),
  counts: {
    profilesCreated: 0,
    workspacesCreated: 0,
    sessionsCreated: 0,
    uiMessagesSent: 0,
    finalsReceived: 0,
    restUsagesFound: 0,
    visibleUsageBadges: 0,
    exactUsageMatches: 0,
    tooltipsChecked: 0,
    warmInputsToActiveRunners: 0,
    usageEvents: 0,
    matchingImmutableUsageEvents: 0,
    heldHistoryRequests: 0,
    blockedBrowserWrites: 0,
    pageErrors: 0,
    failedStaticResources: 0,
    documentRequests: 0,
    workspacesRemoved: 0,
    profilesRemoved: 0,
    cleanupFailures: 0,
  },
};

const nonce = `CHAT_USAGE_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const ownedWorkspaces = [];
const ownFrames = [];
const historyGates = [];
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const staticTypes = new Set([
  'script',
  'stylesheet',
  'image',
  'font',
  'manifest',
]);
let profileId;
let sessionId;
let browser;
let context;
let page;
let api;
let activeSend;
let holdHistory = false;
let closing = false;

function requireCondition(condition) {
  if (!condition) throw new Error('Chat acceptance check failed');
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate, timeoutMs = 180000, pollMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

function releaseHistory() {
  holdHistory = false;
  for (const gate of historyGates.splice(0)) gate.resolve();
}

function parseUsage(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function tokenCount(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function tokenBreakdown(usage) {
  // The five root classes are the authority used by token-usage-presentation.
  // modelUsage already breaks down those tokens; it must not be added again.
  const keys = [
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
    'reasoningTokens',
  ];
  const result = Object.fromEntries(
    keys.map((key) => [key, tokenCount(usage[key])]),
  );
  result.total = keys.reduce((sum, key) => sum + result[key], 0);
  return result;
}

function formatNum(number) {
  if (number >= 1000000) return `${(number / 1000000).toFixed(1)}M`;
  if (number >= 1000) return `${(number / 1000).toFixed(1)}K`;
  return String(number);
}

function normalizeText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function bubbleRow(marker) {
  // A user's prompt contains the marker but is not equal to it. Scope the
  // exact final text to its virtual message row, excluding sidebar previews.
  return page
    .locator('[data-index]')
    .filter({ has: page.getByText(marker, { exact: true }) });
}

async function renderedMessage(marker) {
  const rows = bubbleRow(marker);
  if ((await rows.count()) !== 1) return undefined;
  return rows
    .getByText(marker, { exact: true })
    .first()
    .evaluate((element, expected) => {
      // DOM numbers are intentionally rounded (K/M), including the tooltip.
      // Read only this owned bubble's committed MessageBubble props to establish
      // exact canonical identity/usage as well as checking the visible UI below.
      for (let node = element; node; node = node.parentElement) {
        const key = Object.keys(node).find((name) =>
          name.startsWith('__reactFiber$'),
        );
        let fiber = key ? node[key] : undefined;
        if (!fiber) continue;
        for (let depth = 0; fiber.return && depth < 80; depth++) {
          fiber = fiber.return;
        }
        // DOM host nodes can retain a pointer into the previous Fiber alternate.
        // Inspect the committed root, never stale pre-update MessageBubble props.
        const currentRoot = fiber.stateNode?.current;
        if (!currentRoot) continue;
        const pending = [currentRoot];
        for (let visited = 0; pending.length && visited < 100000; visited++) {
          const current = pending.pop();
          const message = current.memoizedProps?.message;
          if (
            message?.source_kind === 'sdk_final' &&
            message.content?.trim() === expected
          ) {
            return {
              id: message.id,
              turnId: message.turn_id,
              usage: message.token_usage,
            };
          }
          if (current.sibling) pending.push(current.sibling);
          if (current.child) pending.push(current.child);
        }
      }
      return undefined;
    }, marker);
}

async function checkVisibleUsage(marker, usage) {
  const row = bubbleRow(marker);
  const breakdown = tokenBreakdown(usage);
  const expectedTotal = `${formatNum(breakdown.total)} tokens`;
  const total = row.getByText(expectedTotal, { exact: true });
  if ((await total.count()) !== 1 || !(await total.isVisible()))
    return { total: false, tooltip: false };
  const trigger = row
    .locator('[data-slot="tooltip-trigger"]')
    .filter({ hasText: expectedTotal });
  const inputOutput = `输入 ${formatNum(breakdown.inputTokens)} / 输出 ${formatNum(breakdown.outputTokens)}`;
  const cache = `缓存读取 ${formatNum(breakdown.cacheReadInputTokens)} / 缓存写入 ${formatNum(breakdown.cacheCreationInputTokens)} / 推理 ${formatNum(breakdown.reasoningTokens)}`;
  const matches = (details) => {
    const text = normalizeText(details);
    return (
      text.includes(inputOutput) &&
      (!(
        breakdown.cacheReadInputTokens ||
        breakdown.cacheCreationInputTokens ||
        breakdown.reasoningTokens
      ) ||
        text.includes(cache))
    );
  };
  if ((await trigger.count()) === 1) {
    await trigger.hover();
    const tooltipMatches = await waitUntil(
      async () => {
        // A previous tooltip can remain visible during its exit animation. Read
        // the content owned by this exact trigger's aria-describedby, then wait
        // for its delayed portal to show the current bubble's usage.
        const details = await trigger.evaluate((element) => {
          const id = element.getAttribute('aria-describedby');
          const content = id
            ? document
                .getElementById(id)
                ?.closest('[data-slot="tooltip-content"]')
            : undefined;
          if (!content || !content.getBoundingClientRect().width)
            return undefined;
          return content.innerText;
        });
        return Boolean(details && matches(details));
      },
      3000,
      100,
    );
    if (tooltipMatches) {
      await page.mouse.move(0, 0);
      return { total: true, tooltip: true };
    }
  }
  // Support a native title tooltip if the badge implementation uses one.
  const details = await total.evaluate((element) =>
    element.closest('[title]')?.getAttribute('title'),
  );
  await page.mouse.move(0, 0);
  return { total: true, tooltip: Boolean(details && matches(details)) };
}

async function run() {
  delete process.env.DEBUG;
  delete process.env.PWDEBUG;
  const { chromium, expect: baseExpect } = await import('@playwright/test');
  const expect = baseExpect.configure({ timeout: 15000 });
  const target = process.env.HAPPYCLAW_URL;
  const cookieFile = process.env.HAPPYCLAW_ACCEPTANCE_COOKIE_FILE;
  requireCondition(Boolean(target && cookieFile));
  const base = new URL(target);
  requireCondition(
    ['http:', 'https:'].includes(base.protocol) &&
      !base.username &&
      !base.password &&
      !base.search &&
      !base.hash,
  );
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const appUrl = (route) => new URL(route.replace(/^\/+/, ''), base).href;
  const cookieStat = await stat(cookieFile);
  requireCondition(
    cookieStat.isFile() &&
      cookieStat.size > 0 &&
      cookieStat.size <= 65536 &&
      !(cookieStat.mode & 0o077),
  );
  const header = (await readFile(cookieFile, 'utf8'))
    .trim()
    .replace(/^Cookie:\s*/i, '');
  requireCondition(Boolean(header) && !/[\r\n\0]/.test(header));
  const cookies = header.split(';').map((part) => {
    const separator = part.indexOf('=');
    const name = part.slice(0, separator).trim();
    requireCondition(
      separator > 0 && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name),
    );
    return {
      name,
      value: part.slice(separator + 1).trim(),
      url: `${base.origin}/`,
      httpOnly: true,
      secure: base.protocol === 'https:',
      sameSite: 'Lax',
    };
  });
  requireCondition(
    new Set(cookies.map(({ name }) => name)).size === cookies.length,
  );
  report.checks.inputs = true;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block',
  });
  context.setDefaultTimeout(15000);
  context.setDefaultNavigationTimeout(30000);
  await context.addCookies(cookies);
  api = async (method, route, body) => {
    const allowedWrite =
      (method === 'POST' &&
        route === '/api/agent-profiles' &&
        body?.name === nonce) ||
      (method === 'POST' &&
        route === '/api/groups' &&
        profileId &&
        body?.agent_profile_id === profileId &&
        body.name === nonce) ||
      ownedWorkspaces.some(
        ({ jid }) =>
          (method === 'POST' &&
            route === `/api/groups/${encodeURIComponent(jid)}/sessions` &&
            body?.name === `${nonce}_SESSION`) ||
          (method === 'DELETE' &&
            route === `/api/groups/${encodeURIComponent(jid)}`),
      ) ||
      (method === 'DELETE' &&
        profileId &&
        route === `/api/agent-profiles/${encodeURIComponent(profileId)}`);
    requireCondition(method === 'GET' || allowedWrite);
    const response = await context.request.fetch(appUrl(route), {
      method,
      ...(body === undefined ? {} : { data: body }),
      timeout: 90000,
    });
    requireCondition(response.ok());
    return response.json();
  };
  const me = await api('GET', '/api/auth/me');
  requireCondition(me.user?.role === 'admin');
  report.checks.authorizedOwner = true;
  const profile = (
    await api('POST', '/api/agent-profiles', {
      name: nonce,
      prompt_schema_version: 2,
      prompt_mode: 'append',
      identity_prompt:
        'This is an authorized disposable acceptance workspace. Reply only with the exact requested marker. Do not use tools, skills, subagents, files or any other workspace.',
      soul_prompt: '',
      agents_prompt: '',
      tools_prompt: '',
      runtime_policy: {
        context: { source: 'managed' },
        skills: {
          mode: 'disabled',
          ids: [],
          host: { mode: 'disabled', ids: [] },
        },
        mcp: { mode: 'disabled', ids: [] },
      },
    })
  ).profile;
  profileId = profile.id;
  report.counts.profilesCreated++;
  requireCondition(
    profile.name === nonce &&
      !profile.is_default &&
      profile.runtime_policy?.context?.source === 'managed',
  );
  report.checks.managedProfile = true;
  const created = await api('POST', '/api/groups', {
    name: nonce,
    execution_mode: 'host',
    agent_profile_id: profileId,
  });
  const workspace = { jid: created.jid, folder: created.group.folder };
  ownedWorkspaces.push(workspace);
  report.counts.workspacesCreated++;
  requireCondition(
    created.group.agent_profile_id === profileId &&
      created.group.execution_mode === 'host',
  );
  report.checks.ownedWorkspace = true;
  const session = (
    await api(
      'POST',
      `/api/groups/${encodeURIComponent(workspace.jid)}/sessions`,
      { name: `${nonce}_SESSION` },
    )
  ).session;
  sessionId = session.id;
  report.counts.sessionsCreated++;
  requireCondition(
    session.kind === 'conversation' && session.source_kind === 'manual',
  );
  report.checks.independentSession = true;

  const historyPath = new URL(
    appUrl(`/api/groups/${encodeURIComponent(workspace.jid)}/messages`),
  ).pathname;
  const messagePath = new URL(appUrl('/api/messages')).pathname;
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    try {
      if (!safeMethods.has(request.method())) {
        let allowed = false;
        if (
          request.method() === 'POST' &&
          url.origin === base.origin &&
          url.pathname === messagePath &&
          activeSend
        ) {
          const body = request.postDataJSON();
          allowed =
            body.chatJid === workspace.jid &&
            (body.agentId || undefined) === activeSend.agentId &&
            body.content === activeSend.prompt &&
            !body.attachments?.length;
        }
        if (!allowed) {
          report.counts.blockedBrowserWrites++;
          await route.abort('blockedbyclient');
          return;
        }
        report.counts.uiMessagesSent++;
        activeSend.sent = true;
        await route.continue();
        return;
      }
      if (
        holdHistory &&
        url.origin === base.origin &&
        url.pathname === historyPath
      ) {
        const gate = deferred();
        historyGates.push(gate);
        report.counts.heldHistoryRequests++;
        await gate.promise;
      }
      await route.continue();
    } catch {
      // History requests intentionally held past the UI fetch timeout may be
      // cancelled before release. Their route-continuation failure is expected.
      if (!closing && !safeMethods.has(request.method())) {
        report.counts.blockedBrowserWrites++;
      }
      await route.abort('blockedbyclient').catch(() => {});
    }
  });
  page = await context.newPage();
  page.on('pageerror', () => report.counts.pageErrors++);
  page.on('request', (request) => {
    if (request.resourceType() === 'document') report.counts.documentRequests++;
  });
  page.on('response', (response) => {
    if (
      staticTypes.has(response.request().resourceType()) &&
      response.status() >= 400
    )
      report.counts.failedStaticResources++;
  });
  page.on('requestfailed', (request) => {
    if (staticTypes.has(request.resourceType()))
      report.counts.failedStaticResources++;
  });
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      try {
        const data = JSON.parse(payload.toString());
        if (
          data.chatJid !== workspace.jid ||
          (data.agentId && data.agentId !== sessionId)
        )
          return;
        if (ownFrames.length >= 4000) ownFrames.shift();
        ownFrames.push(data);
      } catch {
        /* Heartbeats and unrelated connections are not test evidence. */
      }
    });
  });

  async function scope(agentId, names) {
    releaseHistory();
    const initialHistory = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.origin === base.origin &&
        url.pathname === historyPath &&
        (url.searchParams.get('agentId') || undefined) === agentId &&
        response.request().method() === 'GET'
      );
    });
    initialHistory.catch(() => {});
    await page.goto(
      appUrl(
        `/chat/${encodeURIComponent(workspace.folder)}${agentId ? `?agent=${encodeURIComponent(agentId)}` : ''}`,
      ),
      { waitUntil: 'networkidle' },
    );
    requireCondition((await initialHistory).ok());
    const input = page.getByPlaceholder('输入消息...', { exact: true });
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();
    let prior;
    for (const [index, caseName] of names.entries()) {
      const check = report.cases[caseName];
      const marker = `${nonce}_${caseName}`;
      const prompt = `Reply exactly ${marker}. No explanation or tools.`;
      const after = ownFrames.length;
      const documents = report.counts.documentRequests;
      // Logical runId changes at each idle→query transition even when the host
      // runner stays warm. Its equality is not evidence of process reuse.
      let warmRunnerReady = index === 0;
      if (index === 1) {
        const runtimeJid = agentId
          ? `${workspace.jid}#agent:${agentId}`
          : workspace.jid;
        warmRunnerReady = await waitUntil(
          async () => {
            const status = await api('GET', '/api/status');
            const own = status.groups.find((group) => group.jid === runtimeJid);
            return Boolean(own?.active && !own.queryInFlight);
          },
          15000,
          300,
        );
      }
      activeSend = { agentId, prompt, sent: false };
      holdHistory = true;
      const acknowledged = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.origin === base.origin &&
          url.pathname === messagePath &&
          response.request().method() === 'POST' &&
          response.request().postDataJSON()?.content === prompt
        );
      });
      acknowledged.catch(() => {});
      await input.fill(prompt);
      await input.press('Enter');
      const ackResponse = await acknowledged;
      requireCondition(ackResponse.ok() && activeSend.sent);
      const ack = await ackResponse.json();
      requireCondition(ack.success);
      activeSend = undefined;
      let final;
      await waitUntil(() => {
        final = ownFrames
          .slice(after)
          .find(
            (data) =>
              data.type === 'new_message' &&
              (data.agentId || undefined) === agentId &&
              data.message?.is_from_me &&
              data.message.source_kind === 'sdk_final' &&
              data.message.finalization_reason === 'completed' &&
              data.message.content?.trim() === marker,
          )?.message;
        return Boolean(final);
      });
      check.finalReceived = Boolean(final);
      if (!final) throw new Error('Owned final was not received');
      report.counts.finalsReceived++;
      const scoped = ownFrames
        .slice(after)
        .filter((data) => (data.agentId || undefined) === agentId);
      check.warmInputToActiveRunner =
        index === 0 ||
        (warmRunnerReady &&
          scoped.some((data) => data.type === 'stream_event' && data.runId));
      if (index === 1 && check.warmInputToActiveRunner)
        report.counts.warmInputsToActiveRunners++;
      let restFinal;
      let restUsage;
      await waitUntil(
        async () => {
          const query = agentId
            ? `?agentId=${encodeURIComponent(agentId)}`
            : '';
          const history = await api(
            'GET',
            `/api/groups/${encodeURIComponent(workspace.jid)}/messages${query}`,
          );
          restFinal = history.messages.find(
            (message) =>
              message.id === final.id &&
              message.turn_id === final.turn_id &&
              message.source_kind === 'sdk_final' &&
              message.content?.trim() === marker,
          );
          restUsage = parseUsage(restFinal?.token_usage);
          return Boolean(restUsage && tokenBreakdown(restUsage).total > 0);
        },
        30000,
        700,
      );
      check.authoritativeRestUsage = Boolean(
        restUsage && tokenBreakdown(restUsage).total > 0,
      );
      if (check.authoritativeRestUsage) report.counts.restUsagesFound++;
      // All API reads above use APIRequestContext: none hydrate the page store.
      // Keep its automatic message-history fetches held through this assertion.
      await waitUntil(
        async () => {
          const rendered = await renderedMessage(marker);
          return Boolean(
            rendered?.id === final.id && parseUsage(rendered.usage),
          );
        },
        15000,
        200,
      );
      const live = await renderedMessage(marker);
      check.finalBubbleFound = Boolean(
        live?.id === final.id && live.turnId === final.turn_id,
      );
      check.exactUsageMatchesRest =
        check.finalBubbleFound &&
        check.authoritativeRestUsage &&
        isDeepStrictEqual(parseUsage(live.usage), restUsage);
      if (check.exactUsageMatchesRest) report.counts.exactUsageMatches++;
      if (check.finalBubbleFound && check.authoritativeRestUsage) {
        const row = bubbleRow(marker);
        check.usageVisible =
          (await row.getByText(/^[\d,.]+[KM]? tokens$/).count()) > 0;
        if (check.usageVisible) report.counts.visibleUsageBadges++;
        const visible = await checkVisibleUsage(marker, restUsage);
        check.displayedTotalMatchesRest = visible.total;
        check.tooltipMatchesRest = visible.tooltip;
        if (visible.tooltip) report.counts.tooltipsChecked++;
      }
      const usages = ownFrames
        .slice(after)
        .filter(
          (data) =>
            (data.agentId || undefined) === agentId &&
            data.type === 'stream_event' &&
            data.event?.eventType === 'usage',
        );
      report.counts.usageEvents += usages.length;
      const matchingUsages = usages.filter(
        (data) => data.event.inputTurnId === final.turn_id,
      );
      report.counts.matchingImmutableUsageEvents += matchingUsages.length;
      // stream.turnId is a mutable presentation ID; final.turn_id is immutable.
      check.immutableUsageTurnMatches = matchingUsages.length > 0;
      check.priorUsageUnchanged =
        !prior ||
        isDeepStrictEqual(
          parseUsage((await renderedMessage(prior.marker))?.usage),
          prior.usage,
        );
      check.withoutReload = report.counts.documentRequests === documents;
      prior = { marker, usage: restUsage };
    }
  }
  await scope(undefined, ['mainCold', 'mainWarm']);
  await scope(sessionId, ['sessionCold', 'sessionWarm']);
  releaseHistory();
  report.checks.noUnexpectedWrites =
    report.counts.blockedBrowserWrites === 0 &&
    report.counts.uiMessagesSent === 4;
}

try {
  await run();
} catch {
  /* Never print assertions containing private DOM/API data. */
} finally {
  closing = true;
  activeSend = undefined;
  releaseHistory();
  await page?.close().catch(() => {});
  for (const { jid } of [...ownedWorkspaces].reverse()) {
    try {
      await api('DELETE', `/api/groups/${encodeURIComponent(jid)}`);
      report.counts.workspacesRemoved++;
    } catch {
      report.counts.cleanupFailures++;
    }
  }
  if (profileId && report.counts.workspacesRemoved === ownedWorkspaces.length) {
    try {
      await api(
        'DELETE',
        `/api/agent-profiles/${encodeURIComponent(profileId)}`,
      );
      report.counts.profilesRemoved++;
    } catch {
      report.counts.cleanupFailures++;
    }
  }
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  report.checks.cleanup =
    report.counts.cleanupFailures === 0 &&
    report.counts.workspacesRemoved === report.counts.workspacesCreated &&
    report.counts.profilesRemoved === report.counts.profilesCreated;
  report.checks.noPageErrors = report.counts.pageErrors === 0;
  report.checks.noFailedStaticResources =
    report.counts.failedStaticResources === 0;
  report.passed =
    Object.values(report.checks).every(Boolean) &&
    Object.values(report.cases).every((checks) =>
      Object.values(checks).every(Boolean),
    );
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}
