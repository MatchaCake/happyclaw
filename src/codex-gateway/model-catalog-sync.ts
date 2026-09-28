// ─── Codex 模型目录 — 上游同步层 ────────────────────────────────────
//
// model-catalog.ts 是离线兜底（baked-in）；本模块让目录"根据上游内容更新"：
// 定期 + 访问时拉取 openai/codex 仓库的 codex-rs/models-manager/models.json
// （codex CLI 自身捆绑的同一份目录），解析出在售模型与受支持的 reasoning
// effort 档位。任何失败（网络、结构、校验）都保留当前目录，绝不返回空目录。
//
// 缓存三级：内存（进程内即时生效）→ 磁盘（重启后免等待）→ baked-in 兜底。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  CODEX_MODEL_CATALOG,
  type CodexModelCatalogEntry,
} from './model-catalog.js';

const UPSTREAM_MODELS_URL =
  'https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json';

const UPSTREAM_FETCH_TIMEOUT_MS = 10_000;
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type CodexCatalogSource = 'builtin' | 'disk-cache' | 'upstream';

export interface ResolvedCodexCatalog {
  models: readonly CodexModelCatalogEntry[];
  source: CodexCatalogSource;
  fetchedAt: string | null;
}

interface UpstreamModelEntry {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  visibility?: unknown;
  supported_reasoning_levels?: unknown;
}

function resolveDiskCachePath(): string {
  return (
    diskCachePathOverride ??
    path.join(DATA_DIR, 'config', 'codex-model-catalog.json')
  );
}

let diskCachePathOverride: string | null | undefined;

const curatedLabels = new Map(
  CODEX_MODEL_CATALOG.map((entry) => [entry.value, entry.label]),
);

/**
 * 上游 models.json → 目录条目。只保留 visibility=list 的在售模型；
 * effort 档位按上游 supported_reasoning_levels 顺序原样采用；
 * 已知模型保留人工中文标注，新模型用 display_name 自动生成标签。
 */
export function parseUpstreamModelCatalog(
  raw: unknown,
): CodexModelCatalogEntry[] {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Upstream model catalog payload is not an object');
  }
  const models = (raw as { models?: unknown }).models;
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('Upstream model catalog has no models array');
  }
  const entries: CodexModelCatalogEntry[] = [];
  for (const item of models as UpstreamModelEntry[]) {
    if (!item || typeof item !== 'object') continue;
    const slug = typeof item.slug === 'string' ? item.slug.trim() : '';
    if (!slug || item.visibility !== 'list') continue;
    const efforts = Array.isArray(item.supported_reasoning_levels)
      ? item.supported_reasoning_levels
          .map((level) =>
            level && typeof level === 'object'
              ? (level as { effort?: unknown }).effort
              : undefined,
          )
          .filter((effort): effort is string => typeof effort === 'string')
      : [];
    if (efforts.length === 0) continue;
    const curated = curatedLabels.get(slug);
    const displayName =
      typeof item.display_name === 'string' ? item.display_name.trim() : '';
    entries.push({
      value: slug,
      label: curated ?? (displayName ? `${slug}（${displayName}）` : slug),
      efforts,
    });
  }
  if (entries.length === 0) {
    throw new Error('Upstream model catalog produced no usable entries');
  }
  return entries;
}

let resolved: ResolvedCodexCatalog = {
  models: CODEX_MODEL_CATALOG,
  source: 'builtin',
  fetchedAt: null,
};

let inflight: Promise<boolean> | null = null;
let lastRefreshAt = 0;

export function getResolvedCodexCatalog(): ResolvedCodexCatalog {
  return resolved;
}

/** 请求侧 effort 钳制 / 目录查询都走解析后的目录（上游同步结果优先）。 */
export function resolveResolvedCatalogEntry(
  model: string,
): CodexModelCatalogEntry | undefined {
  return resolved.models.find((entry) => entry.value === model);
}

function loadDiskCache(): boolean {
  if (diskCachePathOverride === null) return false;
  try {
    const raw = readFileSync(resolveDiskCachePath(), 'utf8');
    const parsed = JSON.parse(raw) as {
      models?: CodexModelCatalogEntry[];
      fetchedAt?: string;
    };
    const models = Array.isArray(parsed.models) ? parsed.models : [];
    if (
      models.length === 0 ||
      models.some(
        (entry) =>
          !entry ||
          typeof entry.value !== 'string' ||
          !Array.isArray(entry.efforts) ||
          entry.efforts.some((effort) => typeof effort !== 'string'),
      )
    ) {
      return false;
    }
    resolved = {
      models,
      source: 'disk-cache',
      fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : null,
    };
    return true;
  } catch {
    return false;
  }
}

function writeDiskCache(models: readonly CodexModelCatalogEntry[]): void {
  if (diskCachePathOverride === null) return;
  try {
    const file = resolveDiskCachePath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ models, fetchedAt: new Date().toISOString() }, null, 2),
    );
  } catch (err) {
    logger.warn({ err }, 'Codex model catalog: failed to persist disk cache');
  }
}

/**
 * 拉取并应用上游目录。成功返回 true；任何失败保留当前目录。
 * 单飞：并发调用共享同一次拉取，避免重复请求。
 */
export async function refreshCodexCatalog(
  options: { fetchImpl?: FetchLike } = {},
): Promise<boolean> {
  if (inflight) return inflight;
  const doRefresh = async (): Promise<boolean> => {
    const fetchImpl = options.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(UPSTREAM_MODELS_URL, {
        headers: { 'User-Agent': 'happyclaw-codex-gateway' },
        signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Upstream catalog HTTP ${response.status}`);
      }
      const entries = parseUpstreamModelCatalog(await response.json());
      resolved = {
        models: entries,
        source: 'upstream',
        fetchedAt: new Date().toISOString(),
      };
      lastRefreshAt = Date.now();
      writeDiskCache(entries);
      logger.info(
        { count: entries.length },
        'Codex model catalog refreshed from upstream',
      );
      return true;
    } catch (err) {
      lastRefreshAt = Date.now();
      logger.warn(
        { err },
        'Codex model catalog: upstream refresh failed, keeping current catalog',
      );
      return false;
    }
  };
  inflight = doRefresh().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** TTL 内不重复拉取；由目录路由与启动路径调用，fire-and-forget。 */
export function maybeRefreshCodexCatalog(
  options: { force?: boolean } = {},
): void {
  const stale = Date.now() - lastRefreshAt >= REFRESH_INTERVAL_MS;
  if (!stale && !options.force) return;
  if (inflight) return;
  void refreshCodexCatalog();
}

/**
 * 启动时调用：先同步读磁盘缓存（重启后立即可用），再后台拉一次上游。
 * 永不抛错、不阻塞启动。
 */
export function initCodexCatalogSync(): void {
  if (loadDiskCache()) {
    logger.info(
      { count: resolved.models.length },
      'Codex model catalog loaded from disk cache',
    );
  }
  void refreshCodexCatalog();
}

/** 测试专用：重置内存状态与磁盘缓存路径覆写。 */
export function resetCodexCatalogSyncForTests(): void {
  resolved = {
    models: CODEX_MODEL_CATALOG,
    source: 'builtin',
    fetchedAt: null,
  };
  inflight = null;
  lastRefreshAt = 0;
  diskCachePathOverride = undefined;
}

/** 测试专用：覆写磁盘缓存路径（null 关闭磁盘读写）。 */
export function setCodexCatalogDiskCachePathForTests(
  value: string | null,
): void {
  diskCachePathOverride = value;
}
