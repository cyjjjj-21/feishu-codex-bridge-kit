# Feishu Codex Bridge Kit

An extracted, hardened bridge kit for using Codex from Feishu/Lark. This repo started from [op7418/Claude-to-IM-skill](https://github.com/op7418/Claude-to-IM-skill) and keeps only the bridge-oriented pieces plus the extra fixes we added for long-running Feishu/Codex workflows.

[中文文档](README_CN.md)

> Attribution: the original bridge architecture and cross-IM groundwork come from [op7418/Claude-to-IM-skill](https://github.com/op7418/Claude-to-IM-skill) and the upstream [claude-to-im](https://github.com/op7418/claude-to-im). This repo packages a Feishu/Codex-focused derivative with override patches, diagnostics, and packaging improvements.

---

## How It Works

This skill runs a background daemon that connects your IM bots to Claude Code or Codex sessions. Messages from IM are forwarded to the AI coding agent, and responses (including tool use, permission requests, streaming previews) are sent back to your chat.

```
You (Telegram/Discord/Feishu/QQ)
  ↕ Bot API
Background Daemon (Node.js)
  ↕ Claude Agent SDK or Codex SDK (configurable via CTI_RUNTIME)
Claude Code / Codex → reads/writes your codebase
```

## What This Repo Adds

- **Override-based packaging** — no vendored `node_modules`; patched upstream files live under `overrides/`
- **Feishu-focused fixes** — segmented preview delivery, image/file return, bridge restart UX, busy-session recovery
- **Codex workflow support** — bridge restart/status helpers, isolated `CODEX_HOME`, timeout buckets, import/export helpers
- **Regression tests** — bridge-specific behavior covered by local tests

## Features

- **Four IM platforms** — Telegram, Discord, Feishu/Lark, QQ — enable any combination
- **Interactive setup** — guided wizard collects tokens with step-by-step instructions
- **Permission control** — tool calls require explicit approval via inline buttons (Telegram/Discord) or text `/perm` commands (Feishu/QQ)
- **Streaming preview** — see Claude's response as it types (Telegram & Discord)
- **Session persistence** — conversations survive daemon restarts
- **Secret protection** — tokens stored with `chmod 600`, auto-redacted in all logs
- **Zero code required** — install the skill and run `/claude-to-im setup`, that's it

## Prerequisites

- **Node.js >= 20**
- **Claude Code CLI** (for `CTI_RUNTIME=claude` or `auto`) — installed and authenticated (`claude` command available)
- **Codex CLI** (for `CTI_RUNTIME=codex` or `auto`) — `npm install -g @openai/codex`. Auth: run `codex login`, or set `OPENAI_API_KEY` (optional, for API mode)

## Installation

### Git clone

```bash
git clone https://github.com/cyjjjj-21/feishu-codex-bridge-kit.git ~/.claude/skills/claude-to-im
```

Clones the repo directly into your personal skills directory. Claude Code discovers it automatically.

### Symlink

If you prefer to keep the repo elsewhere (e.g., for development):

```bash
git clone https://github.com/cyjjjj-21/feishu-codex-bridge-kit.git ~/code/feishu-codex-bridge-kit
mkdir -p ~/.claude/skills
ln -s ~/code/feishu-codex-bridge-kit ~/.claude/skills/claude-to-im
```

### Codex

If you use [Codex](https://github.com/openai/codex), clone directly into the Codex skills directory:

```bash
git clone https://github.com/cyjjjj-21/feishu-codex-bridge-kit.git ~/.codex/skills/claude-to-im
```

Or use the provided install script for automatic dependency installation and build:

```bash
# Clone and install (copy mode)
git clone https://github.com/cyjjjj-21/feishu-codex-bridge-kit.git ~/code/feishu-codex-bridge-kit
bash ~/code/feishu-codex-bridge-kit/scripts/install-codex.sh

# Or use symlink mode for development
bash ~/code/feishu-codex-bridge-kit/scripts/install-codex.sh --link
```

### Verify installation

**Claude Code:** Start a new session and type `/` — you should see `claude-to-im` in the skill list. Or ask Claude: "What skills are available?"

**Codex:** Start a new session and say "claude-to-im setup" or "start bridge" — Codex will recognize the skill and run the setup wizard.

## Quick Start

### 1. Setup

```
/claude-to-im setup
```

The wizard will guide you through:

1. **Choose channels** — pick Telegram, Discord, Feishu, QQ, or any combination
2. **Enter credentials** — the wizard explains exactly where to get each token, which settings to enable, and what permissions to grant
3. **Set defaults** — working directory, model, and mode
4. **Validate** — tokens are verified against platform APIs immediately

### 2. Start

```
/claude-to-im start
```

The daemon starts in the background. You can close the terminal — it keeps running.

### 3. Chat

Open your IM app and send a message to your bot. Claude Code will respond.

When Claude needs to use a tool (edit a file, run a command), you'll see a permission prompt with **Allow** / **Deny** buttons right in the chat (Telegram/Discord), or a text `/perm` command prompt (Feishu/QQ).

## Commands

All commands are run inside Claude Code or Codex:

| Claude Code | Codex (natural language) | Description |
|---|---|---|
| `/claude-to-im setup` | "claude-to-im setup" / "配置" | Interactive setup wizard |
| `/claude-to-im start` | "start bridge" / "启动桥接" | Start the bridge daemon |
| `/claude-to-im stop` | "stop bridge" / "停止桥接" | Stop the bridge daemon |
| `/claude-to-im status` | "bridge status" / "状态" | Show daemon status |
| `/claude-to-im logs` | "查看日志" | Show last 50 log lines |
| `/claude-to-im logs 200` | "logs 200" | Show last 200 log lines |
| `/claude-to-im reconfigure` | "reconfigure" / "修改配置" | Update config interactively |
| `/claude-to-im doctor` | "doctor" / "诊断" | Diagnose issues |

## Platform Setup Guides

The `setup` wizard provides inline guidance for every step. Here's a summary:

### Telegram

1. Message `@BotFather` on Telegram → `/newbot` → follow prompts
2. Copy the bot token (format: `123456789:AABbCc...`)
3. Recommended: `/setprivacy` → Disable (for group use)
4. Find your User ID: message `@userinfobot`

### Discord

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) → New Application
2. Bot tab → Reset Token → copy it
3. Enable **Message Content Intent** under Privileged Gateway Intents
4. OAuth2 → URL Generator → scope `bot` → permissions: Send Messages, Read Message History, View Channels → copy invite URL

### Feishu / Lark

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) (or [Lark](https://open.larksuite.com/app))
2. Create Custom App → get App ID and App Secret
3. **Batch-add permissions**: go to "Permissions & Scopes" → use batch configuration to add all required scopes (the `setup` wizard provides the exact JSON)
4. Enable Bot feature under "Add Features"
5. **Events & Callbacks**: select **"Long Connection"** as event dispatch method → add `im.message.receive_v1` event
6. **Publish**: go to "Version Management & Release" → create version → submit for review → approve in Admin Console
7. **Important**: The bot will NOT work until the version is approved and published

### QQ

> QQ currently supports **C2C private chat only**. No group/channel support, no inline permission buttons, no streaming preview. Permissions use text `/perm ...` commands. Image inbound only (no image replies).

1. Go to [QQ Bot OpenClaw](https://q.qq.com/qqbot/openclaw)
2. Create a QQ Bot or select an existing one → get **App ID** and **App Secret** (only two required fields)
3. Configure sandbox access and scan QR code with QQ to add the bot
4. `CTI_QQ_ALLOWED_USERS` takes `user_openid` values (not QQ numbers) — can be left empty initially
5. Set `CTI_QQ_IMAGE_ENABLED=false` if the underlying provider doesn't support image input

## Architecture

```
~/.claude-to-im/
├── config.env             ← Credentials & settings (chmod 600)
├── data/                  ← Persistent JSON storage
│   ├── sessions.json
│   ├── bindings.json
│   ├── permissions.json
│   └── messages/          ← Per-session message history
├── logs/
│   └── bridge.log         ← Auto-rotated, secrets redacted
└── runtime/
    ├── bridge.pid          ← Daemon PID file
    └── status.json         ← Current status
```

### Key components

| Component | Role |
|---|---|
| `src/main.ts` | Daemon entry — assembles DI, starts bridge |
| `src/config.ts` | Load/save `config.env`, map to bridge settings |
| `src/store.ts` | JSON file BridgeStore (30 methods, write-through cache) |
| `src/llm-provider.ts` | Claude Agent SDK `query()` → SSE stream |
| `src/codex-provider.ts` | Codex SDK `runStreamed()` → SSE stream |
| `src/sse-utils.ts` | Shared SSE formatting helper |
| `src/permission-gateway.ts` | Async bridge: SDK `canUseTool` ↔ IM buttons |
| `src/logger.ts` | Secret-redacted file logging with rotation |
| `scripts/daemon.sh` | Process management (start/stop/status/logs) |
| `scripts/doctor.sh` | Health checks |
| `SKILL.md` | Claude Code skill definition |

### Permission flow

```
1. Claude wants to use a tool (e.g., Edit file)
2. SDK calls canUseTool() → LLMProvider emits permission_request SSE
3. Bridge sends inline buttons to IM chat: [Allow] [Deny]
4. canUseTool() blocks, waiting for user response (5 min timeout)
5. User taps Allow → bridge resolves the pending permission
6. SDK continues tool execution → result streamed back to IM
```

## Troubleshooting

Run diagnostics:

```
/claude-to-im doctor
```

This checks: Node.js version, config file existence and permissions, token validity (live API calls), log directory, PID file consistency, and recent errors.

| Issue | Solution |
|---|---|
| `Bridge won't start` | Run `doctor`. Check if Node >= 20. Check logs. |
| `Messages not received` | Verify token with `doctor`. Check allowed users config. |
| `Permission timeout` | User didn't respond within 5 min. Tool call auto-denied. |
| `Stale PID file` | Run `stop` then `start`. daemon.sh auto-cleans stale PIDs. |

See [references/troubleshooting.md](references/troubleshooting.md) for more details.

## Security

- All credentials stored in `~/.claude-to-im/config.env` with `chmod 600`
- Tokens are automatically redacted in all log output (pattern-based masking)
- Allowed user/channel/guild lists restrict who can interact with the bot
- The daemon is a local process with no inbound network listeners
- The public extraction removes local secrets and environment-specific configuration, but review `config.env` and deployment scripts before using in your own environment

## Development

```bash
npm install        # Install dependencies
npm run apply-overrides  # Re-apply local bridge patches into node_modules/claude-to-im
npm run dev        # Run in dev mode
npm run typecheck  # Type check
npm test           # Run tests
npm run build      # Build bundle
```

## Override Layout

Patched upstream bridge files live in:

```text
overrides/claude-to-im/src/lib/bridge/
```

`npm install`, `npm test`, `npm run build`, and `npm run typecheck` all sync these files into the installed `claude-to-im` dependency before running.

## License

[MIT](LICENSE)
