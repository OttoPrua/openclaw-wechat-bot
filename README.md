# openclaw-wechat-bot

<p align="center">
  <strong>WeChat channel plugin for OpenClaw — macOS-native, multi-agent, prompt-injection hardened</strong>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-production-brightgreen?style=for-the-badge" alt="Status">
  <img src="https://img.shields.io/badge/macOS-Tahoe%2B-blue?style=for-the-badge" alt="macOS">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="License">
</p>

> 🤖 **Deploy with OpenClaw:** Tell your agent — *"Run the DEPLOY.md guide"* — and it will walk through installation interactively. → [DEPLOY.md](DEPLOY.md)

An [OpenClaw](https://github.com/openclaw/openclaw) plugin that brings WeChat group chats into your agent stack. Receives messages via macOS Notification Center, sends via AppleScript UI automation. Supports multiple agents, name-based triggering, and prompt injection defense — no WeChat API or root access required.

> **Status: ✅ Production** (macOS Tahoe + WeChat macOS)

## Features

- **Receive messages** — AppleScript polls macOS Notification Center (0.5s interval)
- **Long message recovery** — When notifications are truncated, Peekaboo screenshot + OCR restores full text
- **Send messages** — AppleScript + clipboard + UI automation, with search-based group switching
- **Group chat native** — Designed for WeChat group chats; parses `sender: content` notification format, auto-identifies group name and sender; supports tracking multiple groups simultaneously (each group gets its own session)
- **Multi-agent binding** — Bind different agents to different group chats
- **Name-based triggering** — Three trigger modes: @botName / mention agent name / custom trigger string
- **Silent context** — After binding, agent receives all group messages as context; only replies when triggered
- **Prompt injection defense** — 9 regex patterns pre-filter injections before reaching the model; no token cost on match
- **Rate & budget control** — `rateLimitPerMinute` + `dailyTokenBudget`

## Requirements

- macOS (tested on Tahoe)
- WeChat macOS client, logged in and running in background
- [Peekaboo](https://github.com/tornikegomareli/Peekaboo): `brew install peekaboo`
- **Accessibility permission** for Terminal / your runner (System Settings → Privacy & Security → Accessibility)
- WeChat **notifications enabled**, style set to **Persistent** (not Transient — transient alerts disappear before the 0.5s poll)
- WeChat send shortcut set to `Enter` (default, or match your actual setting)

## Installation

```bash
# Clone into your OpenClaw plugins directory
cd ~/.openclaw/workspace/plugins
git clone https://github.com/OttoPrua/openclaw-wechat-bot.git openclaw-wechat-plugin

# Install dependencies
cd openclaw-wechat-plugin
npm install

# Restart OpenClaw gateway
openclaw gateway restart
```

## Configuration

### Single-agent setup

```json5
// openclaw.json
{
  "channels": {
    "wechat": {
      "enabled": true,
      "blockStreaming": true,
      "groupOnly": true,
      "botName": "Your Bot Name",
      "botTrigger": "＆bot",           // full-width &, triggers agent reply
      "agent": "your-agent-id",
      "allowedGroups": ["Group Name"], // allowlist; empty = no filter
      "allowedSenders": [],            // sender allowlist; empty = no filter
      "rateLimitPerMinute": 20,
      "dailyTokenBudget": 50000,
      "systemMessagePrefix": "OC_SYS_" // sync this value to agent SOUL.md
    }
  }
}
```

### Multi-agent setup

```json5
{
  "channels": {
    "wechat": {
      "enabled": true,
      "groupOnly": true,
      "agents": [
        {
          "id": "agent-a",
          "bindTrigger": "&BotA",    // half-width &, bind to current group
          "unbindTrigger": "！BotA", // full-width !, unbind + clear session
          "mentionNames": ["BotA", "agent-a"]
        },
        {
          "id": "agent-b",
          "bindTrigger": "&BotB",
          "unbindTrigger": "！BotB",
          "mentionNames": ["BotB", "agent-b"]
        }
      ]
    }
  }
}
```

**Binding:**
- Send `&BotA` in a group → that agent starts tracking the group (group name auto-identified from notification; WeChat doesn't need to be on that window)
- Send `！BotA` → stop tracking + clear session
- After binding, all messages are silent context; agent only replies when triggered (@/name/trigger string)

## Message Flow

```
Group member sends "@Bot hello"
  → macOS notification (WeChat must be in background)
  → AppleScript poll (0.5s) → parse group name / sender / content
  → allowedGroups check → trigger match → rate/budget check
  → dispatch to agent (session=agent:<agentId>:wechat:group:<groupName>)
  → model generates reply (~4s)
  → System Events activates WeChat → Cmd+F search group → paste + send → return to background
End-to-end latency: ~8 seconds
```

**Long message flow (when notification is truncated):**
```
Notification truncated at ~65 chars
  → Peekaboo screenshots WeChat window
  → bin/wechat-ocr extracts text
  → matches full message using notification prefix
  → delivers to agent
  → falls back to truncated content if OCR fails
```

## Prompt Injection Defense

Pre-filters message content before agent dispatch. Matches are intercepted and replied to directly — no model tokens consumed:

- Role markers: `system:` / `assistant:` / `user:`
- Override instructions: `ignore previous instructions` / `you are now` / etc.
- Model markers: `[INST]` / `<|im_start|>` / etc.
- Base64 content / invisible Unicode
- Requests to output system prompts

## Known Limitations

| Limitation | Detail |
|-----------|--------|
| Notification truncation | macOS caps notifications at ~65 chars; OCR fallback available |
| Multimedia messages | Images/voice/video can't be recovered from notifications; currently skipped |
| Binding not persisted | Binding state is in-memory; re-bind after gateway restart |
| Foreground takeover | Sending briefly activates the WeChat window |
| Clipboard | Best-effort text restore; non-text clipboard content may be overwritten |
| WeChat must be backgrounded | Notifications don't fire when WeChat is in foreground |

## File Structure

```
openclaw-wechat-plugin/
├── index.js          # Plugin entry, registers wechat channel
├── bin/
│   └── wechat-ocr    # OCR helper script
├── scripts/          # AppleScript send/switch scripts
├── README.md         # English
└── README.zh-CN.md   # 中文
```

## Related

- [OpenClaw](https://github.com/openclaw/openclaw) — the core gateway
- [OpenClaw Docs](https://docs.openclaw.ai) — full documentation
- [ClawHub](https://clawhub.ai) — community skills
- [Discord](https://discord.gg/clawd) — community

## License

MIT
