import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redeem-atomic-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  DATA_DIR: tmpDir,
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

const db = await import('../src/db.js');
const { redeemCode } = await import('../src/billing.js');
const dbPath = path.join(tmpStoreDir, 'messages.db');

function rw<T>(fn: (d: InstanceType<typeof Database>) => T): T {
  const d = new Database(dbPath);
  try {
    return fn(d);
  } finally {
    d.close();
  }
}
const usage = (code: string) =>
  rw((d) => ({
    used: (
      d
        .prepare('SELECT used_count FROM redeem_codes WHERE code=?')
        .get(code) as any
    ).used_count,
    rows: (
      d
        .prepare('SELECT COUNT(*) c FROM redeem_code_usage WHERE code=?')
        .get(code) as any
    ).c,
  }));

function mkCode(
  code: string,
  type: 'trial' | 'subscription',
  planId: string | null = null,
) {
  db.createRedeemCode({
    code,
    type,
    value_usd: null,
    plan_id: planId,
    duration_days: 7,
    max_uses: 1,
    used_count: 0,
    expires_at: null,
    created_by: 'admin',
    notes: null,
    batch_id: null,
    created_at: new Date().toISOString(),
  });
}

beforeAll(() => {
  db.initDatabase();
  rw((d) => d.exec('UPDATE billing_plans SET is_default = 0'));
  const now = new Date().toISOString();
  for (const id of ['u1', 'u2']) {
    db.createUser({
      id,
      username: id,
      password_hash: 'x',
      display_name: id,
      role: 'member',
      status: 'active',
      created_at: now,
      updated_at: now,
    });
  }
});
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
beforeEach(() => {
  rw((d) => {
    d.exec(
      "DELETE FROM redeem_code_usage; DELETE FROM redeem_codes; DELETE FROM user_subscriptions; DELETE FROM billing_plans WHERE id != 'free'; UPDATE billing_plans SET is_default = 0;",
    );
    // Admin un-defaults every plan (PATCH /admin/plans/:id {is_default:false}).
    d.prepare(
      "INSERT INTO billing_plans (id,name,tier,monthly_cost_usd,allow_overage,features,is_default,is_active,created_at,updated_at) VALUES ('pro','Pro',1,0,0,'[]',0,1,?,?)",
    ).run(new Date().toISOString(), new Date().toISOString());
  });
});

describe('redeemCode consumes the code only together with its effect', () => {
  test('trial code with no default plan: failure must not burn the code', () => {
    mkCode('TRIAL1', 'trial');
    const r = redeemCode('u1', 'TRIAL1');
    expect(r.success).toBe(false);
    expect(r.message).toBe('无法激活试用（未找到可用套餐）');
    expect(usage('TRIAL1')).toEqual({ used: 0, rows: 0 });
    // After admin restores a default plan the same user can redeem.
    rw((d) => d.exec("UPDATE billing_plans SET is_default=1 WHERE id='pro'"));
    const ok = redeemCode('u1', 'TRIAL1');
    expect(ok.success).toBe(true);
    expect(ok.message).toBe('成功激活 7 天试用');
    expect(usage('TRIAL1')).toEqual({ used: 1, rows: 1 });
  });

  test('trial code with default plan: existing success path unchanged', () => {
    rw((d) => d.exec("UPDATE billing_plans SET is_default=1 WHERE id='pro'"));
    mkCode('TRIAL2', 'trial');
    const r = redeemCode('u2', 'TRIAL2');
    expect(r.success).toBe(true);
    expect(r.message).toBe('成功激活 7 天试用');
    expect(usage('TRIAL2')).toEqual({ used: 1, rows: 1 });
  });
});
