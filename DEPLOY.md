---
name: deploy-wechat-plugin
description: Interactive deployment guide for the OpenClaw WeChat plugin. Clones the repository, installs Node dependencies, configures openclaw.json with channel settings, and guides through WeChat and macOS permissions setup.
---

# Deploy: OpenClaw WeChat Plugin

> **macOS only.** Requires WeChat desktop app installed and running.
>
> **Interactive protocol.** Each step checks current state before acting. Pauses for confirmation where needed.

---

## Before Starting

```bash
# Check prerequisites
which git && git --version
which node && node --version
which npm && npm --version
which brew && brew --version
openclaw --version

# Check WeChat is installed
ls /Applications/WeChat.app 2>/dev/null && echo "✅ WeChat found" || echo "❌ WeChat not installed"
```

---

## Phase 1 — Peekaboo (OCR dependency)

```bash
which peekaboo && peekaboo --version && echo "already installed"
```

If not installed:
```bash
brew install peekaboo
```

Verify:
```bash
which peekaboo && echo "✅ Peekaboo ready"
```

---

## Phase 2 — Clone and Install

Ask: "Where should the plugin be installed? (default: `~/.openclaw/workspace/plugins/openclaw-wechat-plugin`)"

Use `<PLUGIN_DIR>` as the placeholder.

```bash
# Check if already exists
ls <PLUGIN_DIR>/index.js 2>/dev/null && echo "already installed"
```

If not installed:
```bash
mkdir -p "$(dirname <PLUGIN_DIR>)"
git clone https://github.com/OttoPrua/openclaw-wechat-bot.git <PLUGIN_DIR>
```

Install Node dependencies:
```bash
cd <PLUGIN_DIR>
npm install
```

---

## Phase 3 — Configure openclaw.json

Ask the user for:

1. **Agent ID**: which agent should handle WeChat messages? (e.g. `main`, or a dedicated agent)
2. **Bot name**: the display name users will see (any name, this is just metadata)
3. **Bot trigger**: the string that triggers the agent to reply (e.g. `＆bot` — full-width &)
4. **Allowed groups**: comma-separated WeChat group names to accept messages from (leave empty to accept all)

Show the config block to add to `~/.openclaw/openclaw.json`:

```json5
{
  "plugins": {
    "allow": ["wechat"],
    "load": {
      "paths": ["<PLUGIN_DIR>"]
    },
    "entries": {
      "wechat": { "enabled": true }
    }
  },
  "channels": {
    "wechat": {
      "enabled": true,
      "groupOnly": true,
      "botName": "<bot-name>",
      "botTrigger": "＆bot",
      "agent": "<agent-id>",
      "allowedGroups": ["<group-name>"],
      "rateLimitPerMinute": 20,
      "dailyTokenBudget": 50000,
      "systemMessagePrefix": "OC_SYS_"
    }
  }
}
```

> "Fill in your values and add this to `openclaw.json`. Tell me when done."

Wait for confirmation.

---

## Phase 4 — macOS Permissions

Guide the user through two required permissions:

**1. Accessibility permission**

```bash
# Test accessibility
osascript -e 'tell application "System Events" to return name of processes' > /dev/null 2>&1 \
  && echo "✅ Accessibility granted" \
  || echo "❌ Needs permission"
```

If not granted:
> "Please grant accessibility permission to Terminal (or whichever app runs OpenClaw):
> System Settings → Privacy & Security → Accessibility → enable your terminal app"

Wait for the user to grant permission and confirm.

**2. WeChat notification settings**

> "In WeChat:
> 1. Preferences → Notifications → enable notifications
>
> In macOS System Settings:
> 2. Notifications → WeChat → Allow Notifications ✅
> 3. Set notification style to **Persistent** (not Temporary)
>
> WeChat must stay in the **background** (not foreground) to receive notifications.
>
> Tell me when done."

Wait for confirmation.

---

## Phase 5 — Restart and Test

```bash
openclaw gateway restart
openclaw gateway status
```

> "To test the plugin:
> 1. Open one of your configured allowed WeChat groups
> 2. Send: `＆bot hello` (using the trigger you configured)
> 3. The bot should reply within ~10 seconds
>
> Did it work?"

If it didn't work, run diagnostics:
```bash
# Check plugin is loaded
openclaw gateway status | grep wechat

# Check WeChat process is running
pgrep -x WeChat && echo "WeChat running" || echo "WeChat not running"

# Check notification permission (should return 0)
defaults read com.tencent.xinWeChat NSUserNotificationsAllowedByUser 2>/dev/null
```

---

## Multi-Agent Setup (optional)

If you want multiple agents bound to different groups:

Ask: "Do you want to configure multiple agents? (y/n)"

If yes, show the multi-agent config structure:

```json5
{
  "channels": {
    "wechat": {
      "enabled": true,
      "groupOnly": true,
      "agents": [
        {
          "id": "agent-a",
          "bindTrigger": "&BotA",
          "unbindTrigger": "！BotA",
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

Explain binding:
> "Once configured, send `&BotA` in a WeChat group to bind agent-a to that group.
> Send `！BotA` to unbind. Bindings are in-memory — re-bind after gateway restarts."

---

## Final Check

```bash
openclaw gateway status
ls <PLUGIN_DIR>/index.js && echo "✅ plugin files present"
```

| Item | Status |
|------|--------|
| Plugin installed | ✅/❌ |
| openclaw.json configured | ✅/❌ |
| Accessibility permission | ✅/❌ |
| WeChat notifications (Persistent) | ✅/❌ |
| Gateway running | ✅/❌ |

→ Full docs: https://github.com/OttoPrua/openclaw-wechat-bot
