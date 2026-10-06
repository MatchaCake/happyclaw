# ChatGPT/Codex subscriptions: built-in and external gateways

HappyClaw includes a ChatGPT/Codex OAuth gateway. Use the built-in login for
an account attached to a HappyClaw provider. An external gateway such as
CLIProxyAPI remains an alternative when you need a separately managed
account pool. These are two independent integrations: the built-in flow does
not read or update the host's Codex CLI login file.

## Built-in gateway

### Sign in and select a provider

1. As an administrator with system configuration access, open provider setup
   (`/setup/providers`) and choose **ChatGPT 订阅**.
2. Click **登录 ChatGPT**, open the generated authorization URL, and sign in
   with the account whose Codex access you want to use. Access depends on the
   account's current subscription and OpenAI's availability rules.
3. The OAuth redirect goes to `http://localhost:1455/auth/callback`. This is
   expected; HappyClaw does not start a callback listener on your browser's
   computer. Copy the complete callback URL from the address bar and paste it
   into HappyClaw's callback field. The URL contains the one-time code and
   state; keep it private and finish the flow within ten minutes.
4. Enable the provider, choose its target Codex model and reasoning effort,
   then select it for the workspace. Use the available model catalog rather
   than a model name copied from an old example.

HappyClaw exchanges the code with PKCE, reads the official namespaced JWT
identity claims, and saves OAuth secrets encrypted in its provider secret
store. **重新登录 ChatGPT** replaces that provider's login; clearing or
disabling it stops authorization through its gateway key. No additional
Docker gateway service or device-code-login switch is needed for this flow.

### Runtime and account isolation

```text
Claude Agent SDK (host or agent container)
       | Anthropic Messages + provider gateway key
       v
HappyClaw /gateway/chatgpt/v1/messages
       | OAuth access token + selected ChatGPT account header
       v
ChatGPT / Codex Responses backend
```

The provider's gateway key is distinct from the upstream OAuth secrets.
Only that key is given to the runner; the host service owns access-token
refresh. HappyClaw derives the local gateway address for host and container
execution automatically. The saved internal URL is a routing placeholder,
not an external service to deploy or expose separately.

Each provider identifies one authorization. It is not an account-rotation
pool. Requests refresh short-lived tokens when needed, share a single refresh
per provider, and re-read persisted credentials after concurrent changes.
A failed compare-and-swap never returns an old credential snapshot or
silently overwrites a reauthorization. A provider disabled or key rotated
during refresh is checked again before serving the request.

### Protocol and operating limits

- Text, base64 images/PDFs, function tools, native web search and structured
  JSON output are translated into Codex Responses. Multimodal tool results
  keep their images inside the matching `function_call_output`. Long MCP
  names are mapped to unique short names and restored for the SDK.
- Top-level system text becomes developer input; SDK system reminders retain
  their position in the conversation, following matching tool results.
- Interleaved upstream tool arguments are buffered into serial Anthropic
  content blocks. Delta/done snapshots do not duplicate arguments; final
  output snapshots fill missing content. Native encrypted reasoning signatures
  pass through `thinking.signature`; previous HappyClaw envelopes remain
  readable. Both streaming and nonstream responses use the same converter.
- Cached and cache-write Responses input is subtracted from Anthropic
  `input_tokens` and reported separately as `cache_read_input_tokens` and
  `cache_creation_input_tokens`. Reasoning usage is preserved as a detail of
  output usage. Cache and reasoning details must not be counted twice.
- Authentication runs before body buffering or rate-counter allocation.
  Each authenticated provider has 120 requests per 60-second window, shared
  across its gateway-key rotations. Rate state has a hard capacity of 1,024
  active provider windows; a full table rejects new windows until expiry.
- Requests are capped at 32 MiB. Invalid message, tool or image shapes return
  400; unsupported image URL sources are rejected explicitly instead of
  silently disappearing. Images must use the supported base64 source shape.
- Upstream headers have a 30-second deadline and streams a 60-second idle
  deadline. Nonstream aggregation also has a ten-minute deadline and a
  32 MiB budget. Individual SSE events are bounded. Downstream backpressure
  pauses upstream reading, and cancellation disconnects the upstream stream.
