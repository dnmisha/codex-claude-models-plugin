---
name: claude-models
description: Set up, activate, refresh, diagnose, or remove the combined GPT and Claude model picker in Codex, including native mixed-model subagents through the local router and Claude Agent SDK.
---

# GPT and Claude in Codex

Resolve `../../bin/setup.mjs` relative to this skill directory to its absolute path before running Node.

For the combined picker, run `install`, configure the Codex process to trust the certificate path from `certificate` through `CODEX_CA_CERTIFICATE`, then run `activate-router` and `doctor`. Preserve an existing custom CA bundle by making a separate combined copy. Never disable TLS verification. Desktop must inherit trust at startup; a shell export does not change an already running app. Do not claim desktop compatibility from CLI tests alone. Activation preserves the current default model and selects the shared provider. Restart Codex and use a new task once; GPT and Claude then stay together in the normal picker. Old tasks can retain their original provider. Do not claim they were migrated.

Authentication stays with the providers: `codex login` for ChatGPT and `claude auth login` for Claude. Ask the user to complete those interactively when needed. Never read, copy or print provider credentials. The router receives GPT authentication through Codex's documented proxy mode and does not give it to Claude.

For requested mixed delegation, use a named Claude role such as `claude_sonnet`, or an explicit discovered GPT model on a native subagent. Scope its task and use the advertised no-history-fork option when changing roles/models. Combined mode uses native v1 agents because OpenAI-encrypted v2 payloads cannot cross to Claude. Sonnet is verified for tool-using mixed delegation; Haiku has known mixed-delegation reliability limitations. Do not present every model combination as tested.

`activate-router` installs and trusts only its specific user-level startup command using native Codex hook metadata. It never enables global hook-trust bypass. `deactivate` restores the old provider/catalog/default and removes owned startup configuration and trust. `uninstall` also removes unchanged generated providers/catalogs/agents, retaining private runtime files and backups. Preserve and report edited-file/provider conflicts.

Other commands: `start`, `stop`, `doctor`, `certificate`. Stop sends an authenticated HTTPS shutdown request and never signals a server-supplied PID. Legacy HTTP listeners must be stopped through their original owned session or avoided with another port. All accept `--codex-home PATH`; `install` accepts `--port PORT`. Run upgrades from the latest installed plugin bundle. Model availability is refreshed by `install` and is not an access guarantee.

The legacy `claude` CLI profile and `activate --model sonnet` Claude-only mode remain available when explicitly desired. Use `activate-router` for the user's normal mixed picker request.

Codex executes tools. Claude supports text and function/custom tools, buffered structured decisions, and no API-key fallback. GPT streams are forwarded. Claude does not support images, audio, remote compaction, Codex output-schema mode or OpenAI server-side web search. Check the repository README for current provider notices and implementation limits.
