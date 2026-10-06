import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ledger-'));
const store = path.join(tmp, 'db');
vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  STORE_DIR: store,
  GROUPS_DIR: path.join(tmp, 'groups'),
}));
vi.mock('../src/runtime-config.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSystemSettings: () => ({ billingEnabled: true }),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const db = await import('../src/db.js');
const { recordUsageEvent } = await import('../src/usage-service.js');
const { checkQuota } = await import('../src/billing.js');
const { aggregateResponsesStream, ResponsesToAnthropicConverter } =
  await import('../src/codex-gateway/convert-response.js');
const { AssistantUsageCollector } =
  await import('../container/agent-runner/src/assistant-usage.js');
const { estimateKabooModelCostCents, kabooCostCentsToUSD } =
  await import('../src/kaboo-pricing.js');

beforeAll(() => {
  fs.mkdirSync(store, { recursive: true });
  db.initDatabase();
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Codex final usage in the real quota and wallet ledgers', () => {
  test.each(['sse', 'nonstream'])(
    '%s cache tokens are conserved through collector → billing transaction',
    (mode) => {
      const userId = `codex-${mode}`;
      const now = new Date().toISOString();
      db.createUser({
        id: userId,
        username: userId,
        password_hash: 'x',
        display_name: userId,
        role: 'member',
        status: 'active',
        permissions: [],
        must_change_password: false,
        created_at: now,
        updated_at: now,
      });
      const plan = db.getDefaultBillingPlan()!;
      expect(plan).toBeDefined();
      const event = {
        type: 'response.completed',
        response: {
          id: userId,
          usage: {
            input_tokens: 100_000,
            input_tokens_details: { cached_tokens: 80_000 },
            output_tokens: 10_000,
          },
        },
      };
      const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
      converter.handleEvent(event);
      const usage =
        mode === 'sse'
          ? converter.getUsage()
          : aggregateResponsesStream([event], 'gpt-6-sol').usage;
      const collector = new AssistantUsageCollector();
      collector.ingest({
        type: 'assistant',
        message: { id: userId, model: 'gpt-6-sol', usage },
      });
      const batch = collector.drain(undefined)!;
      const before = db.getUserBalance(userId).balance_usd;
      const options = {
        userId,
        groupFolder: `workspace-${mode}`,
        eventId: batch.eventId,
        source: 'web',
        createdAt: now,
        usage: { ...batch.tokens, costUSD: 0, durationMs: 1, numTurns: 1 },
      };
      const result = recordUsageEvent(options);
      expect(result.inserted).toBe(true);
      const daily = db.getDailyUsage(userId, db.toLocalDateString(now))!;
      const monthly = db.getMonthlyUsage(userId, db.toLocalMonthString(now))!;
      for (const row of [daily, monthly]) {
        expect(row.total_input_tokens).toBe(100_000);
        expect(row.total_output_tokens).toBe(10_000);
      }
      const quota = checkQuota(userId, 'member');
      expect(quota.usage?.tokenUsed).toBe(110_000);
      expect(quota.usage?.daily.tokenUsed).toBe(110_000);
      const expectedCost =
        kabooCostCentsToUSD(
          estimateKabooModelCostCents('gpt-6-sol', {
            inputTokens: 20_000,
            cacheReadInputTokens: 80_000,
            outputTokens: 10_000,
          }),
        ) * plan.rate_multiplier;
      expect(result.billedCostUSD).toBeCloseTo(expectedCost, 12);
      expect(db.getUserBalance(userId).balance_usd).toBeCloseTo(
        before - expectedCost,
        12,
      );
      expect(recordUsageEvent(options).inserted).toBe(false);
      expect(db.getUserBalance(userId).balance_usd).toBeCloseTo(
        before - expectedCost,
        12,
      );
    },
  );
});
