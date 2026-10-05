import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { loadClaudeContextMcpServers } from '../src/mcp-context.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-mcp-symlink-'));
  roots.push(root);
  return root;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('workspace MCP symlink confinement', () => {
  test('ignores out-of-workspace symlinks but still loads in-workspace links', () => {
    const root = tempRoot();
    const dataDir = path.join(root, 'data');
    const groupsDir = path.join(dataDir, 'groups');
    const home = path.join(root, 'adminhome');
    const externalClaudeDir = path.join(home, '.claude');

    writeJson(
      path.join(dataDir, 'sessions', 'main', '.claude', 'settings.json'),
      {
        mcpServers: {
          adminSecret: {
            command: 'admin-secret-mcp',
            env: { SYSTEM_TOKEN: 'admin-env-secret' },
          },
        },
      },
    );
    writeJson(path.join(groupsDir, 'victim', '.mcp.json'), {
      mcpServers: {
        victimDb: {
          command: 'pg-mcp',
          env: { PGPASSWORD: 'victim-db-secret' },
        },
      },
    });
    writeJson(path.join(home, '.claude.json'), {
      mcpServers: {
        secretHost: {
          command: 'host-mcp',
          env: { HOST_TOKEN: 'host-claude-json-secret' },
        },
      },
    });

    const member = path.join(groupsDir, 'member');
    fs.mkdirSync(path.join(member, '.claude'), { recursive: true });
    fs.symlinkSync(
      '../../sessions/main/.claude/settings.json',
      path.join(member, '.mcp.json'),
    );
    fs.symlinkSync(
      '../../../groups/victim/.mcp.json',
      path.join(member, '.claude', 'settings.json'),
    );
    fs.symlinkSync(
      path.join(home, '.claude.json'),
      path.join(member, '.claude', 'settings.local.json'),
    );

    const servers = loadClaudeContextMcpServers({
      workspaceDir: member,
      externalClaudeDir,
      includeHostClaudeContext: false,
    });

    expect(servers).toEqual({});
    expect(JSON.stringify(servers)).not.toContain('admin-env-secret');
    expect(JSON.stringify(servers)).not.toContain('victim-db-secret');
    expect(JSON.stringify(servers)).not.toContain('host-claude-json-secret');

    const legit = path.join(groupsDir, 'legit');
    writeJson(path.join(legit, 'config', 'mcp.json'), {
      mcpServers: { localTool: { command: 'local-tool' } },
    });
    fs.symlinkSync('config/mcp.json', path.join(legit, '.mcp.json'));

    const legitServers = loadClaudeContextMcpServers({
      workspaceDir: legit,
      externalClaudeDir,
      includeHostClaudeContext: false,
    });
    expect(legitServers).toEqual({ localTool: { command: 'local-tool' } });
  });

  test('dangling workspace MCP symlink yields empty map', () => {
    const root = tempRoot();
    const workspaceDir = path.join(root, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.symlinkSync('missing-target.json', path.join(workspaceDir, '.mcp.json'));

    expect(
      loadClaudeContextMcpServers({
        workspaceDir,
        includeHostClaudeContext: false,
      }),
    ).toEqual({});
  });
});
