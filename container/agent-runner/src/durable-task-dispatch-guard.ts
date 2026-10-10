import type {
  HookCallback,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * Opt-in PreToolUse guard that redirects background Task dispatch to the
 * durable scheduler (`run_background_task`).
 *
 * Why deny-and-redirect instead of silently rewriting the call:
 *
 * - A PreToolUse hook can only modify the input of the *same* tool; it cannot
 *   convert a `Task` call into an MCP `run_background_task` call.
 * - Even if it could, silent conversion would be semantically wrong for the
 *   legitimate use of in-runner sub-agents: short in-turn parallel helpers
 *   share the parent's context and return their result within the same turn
 *   (and remain addressable via SendMessage). A durable scheduled run gets no
 *   shared context and delivers separately, so a silent swap would break the
 *   parent's expectations without the model noticing.
 * - Denying with an explicit reason forces the model to make the durability
 *   choice itself: re-issue as `run_background_task` (survives provider
 *   rotation and restarts) or re-issue the Task with
 *   `run_in_background: false` (declared in-turn helper).
 *
 * The guard is enabled per workspace via the environment variable
 * `HAPPYCLAW_DURABLE_TASK_DISPATCH=redirect`, which reaches the runner through
 * the normal workspace custom-env plumbing in both host and container modes.
 */

const ENV_KEY = 'HAPPYCLAW_DURABLE_TASK_DISPATCH';

const TASK_TOOL_NAMES = new Set(['Task', 'Agent']);

const REDIRECT_REASON =
  'This workspace routes long-lived background work through the durable scheduler. ' +
  'If this work must survive provider rotation or a restart (research, batch jobs, ' +
  'long builds/tests/deploys), re-issue it with the run_background_task tool, giving ' +
  'it a complete self-contained prompt. If it is a short in-turn parallel helper ' +
  'whose result you need within this turn, re-issue this Task call with ' +
  'run_in_background: false.';

export function isDurableTaskDispatchEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (env[ENV_KEY] ?? '').trim().toLowerCase() === 'redirect';
}

/**
 * PreToolUse hook: when durable dispatch is enabled, deny main-thread
 * background Task/Agent dispatches with a redirect message. Sub-agents' own
 * nested Task calls are left alone (their completion notifications never reach
 * the main agent anyway), and `run_in_background: false` declares an in-turn
 * parallel helper, which stays allowed.
 */
export function createDurableTaskDispatchGuard(): HookCallback {
  return async (input) => {
    const preTool = input as PreToolUseHookInput;
    if (
      // Read the env at call time so the switch can be toggled per run/test.
      !isDurableTaskDispatchEnabled() ||
      preTool.hook_event_name !== 'PreToolUse' ||
      !TASK_TOOL_NAMES.has(preTool.tool_name) ||
      // agent_id is only present inside a sub-agent; guard main thread only.
      preTool.agent_id
    ) {
      return {};
    }
    const toolInput = preTool.tool_input as
      | { run_in_background?: unknown }
      | null
      | undefined;
    if (toolInput && toolInput.run_in_background === false) {
      // Declared in-turn parallel helper: result is consumed within this turn.
      return {};
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: REDIRECT_REASON,
      },
    };
  };
}
