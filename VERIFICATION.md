# Verification record

## October 8, 2026: authenticated local transport

This branch replaces the bridge's HTTP provider/control routes with per-install verified HTTPS, removes server-PID signaling, preserves explicit existing Ollama routes without forwarding ChatGPT credentials, and updates compatible transitive dependency locks.

Current evidence on macOS:

- `npm run check`: strict TypeScript, 36 behavioral tests and plugin build.
- `npm run test:codex`: standalone Codex 0.154.0 and desktop bundled backend 0.162.0-alpha.2 consume the HTTPS provider with `CODEX_CA_CERTIFICATE` in isolated homes. Native tool roundtrip, GPT → Claude → Ollama → GPT switching, startup hook execution/deactivation pass with deterministic providers and inert credentials.
- The real Codex consumers reject a replacement server with an unrelated certificate before any HTTP request reaches it. The test interrupts Codex after the first rejected TLS handshake because its core may retry TLS errors independently of provider retry configuration.
- Control tests reject plaintext/untrusted-TLS listeners, malformed PIDs and redirects; shutdown requires authentication. A legacy occupied port is rejected before token/state/config changes, with the complete prior installation preserved.
- Root and runtime production-dependency audits report zero advisory findings at verification time. This is not an audit of dependency internals.
- Independent read-only security review found a migration rollback mismatch; port preflight and retaining a matching secure runtime after committed configuration address it. No other concrete bypass was identified in that review.
- An isolated bundled installation discovered models and started/stopped the HTTPS bridge. An initial live Claude probe was blocked by subscription authentication. After interactive re-login, a real Haiku subscription request through the verified HTTPS runtime returned the exact inert probe string with no tools. CLI login remained valid afterward. The reason for the earlier auth loss was not established. No live GPT/Ollama inference or desktop GUI trust/restart test is claimed.

Desktop backend testing is an isolated process test. The running GUI still needs its own certificate-trust setting at startup. Do not infer that it inherits a terminal export. Some local standalone app-server starts exceeded the original 15-second model-list deadline; the final full consumers passed without changing that deadline. This intermittent startup behavior remains a limitation.

The September record below describes the original upstream release; its live-account results are historical, not new evidence for this branch.


Verification date: September 14, 2026. Local platform: macOS arm64. Claude Agent SDK: 0.3.270. Codex CLI: 0.154.0. Desktop bundled backend: 0.154.0-alpha.6.2.

## v0.2 combined picker

The shared provider and combined catalog replace v0.1's separate-provider limitation. GPT authentication comes from Codex's documented OpenAI proxy mode; no OpenAI credential file is read by the router. OpenAI request/response bytes are forwarded, and Claude uses the existing SDK decision adapter.

### Automated evidence

- Strict TypeScript checks and 28 behavioral tests cover message/tool conversion, SDK execution isolation, subscription gating before prompt delivery, errors and token accounting; local authentication, browser-origin rejection, limits and cancellation; fixed OpenAI destinations, credential isolation, status/refresh headers and compaction forwarding; catalog preservation; configuration upgrade, rollback and conflicts.
- A real Codex consumer performs a native shell read through the Claude adapter fixture and returns the real command output to the provider.
- A second real Codex consumer lists both model families and switches GPT → Claude → GPT within a single task. Its deterministic providers verify routing without model API calls.
- The same consumer registers one specific startup hook through native hook metadata, verifies its execution, and checks that deactivation removes its hook/trust configuration.
- These consumer checks run against the standalone CLI and the desktop app's bundled backend. CI repeats the credential-free checks on Linux and macOS.
- Plugin manifest and skill validation, reproducible bundle checks and production-dependency auditing accompany release verification.

The deterministic consumers use inert credentials and a temporary workspace. Their CLI sandbox is disabled to keep OS sandbox provisioning outside the transport test. They are not evidence of live model accuracy or sandbox enforcement.

### Live subscription evidence

1. A GPT request passed through a custom loopback proxy with Codex's existing ChatGPT authentication and returned the requested exact probe string.
2. The combined provider served independent GPT and Claude tasks without switching provider configuration.
3. One real app-server task switched `gpt-5.6-sol` → `claude-sdk-haiku` → `gpt-5.6-sol`; all three turns returned their respective requested probe strings. Both families were visible in `model/list`.
4. A GPT Sol parent spawned a native Claude Sonnet child. The child's actual shell results contained the fixture data; the parent waited and reported it.
5. A Claude Sonnet parent spawned a native GPT Luna child. The child read a natural-language fixture and returned its exact sentence to the parent.
6. After stopping the router, a new Codex task ran the specifically trusted SessionStart hook, restarted the router and completed its GPT request. No global hook-trust bypass was used.
7. Earlier v0.1 live checks verified Claude native file reads and freeform `apply_patch` followed by a read-back check; those execution boundaries remain in place.

