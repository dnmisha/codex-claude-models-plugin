# GPT and Claude in one Codex picker

A Codex plugin that keeps **GPT and Claude models together in the normal model picker**. A local provider routes GPT requests through your existing Codex ChatGPT login and Claude requests through the official [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) and your local Claude subscription login.

Select a different model without switching profiles or providers. Codex keeps its native tools, file changes, approvals and subagent UI. The plugin does not patch the Codex application.

**Experimental v0.2.0.** Live GPT → Claude → GPT switching in one task and mixed native delegation were verified. See [VERIFICATION.md](VERIFICATION.md) for the exact evidence and limits.

## Install or upgrade

Requirements: macOS or Linux, Node.js 22+, npm, OpenSSL, Codex CLI 0.154.0 or a compatible desktop build, a Codex ChatGPT login, and a Claude subscription login.

```sh
codex login
claude auth login

codex plugin marketplace add https://github.com/Reidond/codex-claude-models-plugin.git
codex plugin add codex-claude-models@personal
```

For an existing installation:

```sh
codex plugin marketplace upgrade personal
codex plugin add codex-claude-models@personal
```

The repository uses the scaffold's `personal` marketplace name. If another marketplace already uses that name, use a clone rather than replacing it:

```sh
git clone https://github.com/Reidond/codex-claude-models-plugin.git
cd codex-claude-models-plugin
node plugins/codex-claude-models/bin/setup.mjs install
export CODEX_CA_CERTIFICATE="$(node plugins/codex-claude-models/bin/setup.mjs certificate)"
node plugins/codex-claude-models/bin/setup.mjs activate-router
```

With the plugin installed, ask Codex:

```text
Use $claude-models to install and activate the combined GPT and Claude picker.
```

Or run the bundled setup from the installed path reported by `codex plugin list`:

```sh
node /path/to/codex-claude-models/bin/setup.mjs install
node /path/to/codex-claude-models/bin/setup.mjs activate-router
node /path/to/codex-claude-models/bin/setup.mjs doctor
```

The local providers now use verified **HTTPS**. Installation creates a private per-install TLS identity under `$CODEX_HOME/claude-models/tls`. Before sending requests, start the Codex process with `CODEX_CA_CERTIFICATE` pointing to the path printed by `setup.mjs certificate`:

```sh
export CODEX_CA_CERTIFICATE="$(node /path/to/codex-claude-models/bin/setup.mjs certificate)"
codex
```

If you already configure a custom CA bundle, append the bridge certificate to a separate copy of that bundle and point Codex at the combined copy; do not overwrite the original. Do not disable certificate verification. The generated certificate expires after one year; an expired identity fails closed and must be deliberately replaced along with client trust.

For desktop, the app/backend must inherit this setting **at startup** (or use an explicitly trusted certificate through your platform). Exporting it in a terminal does not change an already running app. CLI validation does not establish desktop GUI compatibility; desktop activation requires checking its own trust configuration. Setup does not alter global OS trust or restart your app.

Legacy HTTP installations: setup rotates the local token and replaces provider URLs. It will never query or signal the old plaintext listener. An occupied legacy port is rejected before state/token/config mutation. If that listener still occupies the port, stop it through its original owned process/session or install on a different `--port`; do not use a PID from an HTTP health response. If a process wins the port after preflight and startup fails after configuration commits, the new matching HTTPS runtime/config are retained; free the port and run `start`. The installer reports this partial startup failure and retains any runtime backup.

**Restart Codex with certificate trust configured and start a new task once after activation.** Both model families then remain in the picker. Your current default model is preserved. Tasks created before activation can retain their original provider; selecting Claude in one of those old tasks does not retroactively reroute it.

Setup discovers Claude models from the SDK and merges them with your configured or cached OpenAI catalog, falling back to Codex's bundled catalog. It preserves model names, visibility and capabilities, with one deliberate compatibility change: the combined catalog uses native **v1 subagents** for both families. Run `install` again to refresh model availability; a catalog entry does not guarantee your account has access to that model.

When an existing Ollama launch configuration has both `openai_base_url` and `ollama-launch-codex-routing.json`, setup snapshots its explicitly listed model routes. Those models go to the existing `http://127.0.0.1` bridge with their request bytes preserved. ChatGPT authorization, account identifiers, cookies and the router token are stripped. GPT models retain fixed official HTTPS destinations. Ollama's upstream remains its existing HTTP loopback trust boundary; this plugin does not authenticate that separate service. Arbitrary remote custom providers are unsupported.

## Native subagents

In a new task using the combined router, ask for a Claude role:

```text
Use claude_sonnet as a native subagent to review these changes. Give it a bounded task, wait for it, and compare its findings with yours.
```

A Claude parent can also choose a GPT model for a native subagent. Use the model and fork options advertised by your Codex version. Start cross-model children without a full-history fork; Codex requires full-history forks to inherit their parent's role/model settings.

**Why v1?** Codex's v2 inter-agent messages can contain OpenAI-encrypted payloads. Claude cannot decrypt those, and GPT cannot decode Claude text mislabeled as encrypted content. Native v1 messages support the mixed-provider boundary. Version 0.2 therefore selects v1 in the combined catalog; the separate Claude-only profile retains v2.

Sonnet is the verified choice for tool-using mixed delegation. Haiku passed main-task and model-switching checks, but repeatedly reported unavailable tools in GPT-parent delegation tests. That limitation is recorded rather than presented as a fully passing combination.

## How routing works

