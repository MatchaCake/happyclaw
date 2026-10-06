# Built-in Codex protocol compatibility

The reference is CLIProxyAPI commit
`a2976eb8a303f11b4ea5177bce9f9ff752634dfc`. The HappyClaw starting commit was
`930b7874e4d597e5f81cdb179a8a47ce168e2f02`. The implementation remains
TypeScript inside the HappyClaw host service; it uses Claude Agent SDK for the
agent loop and adds no Go runtime or external gateway process.

The port and derived compatibility fixtures retain the original
[CLIProxyAPI MIT notice](licenses/CLIProxyAPI-MIT.txt).

## Request mapping

| Input                          | Previous behavior                                 | Aligned behavior                                                                                           | Reference                                                               |
| ------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| System and reminders           | Combined all system text into global instructions | Developer input for top-level system; timed user reminders after matching tool feedback                    | `codex_claude_request.go`, `common/claude_system.go`                    |
| Long MCP tool names            | Sent unchanged                                    | Unique names at most 64 bytes, restored using the original request's tool map                              | `buildShortNameMap`, `buildReverseMapFromClaudeOriginalShortToOriginal` |
| Long call IDs                  | Sent unchanged                                    | Stable SHA-256 suffix shared by calls and results                                                          | `shortenCodexCallIDIfNeeded`                                            |
| Schema metadata and patterns   | Sent unchanged                                    | Remove provider-incompatible schema annotations/patterns, preserving property names and literal values     | `normalizeToolParameters`, `util/claude_schema.go`                      |
| Large scalar const unions      | Sent every oneOf/anyOf branch                     | Compact at least eight pure, unique const branches into an equivalent enum at supported property positions | `helps/NormalizeCodexToolSchemas`                                       |
| Parallel tool opt-out          | Dropped                                           | `disable_parallel_tool_use` maps to `parallel_tool_calls`                                                  | `ConvertClaudeRequestToCodex`                                           |
| Images interspersed with text  | Text combined before images                       | Preserve block ordering                                                                                    | `ConvertClaudeRequestToCodex`                                           |
| Image in tool feedback         | Moved into an adjacent user message               | Structured output remains attached to the call ID                                                          | `ConvertClaudeRequestToCodex`                                           |
| PDF document                   | Rejected                                          | Base64 PDF maps to Responses `input_file`                                                                  | `ConvertClaudeRequestToCodex`                                           |
| Thinking and structured output | Dropped SDK settings                              | Budget/adaptive effort and JSON-schema output mapped to Responses; optional schemas downgrade strictness   | `ConvertClaudeRequestToCodex`, `thinking/convert.go`                    |
| Native web search              | Unsupported                                       | Typed tools, named selection, domains/location and sources; server tool history accepted                   | `codex_claude_request.go`, `codex_claude_response_web_search.go`        |
| Reasoning replay               | Only private HappyClaw envelopes recognized       | Native GPT transport signatures and legacy envelopes accepted; replay omits the upstream reasoning ID      | `signature/gpt_validation.go`, `CompatibleSignatureForProvider`         |

## Response and transport mapping

