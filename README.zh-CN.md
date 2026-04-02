# openclaw-wechat-bot

<p align="center">
  <strong>OpenClaw 微信渠道插件 — macOS 原生方案，多 agent 支持，注入防护</strong>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/状态-生产就绪-brightgreen?style=for-the-badge" alt="Status">
  <img src="https://img.shields.io/badge/macOS-Tahoe%2B-blue?style=for-the-badge" alt="macOS">
  <img src="https://img.shields.io/badge/许可证-MIT-blue?style=for-the-badge" alt="License">
</p>

> 🤖 **让 OpenClaw 自动部署：** 告诉你的 agent — *「按照 DEPLOY.md 帮我部署」* — 它会交互式逐步完成安装。→ [DEPLOY.md](DEPLOY.md)

[OpenClaw](https://github.com/openclaw/openclaw) 的微信渠道插件，将微信群聊接入你的 agent 体系。通过 macOS 通知中心接收消息，AppleScript UI 自动化发送消息。支持多 agent 绑定、名字触发和 Prompt Injection 防护，无需微信 API 或 root 权限。

> **状态：✅ 生产就绪**（macOS Tahoe + 微信 macOS 版）

## 功能

- **接收消息** — AppleScript 轮询 macOS 通知中心（0.5s 间隔）
- **长文本补全** — 通知被截断时，通过 Peekaboo 截屏 + OCR 恢复完整文本
- **发送消息** — AppleScript + 剪贴板 + UI 自动化，支持搜索切换目标群
- **群聊原生支持** — 专为微信群聊设计，解析通知 body 中的 `发送者: 内容` 格式，自动识别群名和发送者，支持同时跟进多个群（每群独立 session）
- **多 agent 绑定** — 在不同群聊中绑定不同 agent
- **名字触发** — 三种触发方式：@botName / 提及 agent 名字 / 自定义触发符
- **静默上下文** — 绑定后 agent 接收群内所有消息作为上下文，仅被触发时才回复
- **Prompt Injection 防护** — 9 种正则模式前置拦截，命中直接回复不消耗模型
- **频率与额度控制** — `rateLimitPerMinute` + `dailyTokenBudget`

## 运行要求

- macOS（已在 Tahoe 验证）
- 微信 macOS 客户端，保持登录并在后台运行
- [Peekaboo](https://github.com/tornikegomareli/Peekaboo)：`brew install peekaboo`
- 给终端/运行环境开启**辅助功能权限**（系统设置 → 隐私与安全性 → 辅助功能）
- 微信已开启**通知权限**，通知样式设为**持续**（不是临时 — 临时通知在 0.5s 轮询前消失会漏消息）
- 微信发送快捷键设为 `Enter`（默认值，或按实际配置）

## 安装

```bash
# 克隆到 OpenClaw 插件目录
cd ~/.openclaw/workspace/plugins
git clone https://github.com/OttoPrua/openclaw-wechat-bot.git openclaw-wechat-plugin

# 安装依赖
cd openclaw-wechat-plugin
npm install

# 重启 OpenClaw Gateway
openclaw gateway restart
```

## 配置

### 单 agent 配置

```json5
// openclaw.json
{
  "channels": {
    "wechat": {
      "enabled": true,
      "blockStreaming": true,
      "groupOnly": true,
      "botName": "你的机器人名字",
      "botTrigger": "＆机器人",        // 全角 &，触发 agent 回复
      "agent": "your-agent-id",
      "allowedGroups": ["群名称"],      // 白名单，留空则不过滤
      "allowedSenders": [],             // 发送者白名单，留空则不过滤
      "rateLimitPerMinute": 20,
      "dailyTokenBudget": 50000,
      "systemMessagePrefix": "OC_SYS_" // 需在 agent SOUL.md 中同步配置
    }
  }
}
```

### 多 agent 配置

```json5
{
  "channels": {
    "wechat": {
      "enabled": true,
      "groupOnly": true,
      "agents": [
        {
          "id": "agent-a",
          "bindTrigger": "&机器人A",    // 半角 &，绑定当前群
          "unbindTrigger": "！机器人A", // 全角 !，解绑 + 清 session
          "mentionNames": ["机器人A", "agent-a"]
        },
        {
          "id": "agent-b",
          "bindTrigger": "&机器人B",
          "unbindTrigger": "！机器人B",
          "mentionNames": ["机器人B", "agent-b"]
        }
      ]
    }
  }
}
```

**绑定说明：**
- 在目标群中发 `&机器人A` → 该 agent 开始跟进此群（通知来源自动识别群名，无需微信停留在目标窗口）
- 发 `！机器人A` → 停止跟进 + 清除 session
- 绑定后群内所有消息作为静默上下文，只有被触发（@/名字/触发符）时才正式回复

## 消息链路

```
群成员发 "@机器人 你好"
  → macOS 通知（需微信在后台）
  → AppleScript 轮询（0.5s）→ 解析群名/发送者/内容
  → allowedGroups 白名单 → 触发符/名字匹配 → 频率/额度检查
  → dispatch 到 agent（session=agent:<agentId>:wechat:group:<群名>）
  → 模型生成回复（~4s）
  → System Events 激活微信 → Cmd+F 搜索群 → 粘贴 + 发送 → 切后台
端到端延迟：约 8 秒
```

**长文本链路（通知被截断时）：**
```
通知内容 ≈ 65 字符截断
  → Peekaboo 截屏微信窗口
  → bin/wechat-ocr 识别文字
  → 用通知前缀匹配完整消息
  → 直接投递 agent
  → OCR 失败时回退截断通知内容
```

## Prompt Injection 防护

在投递 agent 前对消息内容做前置检测，命中以下任一模式直接拦截并回复，不消耗模型：

- 角色标记：`system:` / `assistant:` / `user:`
- 覆盖指令：`ignore previous instructions` / `you are now` 等
- 模型标记：`[INST]` / `<|im_start|>` 等
- Base64 内容 / 不可见 Unicode
- 要求输出系统提示词等

## 已知限制

| 限制 | 说明 |
|------|------|
| 通知截断 | macOS 通知最多约 65 字符；可通过 OCR 补全 |
| 多媒体消息 | 图片/语音/视频无法从通知恢复正文，当前跳过 |
| 绑定不持久 | 绑定状态存在内存中，gateway 重启后需重新绑定 |
| 前台占用 | 发送时短暂激活微信窗口 |
| 剪贴板 | Best-effort 文本恢复，非文本剪贴板可能被覆盖 |
| 微信需在后台 | 微信前台运行时不弹通知，会漏消息 |

## 文件结构

```
openclaw-wechat-plugin/
├── index.js          # 插件入口，注册 wechat channel
├── bin/
│   └── wechat-ocr    # OCR 辅助脚本
├── scripts/          # AppleScript 发送/切换脚本
├── README.md         # English
└── README.zh-CN.md   # 中文
```

## 相关链接

- [OpenClaw](https://github.com/openclaw/openclaw) — 核心 Gateway
- [OpenClaw 文档](https://docs.openclaw.ai) — 完整文档
- [ClawHub](https://clawhub.ai) — 社区 Skills
- [Discord](https://discord.gg/clawd) — 社区

## 许可证

MIT
