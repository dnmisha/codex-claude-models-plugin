import { query, type Options, type ModelUsage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { BridgeError, outputSchemaFor, preparePrompt, validateDecision, type ResponsesRequest, type RunStep, type Usage } from './contracts.js';
import { discoverCatalog, type ClaudeModel } from './catalog.js';
import { VERSION } from './version.js';

export function subscriptionEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = {...source};
  for (const key of Object.keys(result)) {
    if (/^(ANTHROPIC_|OPENAI_|CODEX_API_KEY$|CHATGPT_ACCESS_TOKEN$|CHATGPT_AUTH_TOKEN$|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDECODE$|CLAUDE_CODE_SESSION_ID$)/.test(key)) delete result[key];
  }
  result.CLAUDE_AGENT_SDK_CLIENT_APP = `codex-claude-models/${VERSION}`;
  return result;
}

export function isolatedOptions(cwd: string): Options {
  return {
    cwd, env: subscriptionEnvironment(), tools: [], settingSources: [], strictMcpConfig: true,
    mcpServers: {}, plugins: [], persistSession: false, permissionMode: 'dontAsk', permissionPrompts: 'none',
    hooks: {PreToolUse: [{hooks: [async input => {
      if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'StructuredOutput') return {};
      return {hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Codex executes all tools.'}};
    }]}]},
  };
}

export function usageFromModels(models: Record<string, ModelUsage>): Usage {
  const rows = Object.values(models);
  const input = rows.reduce((sum, m) => sum + m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens, 0);
  const output = rows.reduce((sum, m) => sum + m.outputTokens, 0);
  return {input_tokens: input, input_tokens_details: {cached_tokens: rows.reduce((sum, m) => sum + m.cacheReadInputTokens, 0)},
    output_tokens: output, output_tokens_details: {reasoning_tokens: rows.reduce((sum, m) => sum + (m.thinkingTokens ?? 0), 0)}, total_tokens: input + output};
}

export async function inspectSdk(cwd: string) {
  let release!: () => void;
  const idle = new Promise<void>(resolve => {release = resolve;});
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 30000);
  const session = query({prompt: (async function* () {await idle;})(), options: {...isolatedOptions(cwd), abortController}});
  try {
    const account = await session.accountInfo();
    const models = discoverCatalog(await session.supportedModels());
    return {authenticated: account.apiProvider === 'firstParty' && !!account.subscriptionType,
      subscriptionType: account.subscriptionType ?? null, models};
  } finally {clearTimeout(timer); release(); session.close();}
}

export function sdkRunner(cwd: string, models: ClaudeModel[], queryImpl: typeof query = query): RunStep {
  return async (request: ResponsesRequest, signal: AbortSignal) => {
    const model = models.find(m => m.id === request.model);
    if (!model) throw new BridgeError(400, 'unknown_model', 'Unknown Claude model. Run setup install to refresh the catalog.');
    const prepared = preparePrompt(request);
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
    const effort = request.reasoning?.effort;
    const options: Options = {...isolatedOptions(cwd), model: model.sdkModel, systemPrompt: prepared.system,
      // Structured output may need internal schema-repair turns; these are not Codex tool executions.
      abortController, maxTurns: 12, outputFormat: {type: 'json_schema', schema: outputSchemaFor(request)},
      ...(effort && model.efforts.includes(effort) ? {effort: effort as Options['effort']} : {})};
    let session: ReturnType<typeof query> | undefined;
    let release!: () => void;
    const authenticated = new Promise<void>(resolve => {release = resolve;});
    let permitted = false;
    let contextUsage: Usage | undefined;
    try {
      session = queryImpl({prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await authenticated;
        if (permitted && !signal.aborted) yield {type: 'user', session_id: '', parent_tool_use_id: null,
          message: {role: 'user', content: prepared.prompt}};
      })(), options});
      const account = await session.accountInfo();
      if (account.apiProvider !== 'firstParty' || !account.subscriptionType) {
        throw new BridgeError(401, 'subscription_required', 'A Claude subscription login is required. Run claude auth login. API-key fallback is disabled.');
      }
      permitted = true; release();
      for await (const message of session) {
        if (message.type === 'assistant' && message.message?.usage) {
          const tokens = message.message.usage;
          const cached = tokens.cache_read_input_tokens ?? 0;
          const input = tokens.input_tokens + cached + (tokens.cache_creation_input_tokens ?? 0);
          contextUsage = {input_tokens: input, input_tokens_details: {cached_tokens: cached}, output_tokens: tokens.output_tokens,
            output_tokens_details: {reasoning_tokens: 0}, total_tokens: input + tokens.output_tokens};
        }
        if (message.type === 'assistant' && message.message?.content) {
          const nativeCalls = message.message.content.filter(part => part.type === 'tool_use' && part.name !== 'StructuredOutput');
          if (nativeCalls.length) {
            // The SDK executor remains disabled. Yield advertised calls to Codex
            // before the SDK produces misleading 'No such tool' feedback.
            const calls = nativeCalls.map(part => {
              if (part.type !== 'tool_use') throw new BridgeError(502, 'invalid_decision', 'Invalid SDK tool request.');
              const exact = prepared.tools.filter(tool => tool.key === part.name);
              const candidates = exact.length ? exact : prepared.tools.filter(tool => tool.name === part.name);
              if (candidates.length !== 1) throw new BridgeError(502, 'unknown_tool', 'Claude requested an unknown or ambiguous SDK tool.');
              const tool = candidates[0]!;
              const input = tool.kind === 'function' ? JSON.stringify(part.input)
                : typeof part.input === 'string' ? part.input
                : part.input && typeof part.input === 'object' && 'input' in part.input && typeof part.input.input === 'string' ? part.input.input : null;
              if (input === null) throw new BridgeError(502, 'invalid_arguments', 'Claude returned an invalid custom tool payload.');
              return {kind: tool.kind, name: tool.key, input};
            });
            abortController.abort();
            return {decision: validateDecision({text: '', calls}, request), usage: contextUsage ?? usageFromModels({})};
          }
        }
        if (message.type !== 'result') continue;
        if (message.subtype === 'error_max_turns') {
          throw new BridgeError(502, 'sdk_turn_limit', 'Claude reached the internal structured-decision turn limit before producing a validated result. Retry a smaller step; the SDK did not report a login or network failure.');
        }
        if (message.subtype !== 'success' || message.is_error) {
          throw new BridgeError(502, 'claude_failed', `Claude SDK did not complete successfully (${message.subtype}). Check Claude login, usage limits and model access.`);
        }
        const usage = usageFromModels(message.modelUsage);
        // SDK modelUsage sums input across internal turns. Codex uses input
        // usage to size the context, so report the latest actual context instead.
        if (contextUsage) {
          usage.input_tokens = contextUsage.input_tokens;
          usage.input_tokens_details = contextUsage.input_tokens_details;
          usage.total_tokens = usage.input_tokens + usage.output_tokens;
        }
        return {decision: validateDecision(message.structured_output, request), usage};
      }
      throw new BridgeError(502, 'incomplete_sdk', 'Claude SDK ended without a result.');
    } finally {release(); signal.removeEventListener('abort', abort); session?.close();}
  };
}
