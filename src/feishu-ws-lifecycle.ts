import type { WSClient } from '@larksuiteoapi/node-sdk';

type PullResult =
  | { ok: true }
  | { ok: false; retryable: boolean; error?: string };

interface HandshakeHooks {
  pullConnectConfig(): Promise<PullResult>;
  connect(): Promise<boolean>;
  communicate(): void;
  reConnect(isStart?: boolean): Promise<void>;
}

/**
 * The locked Lark SDK does not cancel pending endpoint discovery or socket
 * handshakes in close(). In an automatic reconnect it can even establish a
 * socket, attach event listeners, then silently return on a stale generation
 * without invoking either ready callback. Fence the actual transport steps.
 *
 * These SDK hooks are private in its declarations but ordinary methods at
 * runtime. Keep that compatibility boundary here, covered by real-SDK tests.
 */
export function fenceFeishuWebSocketLifecycle<T extends WSClient>(
  client: T,
): T {
  const sdk = client as unknown as HandshakeHooks;
  const hooks = [
    'pullConnectConfig',
    'connect',
    'communicate',
    'reConnect',
  ] as const;
  if (hooks.some((name) => typeof sdk[name] !== 'function')) {
    // Public-only test doubles do not establish transports. A real SDK with
    // a changed lifecycle must fail closed instead of losing the fence.
    if (typeof client.getConnectionStatus === 'function') {
      throw new Error('Unsupported Feishu WSClient lifecycle hooks');
    }
    return client;
  }

  let retired = false;
  const close = client.close.bind(client);
  const pull = sdk.pullConnectConfig.bind(client);
  const connect = sdk.connect.bind(client);
  const communicate = sdk.communicate.bind(client);
  const reconnect = sdk.reConnect.bind(client);
  const cancelled = (): PullResult => ({
    ok: false,
    retryable: false,
    error: 'Feishu WSClient was retired',
  });

  client.close = (params) => {
    retired = true;
    close(params);
  };
  sdk.pullConnectConfig = async () => {
    if (retired) return cancelled();
    const result = await pull();
    return retired ? cancelled() : result;
  };
  sdk.connect = async () => {
    if (retired) return false;
    const connected = await connect();
    if (!retired) return connected;
    // A socket that opened after close() was not yet in the SDK's wsConfig
    // when close() ran. Remove it before communicate() can consume events.
    close({ force: true });
    return false;
  };
  sdk.communicate = () => {
    if (retired) close({ force: true });
    else communicate();
  };
  sdk.reConnect = async (isStart) => {
    if (retired) {
      close({ force: true });
      return;
    }
    await reconnect(isStart);
    if (retired) close({ force: true });
  };
  return client;
}