- Success logs record model and usage counts. Upstream HTTP error bodies are
  cancelled without being buffered or logged; they can contain user content
  or secrets. HTTP authentication, permission and rate-limit failures retain
  their Anthropic error types and valid `Retry-After` hints. Semantic terminal
  events close the upstream reader without waiting for the HTTP connection
  to close. Malformed SSE fails the request.

The protocol implementation is ported from
[CLIProxyAPI a2976eb8](https://github.com/router-for-me/CLIProxyAPI/tree/a2976eb8a303f11b4ea5177bce9f9ff752634dfc).
See [the compatibility matrix](codex-protocol-compatibility.md) for the source
functions, differential corpus, intentional runtime differences and remaining
verification boundaries. Its [MIT notice](licenses/CLIProxyAPI-MIT.txt) is
included with the port.

### Verify and recover

Send a short message in a workspace using the newly authorized provider.
Then verify a streamed reply, a tool round trip (including an image result
if your workflow uses screenshots), and usage history. Local protocol tests
use synthetic tokens and mocked upstream streams; they do not establish
that an account can access the live backend.

| Symptom                         | Check                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Login callback rejected         | Finish the same user's flow within ten minutes and paste its complete callback URL; do not reuse a consumed code.                   |
| 401 or authentication error     | Verify the provider is enabled and still authorized. Use its HappyClaw re-login action if the refresh grant expired or was revoked. |
| 429 from HappyClaw gateway      | Wait for the provider's fixed rate window to expire; all workspaces sharing that provider share its budget.                         |
| 413                             | Reduce the request below the 32 MiB envelope, including image base64 overhead.                                                      |
| 400 invalid messages request    | Check supported message/tool shapes and use base64 image sources.                                                                   |
| Upstream model/plan rejection   | Select a model available to the linked account and check its current Codex access.                                                  |
| Stream timeout or premature EOF | Retry after checking upstream connectivity; a partial reply is reported as an error, not a successful terminal.                     |

## External CLIProxyAPI gateway (optional)

The following deployment is separate from HappyClaw's built-in OAuth login.
Here CLIProxyAPI owns account credentials, refresh and pooling; HappyClaw
uses it as an ordinary third-party Anthropic-compatible provider.

### How the external gateway works

HappyClaw's provider system is Anthropic-native. The gateway sits between
HappyClaw and OpenAI: it owns the Codex OAuth login and token refresh, and
exposes an Anthropic-compatible `/v1/messages` endpoint (including tool use
and SSE streaming) that the Claude Agent SDK can consume directly.

```text
HappyClaw (Claude Agent SDK)
        │  Anthropic /v1/messages
        ▼
OAuth gateway (CLIProxyAPI, local Docker)
        │  Codex OAuth (device-code login, auto token refresh)
        ▼
ChatGPT / Codex backend
```

Two properties make this setup practical:

- The gateway translates between the Anthropic wire format and the Codex
  backend, so HappyClaw sees an ordinary third-party Anthropic-compatible
  provider.
- OAuth access tokens are short-lived; the gateway refreshes them
  automatically using the stored refresh token and rewrites the credential
  file in place.

### External prerequisites

- A ChatGPT account eligible for the Codex models you intend to use.
- In the ChatGPT web app, enable **Settings → Security → Device code
  login** for Codex on the account you plan to use. This is an
  account-level switch and must be enabled before the device-code flow
  below will succeed.
- Docker on the HappyClaw host.

### 1. Deploy the gateway

This guide uses [CLIProxyAPI](https://github.com/eceasy/cli-proxy-api)
(`eceasy/cli-proxy-api`), which supports Codex OAuth accounts and an
Anthropic-compatible endpoint.

Create a working directory and a `config.yaml`:

```yaml
host: ''
port: 8317
tls:
  enable: false
remote-management:
  allow-remote: false
  secret-key: ''
auth-dir: '/root/.cli-proxy-api'
api-keys:
  - 'hcw_YOUR_OWN_RANDOM_KEY'
debug: false
```

Generate the key yourself, for example with `openssl rand -hex 24`. This
key is what HappyClaw will present as the provider API key — pick a fresh
random value per gateway instance.

Start the container:

```bash
mkdir -p ~/cpa/auths
docker run -d --name cpa-server --restart always \
  -p 172.17.0.1:8317:8317 \
  -v ~/cpa/auths:/root/.cli-proxy-api \
  -v ~/cpa/config.yaml:/CLIProxyAPI/config.yaml:ro \
  eceasy/cli-proxy-api:latest
```

Port binding notes (the `172.17.0.1` example is for Linux Docker):

- `172.17.0.1` is the Docker bridge gateway. Binding there keeps the
  service unreachable from the public internet while still reachable from
  other containers — required when HappyClaw runs Agents in Docker
  (container execution mode) and reaches the host through the bridge.
- If HappyClaw runs Agents directly on the host (host execution mode),
  bind to `127.0.0.1` instead.

### 2. Log in with a device code

Run the device-code login inside the container:

```bash
docker exec -it cpa-server ./CLIProxyAPI -codex-device-login
```

It prints a code and a URL:

1. Open `https://auth.openai.com/codex/device`
2. Enter the printed device code
3. Sign in with the ChatGPT account you enabled device-code login for

On success the credential file (named after the account) appears in the
`auths/` directory, the gateway hot-reloads it without a restart, and the
account joins the serving pool.

### 3. Verify the gateway

```bash
# Model list
curl -s http://172.17.0.1:8317/v1/models \
  -H "Authorization: Bearer hcw_YOUR_OWN_RANDOM_KEY"

# Minimal Anthropic-compatible request
curl -s http://172.17.0.1:8317/v1/messages \
  -H "x-api-key: hcw_YOUR_OWN_RANDOM_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-5.6-sol","max_tokens":64,"messages":[{"role":"user","content":"Say OK"}]}'
```

The exact model names depend on what the gateway exposes for your account;
pick one from `/v1/models` (for example `gpt-5.6-sol`). Tool use and SSE
streaming on `/v1/messages` work as with any Anthropic-compatible
endpoint.

### 4. Add the provider in HappyClaw

In the web UI, go to **Provider setup** (`/setup/providers`), create a
third-party provider, and fill in:

| Field      | Value                                                       |
| ---------- | ----------------------------------------------------------- |
| Base URL   | `http://172.17.0.1:8317` (or `127.0.0.1:8317` in host mode) |
| API Key    | The `api-keys` value from the gateway config                |
| Model name | A model from `/v1/models`, e.g. `gpt-5.6-sol`               |

Enable the provider and switch the target workspace to it. No other
HappyClaw configuration changes are needed.

### 5. Multiple accounts

Two layouts are supported:

- **Single instance, account pool.** Log in with each account as in step
  2; every credential file in `auth-dir` joins one pool and requests
  rotate between accounts. Quotas remain per account.
- **One instance per account.** Run a second container with its own
  `auth-dir`, config file, API key and host port (for example `8318`).
  This gives hard account isolation — useful when different workspaces
  must be pinned to different accounts, since each HappyClaw provider
  points at exactly one instance.

Both layouts refresh tokens independently; keeping the container running
(`restart: always`) is what keeps refreshes happening.

### External gateway security notes

- Never expose the gateway port publicly. Bind to the Docker bridge or
  loopback only, and keep `remote-management.allow-remote: false`.
- Credential files and gateway config contain OAuth tokens and API keys.
  Keep them outside any repository, and restrict directory permissions to
  the deploying user.
- The Anthropic-compatible endpoint is authenticated only by the shared
  API key, so treat anything that can reach the port as able to spend the
  linked subscription quota.
- Signing out of all sessions in the ChatGPT web app, changing the
  password, or revoking the authorization invalidates the refresh token;
  re-run the device-code login to recover.

### External gateway troubleshooting

| Symptom                                                 | Likely cause / fix                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Device login rejected, asks to enable device code login | Enable the account-level switch (see Prerequisites) on the exact account being signed in, then retry    |
| HappyClaw suddenly reports 401/403                      | The stored refresh token was revoked — re-run device-code login; verify with the curl checks in step 3  |
| Model list works but requests fail                      | Confirm the model name exists in `/v1/models` for your account type                                     |
| Gateway unreachable from HappyClaw containers           | Check the port binding: containers reach the host via the Docker bridge (`172.17.0.1`), not `127.0.0.1` |