| Output or condition                      | Previous behavior                                        | Aligned behavior                                                             | Reference                                                                       |
| ---------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Tool argument deltas                     | Ignored until item done; initial arguments could be lost | Buffer by item/call/output identity; emit each argument byte once            | `codexFunctionCallStream`, `appendCodexFunctionCallQueue`                       |
| Parallel calls                           | Multiple blocks could remain open                        | Serial Anthropic blocks with deferred content                                | `codex_claude_parallel_function_calls_test.go`                                  |
| Multiple text parts                      | Shared one text block                                    | Track item/content identity with correct block boundaries                    | `ConvertCodexResponseToClaude`                                                  |
| Multipart thinking                       | Parts ran together; early signatures could be used       | One block per reasoning item, blank-line separators and the final signature  | `finalizeCodexThinkingBlock`                                                    |
| Final-only response output               | Missing content or tool call                             | Hydrate missing final content without duplicating streamed bytes             | `appendCodexFunctionCallsFromTerminal`, `ConvertCodexResponseToClaudeNonStream` |
| Stop and usage fields                    | Basic end/limit/tool reasons; cache reads only           | Preserve refusal/sequence/context reasons, cache writes and reasoning detail | `codexStopReason`, `extractResponsesUsage`, `setClaudeReasoningUsage`           |
| Successful terminal with open connection | Waited for HTTP EOF and could time out                   | Finish at the Responses terminal and cancel the reader                       | `codex_executor_execute.go`, `codex_executor_stream.go`                         |
| SSE fragments and malformed data         | Incomplete framing; malformed JSON was skipped           | Handle UTF-8 fragments, CR/LF and multiline data; fail malformed frames      | Codex executors and compatibility tests                                         |
| HTTP failures                            | Generic `api_error`                                      | Status-specific Anthropic errors and valid retry hints                       | Executor/Anthropic compatibility boundary                                       |
| Late reasoning signature                 | Could close thinking before the final cipher arrived     | Final cipher takes priority; added cipher is a fallback only at terminal     | `finalizeCodexThinkingBlock`                                                    |
| Empty aborted or cancelled response      | Could return empty successful output                     | Reject reference-defined empty aborts and explicit unsuccessful terminals    | `helps/IsCodexTerminalEmptyIncomplete`, Codex executor terminal handling        |
| SDK session identity                     | No stable cache hint                                     | Model/session/agent cache identity with provider/account isolation           | `helps/claude_code_session.go`, `cacheHelper`                                   |

## Intentional runtime differences

- HappyClaw explicitly requests `reasoning.summary: auto` for its thinking UI.
- Empty tools and unused tool-choice/parallel fields are removed, matching the
  final Codex executor cleanup rather than the raw translator output.
- HappyClaw's provider override and current model catalog constrain the final
  reasoning effort; a removed `minimal` level is normalized to `low`.
- URL images are rejected with 400. The pinned reference translator drops
  them; silent image loss is unsuitable for the HappyClaw request boundary.
- Gateway authentication, bounded rate/body/event/aggregation budgets,
  backpressure, cancellation and idle deadlines remain in force. CLIProxyAPI's
  account pools, WebSocket continuation, distributed replay cache and management
  service are separate capabilities, outside this Messages-to-Responses port.
- Native reasoning replay travels in the SDK conversation. The actual SDK
  regression checks that the next request carries the original encrypted
  content. No shared server history cache is created.
- Streaming and nonstream thinking use the same blank-line summary separators;
  the reference's separate nonstream converter concatenates those parts.
- Malformed final tool JSON and conflicting already streamed snapshots fail
  explicitly, instead of becoming an empty tool invocation or partial success.

## Verification

`tests/fixtures/codex-cliproxy-a2976.json` contains independently generated
request payloads and original Go SSE output for 34 cases. The differential test
compares all business fields after only the documented runtime normalizations.
Golden data is generated with `scripts/reference/codex-claude-reference.go`
inside a disposable checkout of the pinned CLIProxyAPI commit. Feed the existing
corpus to the harness's standard input to regenerate it; the Go implementation
is never loaded by the HappyClaw application.

Additional tests cover interleaved tools, final-only snapshots, signatures,
schema literals, transport cancellation/failures and session isolation.
`tests/e2e/codex-gateway-sdk.mjs` runs the installed SDK and CLI against a real
local HTTP gateway and a controlled Responses SSE server. It executes Bash and
a long-name SDK MCP tool, writes actual files, replays encrypted reasoning and
checks cache-exclusive usage on the second turn. Its network boundary rejects
any request to the real subscription backend.
The second turn also exercises native search result blocks through the actual SDK.

Local/CI and Mac mini results are reported separately in the deployment evidence.
A controlled upstream is evidence of SDK/protocol compatibility; live ChatGPT
subscription access still requires a valid provider OAuth login.
