# WeChat Channel

OpenClaw 的微信渠道插件，当前为 **macOS 通知接收 + UI 自动化发送** 的最小可运行版本。

## 当前能力

- **接收消息**：通过 AppleScript 监控 macOS Notification Center
- **长文本补全**：通知被截断时，尝试用本地 OCR 补全文本
- **发送消息**：通过 AppleScript / Peekaboo / 剪贴板把文字和媒体发到微信
- **群聊支持**：可解析 `发送者: 内容` 形式的群通知

## 使用前要求

1. 微信发送快捷键改成 `Shift+Enter`
2. 给终端或 IDE 开启辅助功能权限
3. 微信保持登录，且发完消息后允许回到后台
4. 安装 `peekaboo`：`brew install peekaboo`

## 配置

```json
{
  "channels": {
    "wechat": {
      "enabled": true,
      "allowedSenders": ["发送者微信昵称"]
    }
  }
}
```

## 接收逻辑

- 短文本通知：直接处理
- 被截断的长文本：尝试 OCR 补全后处理
- 媒体通知：无法从通知恢复正文时跳过

## 说明

- 已删除 webhook / chatlog 接收链路，插件不再监听 `/api/webhook`
- 当前版本目标是保持最小运行面，先保证通知收消息和 UI 发消息这条主链路
- 精简完成后请由管理员自行调试验证