```text
Normal Codex model picker: GPT / Claude / existing Ollama models
  -> one authenticated HTTPS loopback provider
     -> GPT: forward Responses bytes and SSE to OpenAI
     -> Claude: Claude Agent SDK produces a Codex decision
     -> Ollama: existing loopback Codex bridge, without ChatGPT credentials
  -> Codex executes tools and displays results
```

The router uses Codex's documented [`requires_openai_auth` proxy mode](https://learn.chatgpt.com/docs/auth#alternative-model-providers). Codex supplies its current OpenAI authorization headers; this plugin does not read OpenAI credential files. GPT requests go only to fixed official ChatGPT Codex endpoints. Redirects are rejected. Status codes, auth-refresh hints, rate-limit headers, streamed events and remote-compaction responses are retained.

TLS authenticates the bridge before credentials or prompts are sent. Setup uses the owned certificate for health and authenticated shutdown; it never signals a PID returned by a server. Local access requires a separate random `X-Codex-Router-Token`, which is never forwarded upstream. Browser cookies are not forwarded. OpenAI headers are never supplied to the Claude adapter, and OpenAI credential environment variables are removed from the SDK subprocess environment. The service logs no prompts or credentials.

For Claude, SDK execution tools are disabled. The adapter requests a structured decision containing text and Codex function/custom tool calls; Codex executes those calls under its own permissions. The SDK checks the local subscription account before receiving the prompt and never falls back to API keys.

## Startup and configuration

State lives under `$CODEX_HOME/claude-models`, normally `~/.codex/claude-models`. Setup downloads the pinned Agent SDK there; Anthropic binaries are not redistributed in this repository.

`activate-router` registers one user-level SessionStart command that starts the local router on demand. It asks Codex for that exact command's native hook metadata and trusts only its returned hash. It does not use a global hook-trust bypass. This is user-level configuration because current Codex builds restrict unsigned plugin hooks. The command includes the explicit Codex home, so custom homes work correctly.

Configuration changes are backed up byte-for-byte. Parsed unrelated settings are preserved, though TOML formatting/comments may change. The installer records its providers, catalogs, agent files, selected settings and startup-hook trust so it can restore them. It refuses conflicting provider or generated-file edits. Removing a hook can leave an empty group to avoid renumbering later hooks and invalidating their trust.

All commands accept `--codex-home PATH`. `install` accepts `--port PORT` (default `47832`); `activate-router` accepts `--model MODEL_ID` if you explicitly want to change the default.

```sh
node /path/to/codex-claude-models/bin/setup.mjs doctor
node /path/to/codex-claude-models/bin/setup.mjs start
node /path/to/codex-claude-models/bin/setup.mjs stop
node /path/to/codex-claude-models/bin/setup.mjs deactivate
node /path/to/codex-claude-models/bin/setup.mjs uninstall
codex plugin remove codex-claude-models@personal
```

`deactivate` restores the previous provider/catalog/default and removes the owned startup hook/trust. `uninstall` also removes unchanged generated providers, catalogs and agents; private runtime files and backups remain available for recovery. Run setup upgrades from the latest plugin bundle.

The older Claude-only mode remains available for users who do not want the combined router:

```sh
codex --profile claude
# Optional Claude-only desktop default:
node /path/to/codex-claude-models/bin/setup.mjs activate --model sonnet
```

## Limits

- The combined router requires ChatGPT login for GPT. It is not an API-key proxy. Only the existing explicitly configured Ollama loopback bridge is supported in addition to GPT and Claude.
- GPT uses SSE through the proxy; WebSocket transport is disabled. This is not a promise of parity with every private Codex backend feature.
- Claude accepts text and Codex function/custom tools. Images, audio, Codex output-schema mode, server-stored response IDs and remote compaction are unsupported on the Claude route.
- OpenAI server-side web search remains available on the GPT route. Its tool definition is omitted for Claude; compatible Codex-executed browser/search functions can still be used when present.
- Claude responses are buffered until a structured decision completes. GPT streams are forwarded as received.
- The bridge binds only to `127.0.0.1`, rejects browser Origin headers, caps request bodies at 8 MiB and inference at 6 concurrent requests. Claude steps time out after 180 seconds; OpenAI forwarding has a 300-second idle timeout. Client disconnection cancels the corresponding request.
- No adapter-level retries or remote shared-subscription hosting. Codex/SDK releases, authentication behavior and subscription entitlements can change.

## Subscription terms

Anthropic's [June 15 update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says its proposed billing change is paused and SDK/noninteractive usage still draws from subscription limits. Its [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) separately restricts third-party products offering claude.ai login/rate limits without approval. These notices were checked September 14, 2026; technical compatibility is not Anthropic approval, and this project claims none.

Existing account limits and any extra-usage settings still apply. The plugin does not change them or implement a replacement login flow.

## Development

```sh
npm ci
npm run check
npm run test:codex
```

Tests cover routing/credential isolation, forwarding/error/cancellation behavior, SDK decisions, configuration migration/rollback, and real Codex protocol consumption. The consumer tests use deterministic providers and inert credentials: they verify native tool execution and switching GPT → Claude → Ollama → GPT in one task over verified TLS, plus rejection of an untrusted replacement server before HTTP credential disclosure without making model API requests. Live subscription and delegation checks are separate.

CI runs on macOS and Linux and checks reproducible plugin bundles. Adapter source is MIT licensed; bundled library notices are included, and the separately downloaded Claude SDK retains its own license and terms.