Live probes used existing subscription logins. No provider tokens, account identifiers or raw private request captures are included in this repository.

### Compatibility findings and limits

- The combined catalog deliberately uses native **v1** agents for all models. v2 cross-model tests failed on encrypted inter-agent payloads. The router does not claim to decrypt those payloads. The Claude-only profile retains v2.
- Sonnet is the verified Claude choice for tool-using mixed delegation. Haiku repeatedly reported unavailable file tools when delegated from a GPT parent, although it passed simple main-task and same-task model-switching checks. Do not generalize Sonnet's result to every model combination.
- Model quality is not guaranteed. One early synthetic identifier fixture was misinterpreted as a placeholder; clearer transcript formatting improved switching, and a natural-language fixture verified the reverse delegation path.
- The desktop **backend** accepted the combined catalog and model switching. GUI refresh requires an app restart and a new task; pre-existing tasks can retain their original provider. GUI behavior is not inferred solely from CLI results.
- Opus and Fable were discovered but not exercised live. Long-context switching, every private GPT feature, Windows, heavy concurrent use and live remote compaction were not tested. Remote-compaction forwarding has deterministic HTTP coverage.
- Unsigned plugin hooks are restricted by current Codex. Startup uses one installer-owned user-level hook with its hash returned by Codex's `hooks/list` API. The installer trusts only that exact source/command, preserving unrelated hook configuration.

## Review and recovery

Reviewed call paths: catalog → setup → Codex model manager; setup → native hook RPC → startup helper → server; server → either fixed OpenAI forwarding or SDK decision adapter; both routes → native Codex tool execution and history. Source inspection alone is a floor, so actual consumer and live checks cover the protocol and configuration-driven boundaries.

Review corrections included the provider-routing architecture, v1 agent compatibility, OpenAI-header isolation, fixed destinations and redirect rejection, body/stream forwarding, literal tool-result handling, specific startup trust, canonical hook source paths and preservation of unrelated configuration.

`deactivate` restores owned defaults and removes owned startup settings/trust. `uninstall` also preflights generated-file contents before deletion. Exact configuration backups and the private runtime remain available. This review does not audit the internals of Codex, Anthropic's executable, or all third-party dependencies.


## October 8 follow-up: SDK decision budget

A GUI task reported `error_max_turns` with the adapter's fixed three-turn SDK budget. Increased the bounded internal decision budget to 12, keeping the 180-second outer deadline, cancellation, subscription gate and disabled SDK execution tools. Exhaustion now reports `sdk_turn_limit` instead of generic login advice. No automatic whole-request retries are introduced.

Validation: the new four-turn structured-result regression failed before the change and passed afterward; all 38 tests, TypeScript and build pass. The working router was updated with backup bundles retained. A real Sonnet High task on desktop backend 0.162.0-alpha.2 executed a Codex command to read a synthetic fixture and returned its exact content. An earlier live attempt completed with a tool-unavailable answer; model/tool-use reliability is not guaranteed by the increased budget.

The desktop launcher uses a separate OS session via subprocess start_new_session=True to avoid sharing the Terminal controlling TTY. Session isolation was verified with a harmless child process; the next actual GUI launch is still a user action. The current GUI and app-server were confirmed to contain CODEX_CA_CERTIFICATE.


## October 8 follow-up: SDK tool attempts and context usage

The supplied desktop task executed one real Codex command, compacted context, and then claimed several unavailable tools without corresponding outer tool-call records. A synthetic live probe reproduced an SDK-native `write_stdin` attempt receiving `No such tool available`, while the outer Codex tool inventory and dispatch remained valid.

The runner now intercepts SDK assistant tool-use blocks, accepts only exact advertised identities or unambiguous short names, validates tool choice/payload, and yields the request to Codex. SDK built-in tools remain disabled; unadvertised or ambiguous names fail closed. The SDK session is aborted and closed before advancing its executor loop. Custom payloads are preserved only as raw strings or the explicit `input` wrapper.

SDK modelUsage aggregates input across internal turns; this inflated Codex context accounting. Responses now use the latest assistant context input/cache counts, while retaining aggregate output usage for structured-result steps. Intercepted native calls report their assistant usage.

Validation: TypeScript, build and 42 unit/integration tests; deterministic current desktop consumer tool round trip; live Sonnet multi-step synthetic read using exec_command, write_stdin and another exec_command, then exact fixture answer. The native-attempt branch has deterministic allowlist, custom, ambiguous-name and tool-choice coverage; live model behavior does not trigger that branch on every run. Opt-in reproduction: CODEX_BIN=<desktop codex path> npx tsx scripts/sdk-tool-smoke.ts (uses Claude subscription and temporary files). No private project audit was run.
