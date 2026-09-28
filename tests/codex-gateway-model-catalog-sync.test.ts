import { afterEach, describe, expect, test, vi } from 'vitest';

import { clampCodexEffortWithCatalog } from '../src/codex-gateway/model-catalog.js';
import {
  getResolvedCodexCatalog,
  initCodexCatalogSync,
  parseUpstreamModelCatalog,
  refreshCodexCatalog,
  resetCodexCatalogSyncForTests,
  setCodexCatalogDiskCachePathForTests,
} from '../src/codex-gateway/model-catalog-sync.js';

// 按真实上游 codex-rs/models-manager/models.json 的结构裁剪的 fixture。
const UPSTREAM_PAYLOAD = {
  models: [
    {
      slug: 'gpt-6-sol',
      display_name: 'GPT-6-Sol',
      description: 'Workhorse model for coding and everyday work.',
      visibility: 'list',
      supported_in_api: true,
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses' },
        { effort: 'medium', description: 'Balanced' },
        { effort: 'high', description: 'Greater depth' },
        { effort: 'xhigh', description: 'Extra high' },
        { effort: 'max', description: 'Maximum' },
        { effort: 'ultra', description: 'Maximum with delegation' },
      ],
    },
    {
      slug: 'gpt-9-aurora',
      display_name: 'GPT-9 Aurora',
      description: 'Future flagship model.',
      visibility: 'list',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses' },
        { effort: 'medium', description: 'Balanced' },
      ],
    },
    {
      slug: 'gpt-daybreak-red-latest',
      display_name: 'Daybreak Red',
      description: 'Cyber-permissive variant.',
      visibility: 'hide',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses' },
      ],
    },
    {
      slug: 'gpt-no-efforts',
      display_name: 'No Efforts',
      visibility: 'list',
      supported_reasoning_levels: [],
    },
  ],
};

function mockFetchWith(payload: unknown, status = 200) {
  return vi.fn(
    async () => new Response(JSON.stringify(payload), { status }),
  ) as unknown as typeof fetch;
}

describe('Codex model catalog upstream sync', () => {
  afterEach(() => {
    resetCodexCatalogSyncForTests();
    setCodexCatalogDiskCachePathForTests(null);
    vi.restoreAllMocks();
  });

  test('parses upstream payload: keeps list-visible models with efforts', () => {
    const entries = parseUpstreamModelCatalog(UPSTREAM_PAYLOAD);
    expect(entries.map((entry) => entry.value)).toEqual([
      'gpt-6-sol',
      'gpt-9-aurora',
    ]);
    const sol = entries[0];
    expect(sol.efforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
  });

  test('keeps curated label for known slugs, derives label for new models', () => {
    const entries = parseUpstreamModelCatalog(UPSTREAM_PAYLOAD);
    expect(entries[0].label).toBe('gpt-6-sol（主力编码）');
    expect(entries[1].label).toBe('gpt-9-aurora（GPT-9 Aurora）');
  });

  test('rejects malformed payloads', () => {
    expect(() => parseUpstreamModelCatalog(null)).toThrow();
    expect(() => parseUpstreamModelCatalog({})).toThrow();
    expect(() => parseUpstreamModelCatalog({ models: [] })).toThrow();
    expect(() =>
      parseUpstreamModelCatalog({
        models: [
          {
            slug: 'a',
            visibility: 'hide',
            supported_reasoning_levels: [{ effort: 'low' }],
          },
        ],
      }),
    ).toThrow();
  });

  test('refresh applies upstream catalog and reports upstream source', async () => {
    const fetchImpl = mockFetchWith(UPSTREAM_PAYLOAD);
    const ok = await refreshCodexCatalog({ fetchImpl });
    expect(ok).toBe(true);
    const resolved = getResolvedCodexCatalog();
    expect(resolved.source).toBe('upstream');
    expect(resolved.models.map((entry) => entry.value)).toContain(
      'gpt-9-aurora',
    );
  });

  test('failed refresh keeps the current catalog', async () => {
    const before = getResolvedCodexCatalog();
    const fetchImpl = mockFetchWith({ error: 'rate limited' }, 429);
    const ok = await refreshCodexCatalog({ fetchImpl });
    expect(ok).toBe(false);
    expect(getResolvedCodexCatalog()).toBe(before);
  });

  test('concurrent refreshes share a single upstream fetch (single-flight)', async () => {
    let resolveFetch: (value: Response) => void = () => {};
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as unknown as typeof fetch;
    const first = refreshCodexCatalog({ fetchImpl });
    const second = refreshCodexCatalog({ fetchImpl });
    resolveFetch(
      new Response(JSON.stringify(UPSTREAM_PAYLOAD), { status: 200 }),
    );
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('init loads disk cache synchronously and stays builtin on corruption', () => {
    // null 磁盘路径（测试环境禁写）→ init 后应停留在 baked-in 兜底
    setCodexCatalogDiskCachePathForTests(null);
    initCodexCatalogSync();
    const resolved = getResolvedCodexCatalog();
    expect(resolved.source).toBe('builtin');
    expect(resolved.models.length).toBeGreaterThan(0);
  });

  test('clampCodexEffortWithCatalog honors resolved catalog efforts', () => {
    const catalog = parseUpstreamModelCatalog(UPSTREAM_PAYLOAD);
    // 上游目录里 gpt-6-sol 支持 ultra → 透传
    expect(clampCodexEffortWithCatalog(catalog, 'gpt-6-sol', 'ultra')).toBe(
      'ultra',
    );
    // 新模型 gpt-9-aurora 只有 low/medium → high 归位默认档
    expect(clampCodexEffortWithCatalog(catalog, 'gpt-9-aurora', 'high')).toBe(
      'medium',
    );
    // 目录外模型透传
    expect(clampCodexEffortWithCatalog(catalog, 'gpt-8-future', 'ultra')).toBe(
      'ultra',
    );
  });
});
