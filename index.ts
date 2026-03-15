import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { existsSync, statSync, readdirSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { exec as execCallback, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type {
  OpenClawPluginApi,
  PluginRuntime,
  ClawdbotConfig,
  RuntimeEnv,
  ReplyPayload,
} from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  emptyPluginConfigSchema,
  createReplyPrefixContext,
  createTypingCallbacks,
} from "openclaw/plugin-sdk";

const exec = promisify(execCallback);

// 带 UTF-8 环境变量的 exec，解决后台进程 emoji 问题
async function execWithUtf8(command: string, options: Record<string, any> = {}): Promise<{ stdout: string; stderr: string }> {
  return exec(command, {
    ...options,
    env: {
      ...process.env,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    },
  });
}

// ============================================================
// 本地文件路径检测配置
// ============================================================

// 支持的媒体文件扩展名
const SUPPORTED_MEDIA_EXTENSIONS = new Set([
  // 图片
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff",
  // 视频
  ".mp4", ".mov", ".avi", ".mkv", ".webm",
  // 音频
  ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg",
  // 文档
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".md",
]);

// 最大文件大小：200MB
const MAX_MEDIA_SIZE_BYTES = 200 * 1024 * 1024;

// 微信每条消息最多 9 个媒体文件
const WECHAT_MAX_MEDIA_PER_MESSAGE = 9;

// 将 AI 输出的相对路径转为绝对路径
const OPENCLAW_PATH_ALIASES: [string, string][] = [
  ["openclaw/workspace", "/Users/ottoprua/.openclaw/workspace"],
];

function normalizeFilePath(filePath: string): string {
  for (const [alias, absolute] of OPENCLAW_PATH_ALIASES) {
    if (filePath.includes(alias)) {
      return filePath.replace(alias, absolute);
    }
  }
  return filePath;
}

// 移除字符串中的下划线，用于模糊比较
function removeUnderscores(str: string): string {
  return str.replace(/_/g, "").toLowerCase();
}

// 模糊匹配文件名（忽略下划线差异）
function findFuzzyMatchFile(filePath: string): string | null {
  try {
    const dir = dirname(filePath);
    const targetName = basename(filePath);
    const targetNormalized = removeUnderscores(targetName);

    if (!existsSync(dir)) return null;

    const files = readdirSync(dir);
    for (const file of files) {
      if (removeUnderscores(file) === targetNormalized) {
        return join(dir, file);
      }
    }
  } catch {
    // 忽略错误
  }
  return null;
}

// 检测文本中的本地文件路径
function detectLocalFilePaths(text: string): string[] {
  // 匹配绝对路径和相对路径（包含 / 且以支持的扩展名结尾）
  const extPattern = Array.from(SUPPORTED_MEDIA_EXTENSIONS)
    .map((ext) => ext.replace(".", "\\."))
    .join("|");
  const pathRegex = new RegExp(`((?:/|\\w+/)[^\\s"'<>|*?]+(?:${extPattern}))`, "gi");

  const matches = text.match(pathRegex) || [];
  const validPaths: string[] = [];

  for (const rawPath of matches) {
    try {
      // 尝试将相对路径转为绝对路径
      const resolvedPath = normalizeFilePath(rawPath);
      
      let finalPath: string | null = null;
      
      if (existsSync(resolvedPath)) {
        finalPath = resolvedPath;
      } else {
        // 文件不存在，尝试模糊匹配（忽略下划线差异）
        finalPath = findFuzzyMatchFile(resolvedPath);
      }
      
      if (finalPath) {
        const stats = statSync(finalPath);
        if (stats.isFile() && stats.size <= MAX_MEDIA_SIZE_BYTES) {
          validPaths.push(finalPath);
        }
      }
    } catch {
      // 忽略无法访问的路径
    }
  }

  return validPaths;
}

// ============================================================
// Runtime 管理
// ============================================================

let runtime: PluginRuntime | null = null;
let pluginApi: OpenClawPluginApi | null = null;

// 动态激活的群聊名称（通过 ！洛茜 指令绑定）
let activeGroup: string = "";

// 系统消息前缀：用于区分「静默处理的系统/上下文消息」和「需要正常回复的用户消息」
// 可在 channels.wechat.systemMessagePrefix 中覆盖，默认使用固定 UUID 前缀方便跨 agent 共享
const DEFAULT_SYSTEM_MESSAGE_PREFIX = "OC_SYS_6c7c0f8d-4d27-4d3d-9d93-c7c9d4b8d11a";

// 消息去重：存储已处理的消息 key（发送者 + 内容前20字符）
const processedMessages = new Set<string>();
const MAX_PROCESSED_MESSAGES = 1000;

// ============================================================
// 频率限制 & Token 预算
// ============================================================

// 每分钟消息计数（滑动窗口）
const messageTimestamps: number[] = [];

// 每日 Token 估算追踪
let dailyTokenEstimate = 0;
let dailyTokenResetDate = new Date().toDateString();

function resetDailyTokenIfNeeded(): void {
  const today = new Date().toDateString();
  if (today !== dailyTokenResetDate) {
    dailyTokenEstimate = 0;
    dailyTokenResetDate = today;
  }
}

// 估算 token 数（中文约 1.5 token/字，英文约 0.75 token/word）
function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars * 1.5 + otherChars * 0.3);
}

function addTokenUsage(inputText: string, outputText: string): void {
  resetDailyTokenIfNeeded();
  dailyTokenEstimate += estimateTokens(inputText) + estimateTokens(outputText);
}

type RateLimitResult =
  | { allowed: true }
  | { allowed: false; reason: "per_minute"; retryAfterSec: number }
  | { allowed: false; reason: "daily_budget"; usedTokens: number; budgetTokens: number };

function checkRateLimit(cfg: any): RateLimitResult {
  const wechatCfg = (cfg?.channels?.wechat) ?? {};
  const perMinute: number = wechatCfg.rateLimitPerMinute ?? 5;
  const dailyBudget: number = wechatCfg.dailyTokenBudget ?? 500000;

  // 每分钟检查
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;
  // 清理旧记录
  while (messageTimestamps.length > 0 && messageTimestamps[0] < oneMinuteAgo) {
    messageTimestamps.shift();
  }
  if (messageTimestamps.length >= perMinute) {
    const oldestInWindow = messageTimestamps[0];
    const retryAfterSec = Math.ceil((oldestInWindow + 60_000 - now) / 1000);
    return { allowed: false, reason: "per_minute", retryAfterSec };
  }

  // 每日 token 检查
  resetDailyTokenIfNeeded();
  if (dailyTokenEstimate >= dailyBudget) {
    return { allowed: false, reason: "daily_budget", usedTokens: dailyTokenEstimate, budgetTokens: dailyBudget };
  }

  return { allowed: true };
}

function recordMessageSent(): void {
  messageTimestamps.push(Date.now());
}

// 生成消息去重 key
function getMessageKey(sender: string, content: string): string {
  const contentPrefix = content.slice(0, 20);
  return `${sender}:::${contentPrefix}`;
}

function isMessageProcessed(sender: string, content: string): boolean {
  const key = getMessageKey(sender, content);
  return processedMessages.has(key);
}

function markMessageProcessed(sender: string, content: string): void {
  const key = getMessageKey(sender, content);
  
  // 清理旧记录，避免内存无限增长
  if (processedMessages.size >= MAX_PROCESSED_MESSAGES) {
    const toDelete = Array.from(processedMessages).slice(0, 200);
    toDelete.forEach((k) => processedMessages.delete(k));
  }
  
  processedMessages.add(key);
}

// 判断是否是多媒体消息
function isMediaMessage(content: string): boolean {
  return /^\[(图片|视频|文件|语音)\]/.test(content);
}

// 判断消息是否需要 OCR 补全（长文本或多媒体）
const NOTIFICATION_MAX_LENGTH = 60; // 通知最大显示约 65 字符，留点余量
const OCR_SCREENSHOT_TIMEOUT_MS = 2000;
const OCR_RECOGNITION_TIMEOUT_MS = 3000;
const OCR_TOTAL_TIMEOUT_MS = 5000;
const OCR_PREFIX_LENGTH = 55;
const OCR_SCREENSHOT_BIN = "/opt/homebrew/bin/peekaboo";
const OCR_WECHAT_APP_NAME = "微信";
const OCR_BINARY_PATH = `${process.env.HOME ?? ""}/.openclaw/workspace/bin/wechat-ocr`;
const OCR_MESSAGE_SEPARATOR_RE = /^(?:\d{1,2}:\d{2}|昨天|星期[一二三四五六日天]|周[一二三四五六日天]|上午|下午|晚上|凌晨|中午|[a-zA-Z0-9_-]{6,}|.+(?:群聊|服务通知|文件传输助手))$/;

function shouldWaitForWebhook(content: string): boolean {
  if (isMediaMessage(content)) {
    return true;
  }
  if (content.length >= NOTIFICATION_MAX_LENGTH) {
    return true;
  }
  return false;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\''`)}'`;
}

function normalizeOcrLine(line: string): string {
  return line
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[，]/g, ",")
    .replace(/[。]/g, ".")
    .replace(/[：]/g, ":")
    .replace(/[；]/g, ";")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[【]/g, "[")
    .replace(/[】]/g, "]")
    .replace(/[！]/g, "!")
    .replace(/[？]/g, "?")
    .replace(/[、]/g, ",")
    .replace(/[—–]/g, "-")
    .replace(/[……]/g, "...")
    .trim();
}

function buildOcrPrefixes(rawContent: string): string[] {
  const prefixes = new Set<string>();
  const candidates = [
    rawContent,
    rawContent.replace(/…+$/g, ""),
    rawContent.replace(/\.\.\.+$/g, ""),
  ];
  const groupMatch = rawContent.match(/^(.+?)[:：]\s*(.+)$/s);
  if (groupMatch) {
    candidates.push(groupMatch[2]);
    candidates.push(groupMatch[2].replace(/…+$/g, ""));
    candidates.push(groupMatch[2].replace(/\.\.\.+$/g, ""));
  }
  for (const candidate of candidates) {
    const normalized = normalizeOcrLine(candidate);
    if (!normalized) continue;
    prefixes.add(normalized.slice(0, OCR_PREFIX_LENGTH));
    prefixes.add(normalized.slice(0, Math.max(24, Math.min(40, normalized.length))));
  }
  return Array.from(prefixes).filter((item) => item.length >= 12).sort((a, b) => b.length - a.length);
}

function extractFullContentFromOcr(ocrText: string, notificationContent: string, sender: string, log: (...args: any[]) => void): string | null {
  const lines = ocrText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const prefixes = buildOcrPrefixes(notificationContent);
  if (prefixes.length === 0) return null;

  const normalizedLines = lines.map((line) => normalizeOcrLine(line));
  let best: { start: number; end: number; content: string; prefix: string } | null = null;

  for (let start = 0; start < lines.length; start += 1) {
    let combined = "";
    for (let end = start; end < Math.min(lines.length, start + 8); end += 1) {
      const currentLine = lines[end].trim();
      if (end > start && OCR_MESSAGE_SEPARATOR_RE.test(currentLine) && combined.length > 0) {
        break;
      }
      combined += normalizedLines[end];
      for (const prefix of prefixes) {
        if (combined.includes(prefix)) {
          best = {
            start,
            end,
            content: lines.slice(start, end + 1).join("\n"),
            prefix,
          };
          break;
        }
      }
      if (best) break;
    }
    if (best) break;
  }

  if (!best) {
    const joined = normalizedLines.join("\n");
    for (const prefix of prefixes) {
      const index = joined.indexOf(prefix);
      if (index >= 0) {
        log(`[wechat-ocr] Prefix matched in joined OCR text for ${sender}, but could not isolate message bubble`);
        return lines.join("\n");
      }
    }
    return null;
  }

  const content = best.content.trim();
  log(`[wechat-ocr] Matched OCR message for ${sender} at lines ${best.start + 1}-${best.end + 1} with prefix length ${best.prefix.length}`);
  return content;
}

async function enrichNotificationWithOcr(sender: string, content: string, log: (...args: any[]) => void): Promise<string> {
  if (!shouldWaitForWebhook(content) || isMediaMessage(content)) {
    return content;
  }

  const screenshotPath = `/tmp/wechat-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  const screenshotBin = existsSync(OCR_SCREENSHOT_BIN) ? OCR_SCREENSHOT_BIN : "peekaboo";
  const startedAt = Date.now();

  try {
    const screenshotCmd = `${screenshotBin} image --app ${shellEscape(OCR_WECHAT_APP_NAME)} --path ${shellEscape(screenshotPath)}`;
    await execWithUtf8(screenshotCmd, { timeout: OCR_SCREENSHOT_TIMEOUT_MS });

    if (!existsSync(OCR_BINARY_PATH)) {
      log(`[wechat-ocr] OCR binary not found: ${OCR_BINARY_PATH}`);
      return content;
    }

    const { stdout } = await execWithUtf8(`${shellEscape(OCR_BINARY_PATH)} ${shellEscape(screenshotPath)}`, {
      timeout: OCR_RECOGNITION_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });

    const extracted = extractFullContentFromOcr(stdout, content, sender, log);
    if (!extracted) {
      log(`[wechat-ocr] No OCR match for ${sender}, using notification content`);
      return content;
    }

    const normalizedOriginal = normalizeOcrLine(content.replace(/…+$/g, "").replace(/\.\.\.+$/g, ""));
    const normalizedExtracted = normalizeOcrLine(extracted);
    if (normalizedExtracted.length <= normalizedOriginal.length) {
      log(`[wechat-ocr] OCR result not longer than notification for ${sender}, keeping original content`);
      return content;
    }

    log(`[wechat-ocr] Replaced truncated notification for ${sender} in ${Date.now() - startedAt}ms`);
    return extracted;
  } catch (err) {
    log(`[wechat-ocr] OCR fallback failed for ${sender}: ${String(err)}`);
    return content;
  } finally {
    try {
      await execWithUtf8(`rm -f ${shellEscape(screenshotPath)}`);
    } catch {
      // ignore cleanup failure
    }
  }
}

// 通知监控进程
let notificationMonitorProcess: ChildProcess | null = null;
let lastNotificationSender = "";
let lastNotificationContent = "";

// 启动通知监控（使用 AppleScript 读取 NotificationCenter UI）
async function startNotificationMonitor(
  onNotification: (sender: string, content: string) => void,
  log: (...args: any[]) => void
): Promise<void> {
  log(`[wechat-notify] Starting notification monitor...`);

  // AppleScript 脚本：持续监控 NotificationCenter 窗口
  // macOS Tahoe 通知 UI 结构:
  // window "Notification Center" > group 1 > group 1 > scroll area 1 > group 1 > group N > {static text 1 (sender), static text 2 (body)}
  const appleScript = `
    on run
      set lastMessages to {}
      repeat
        try
          tell application "System Events"
            tell process "NotificationCenter"
              if exists window "Notification Center" then
                tell window "Notification Center"
                  tell group 1
                    tell group 1
                      if exists scroll area 1 then
                        tell scroll area 1
                          tell group 1
                            set notifGroups to every group
                            repeat with notifGroup in notifGroups
                              try
                                set allTexts to value of every static text of notifGroup
                                if (count of allTexts) >= 2 then
                                  set senderText to item 1 of allTexts as text
                                  set bodyText to item 2 of allTexts as text
                                  if senderText is not "" and bodyText is not "" then
                                    set msgKey to senderText & "|||" & bodyText
                                    if msgKey is not in lastMessages then
                                      set end of lastMessages to msgKey
                                      -- Keep lastMessages from growing too large
                                      if (count of lastMessages) > 50 then
                                        set lastMessages to items 26 thru -1 of lastMessages
                                      end if
                                      log "NOTIFICATION:" & senderText & "|||" & bodyText
                                    end if
                                  end if
                                end if
                              end try
                            end repeat
                          end tell
                        end tell
                      end if
                    end tell
                  end tell
                end tell
              end if
            end tell
          end tell
        end try
        delay 0.5
      end repeat
    end run
  `;

  notificationMonitorProcess = spawn("osascript", ["-e", appleScript], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  notificationMonitorProcess.stderr?.on("data", (data: Buffer) => {
    const output = data.toString().trim();
    // AppleScript 的 log 输出会到 stderr
    if (output.startsWith("NOTIFICATION:")) {
      const content = output.replace("NOTIFICATION:", "");
      const parts = content.split("|||");
      if (parts.length === 2) {
        const [sender, body] = parts;
        log(`[wechat-notify] Received notification - sender: ${sender}, body: ${body.slice(0, 30)}...`);
        onNotification(sender, body);
      }
    }
  });

  notificationMonitorProcess.on("close", (code) => {
    log(`[wechat-notify] Monitor process exited with code ${code}`);
    notificationMonitorProcess = null;
  });

  notificationMonitorProcess.on("error", (err) => {
    log(`[wechat-notify] Monitor process error: ${err.message}`);
  });
}

function stopNotificationMonitor(): void {
  if (notificationMonitorProcess) {
    notificationMonitorProcess.kill();
    notificationMonitorProcess = null;
  }
}

function getSystemMessagePrefix(cfg: any): string {
  const raw = cfg?.channels?.wechat?.systemMessagePrefix;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return DEFAULT_SYSTEM_MESSAGE_PREFIX;
}

function buildSilentContextMessage(cfg: any, senderName: string, content: string): string {
  const prefix = getSystemMessagePrefix(cfg);
  return `${prefix} [微信群静默上下文] 以下消息仅供上下文理解，除非后续有明确触发，否则不要直接回复。发送者：${senderName}；内容：${content}`;
}

function setWechatRuntime(next: PluginRuntime) {
  runtime = next;
}

function getWechatRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("WeChat runtime not initialized");
  }
  return runtime;
}

// ============================================================
// 微信消息发送 (AppleScript + Peekaboo)
// ============================================================

function escapeForShell(text: string): string {
  return text.replace(/'/g, "'\\''");
}

// 清理 Markdown 格式（微信不支持 Markdown 显示）
function stripMarkdown(text: string): string {
  let result = text;
  
  // 移除代码块（保留内容）
  result = result.replace(/```[\w]*\n?([\s\S]*?)```/g, "$1");
  
  // 移除行内代码（保留内容）
  result = result.replace(/`([^`]+)`/g, "$1");
  
  // 移除粗体 **text** 或 __text__
  result = result.replace(/\*\*([^*]+)\*\*/g, "$1");
  result = result.replace(/__([^_]+)__/g, "$1");
  
  // 移除斜体 *text* 或 _text_（注意不要误伤正常下划线）
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1");
  result = result.replace(/(?<!_)_([^_]+)_(?!_)/g, "$1");
  
  // 移除链接 [text](url) → text
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  
  // 移除标题 # ## ### 等
  result = result.replace(/^#{1,6}\s+/gm, "");
  
  // 移除引用 > 
  result = result.replace(/^>\s?/gm, "");
  
  // 移除水平线
  result = result.replace(/^[-*_]{3,}\s*$/gm, "");
  
  return result.trim();
}

// ============================================================
// 微信操作原子函数（用于图文混发）
// ============================================================

// 激活微信窗口，发送到当前激活的聊天
async function activateWeChatInput(targetChat?: string): Promise<void> {
  const log = pluginApi?.logger?.info?.bind(pluginApi?.logger) ?? console.log;

  log(`[wechat-op] Activating WeChat...`);
  await execWithUtf8(`osascript -e '
    tell application "System Events"
      set frontmost of process "WeChat" to true
    end tell
  '`);

  await new Promise((resolve) => setTimeout(resolve, 500));

  if (targetChat?.trim()) {
    const escapedTarget = escapeForShell(targetChat.trim());
    log(`[wechat-op] Switching to target chat: ${targetChat}`);
    await execWithUtf8(`printf '%s' '${escapedTarget}' | pbcopy`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await execWithUtf8(`osascript -e '
      tell application "System Events"
        tell process "WeChat"
          key code 3 using {command down}
          delay 0.2
          key code 9 using {command down}
          delay 0.3
          key code 36
          delay 0.4
          key code 53
        end tell
      end tell
    '`);
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
}

type ClipboardSnapshot = { text: string | null };

async function captureClipboardSnapshot(): Promise<ClipboardSnapshot> {
  try {
    const { stdout } = await execWithUtf8(`pbpaste`);
    return { text: stdout };
  } catch {
    return { text: null };
  }
}

async function restoreClipboardSnapshot(snapshot: ClipboardSnapshot): Promise<void> {
  if (snapshot.text === null) return;
  const escapedText = escapeForShell(snapshot.text);
  await execWithUtf8(`printf '%s' '${escapedText}' | pbcopy`);
}

// 粘贴文字，不发送（全部使用剪贴板粘贴）
async function typeOrPasteText(text: string): Promise<void> {
  const log = pluginApi?.logger?.info?.bind(pluginApi?.logger) ?? console.log;
  const cleanText = stripMarkdown(text);

  log(`[wechat-op] Pasting text (${cleanText.length} chars)...`);
  const escapedText = escapeForShell(cleanText);
  await execWithUtf8(`printf '%s' '${escapedText}' | pbcopy`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await execWithUtf8(`osascript -e '
    tell application "System Events"
      tell process "WeChat"
        key code 9 using {command down}
      end tell
    end tell
  '`);

  // 等待粘贴完成
  await new Promise((resolve) => setTimeout(resolve, 200));
}

// 仅粘贴媒体文件，不发送
async function pasteMedia(mediaPath: string): Promise<void> {
  const log = pluginApi?.logger?.info?.bind(pluginApi?.logger) ?? console.log;

  log(`[wechat-op] Pasting media: ${mediaPath}`);
  const escapedPath = escapeForShell(mediaPath);
  await execWithUtf8(`osascript -e 'set the clipboard to (POSIX file "${escapedPath}")'`);
  await new Promise((resolve) => setTimeout(resolve, 200));

  // 粘贴 (Cmd+V)
  await execWithUtf8(`osascript -e '
    tell application "System Events"
      tell process "WeChat"
        key code 9 using {command down}
      end tell
    end tell
  '`);

  // 等待粘贴完成
  await new Promise((resolve) => setTimeout(resolve, 100));
}

// 发送消息并切换到后台
async function sendAndSwitchToBackground(): Promise<void> {
  const log = pluginApi?.logger?.info?.bind(pluginApi?.logger) ?? console.log;

  // 发送消息 (Cmd+Enter)
  log(`[wechat-op] Sending message (Cmd+Enter)...`);
  await execWithUtf8(`osascript -e '
    tell application "System Events"
      tell process "WeChat"
        key code 36 using {command down}
      end tell
    end tell
  '`);

  // 等待发送完成
  await new Promise((resolve) => setTimeout(resolve, 500));

  // 切换到 Finder，让微信进入后台
  log(`[wechat-op] Switching to background...`);
  await execWithUtf8(`osascript -e 'tell application "Finder" to activate'`);
}

// ============================================================
// 图文混发：支持分批发送（微信限制每条消息最多 9 个媒体）
// ============================================================

// 将 parts 按媒体数量分批，每批最多 WECHAT_MAX_MEDIA_PER_MESSAGE 个媒体
function splitIntoBatches(parts: MessagePart[]): MessagePart[][] {
  const batches: MessagePart[][] = [];
  let currentBatch: MessagePart[] = [];
  let mediaCount = 0;

  for (const part of parts) {
    if (part.type === "media") {
      // 如果当前批次媒体数量已达上限，先保存当前批次
      if (mediaCount >= WECHAT_MAX_MEDIA_PER_MESSAGE) {
        batches.push(currentBatch);
        currentBatch = [];
        mediaCount = 0;
      }
      currentBatch.push(part);
      mediaCount++;
    } else {
      // 文字直接加入当前批次
      currentBatch.push(part);
    }
  }

  // 添加最后一批
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

async function sendMixedContent(parts: MessagePart[], targetChat?: string): Promise<{ ok: boolean; error?: string }> {
  const log = pluginApi?.logger?.info?.bind(pluginApi?.logger) ?? console.log;
  const error = pluginApi?.logger?.error?.bind(pluginApi?.logger) ?? console.error;
  let clipboardSnapshot: ClipboardSnapshot | null = null;

  try {
    clipboardSnapshot = await captureClipboardSnapshot();
    // 统计媒体数量
    const mediaCount = parts.filter((p) => p.type === "media").length;
    log(`[wechat-mixed] Starting to send ${parts.length} parts (${mediaCount} media files) to ${targetChat ?? "current chat"}...`);

    // 分批处理
    const batches = splitIntoBatches(parts);
    log(`[wechat-mixed] Split into ${batches.length} batch(es)`);

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const batchMediaCount = batch.filter((p) => p.type === "media").length;
      log(`[wechat-mixed] Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} parts, ${batchMediaCount} media)`);

      // 1. 激活微信并切换到目标聊天
      await activateWeChatInput(targetChat);

      // 2. 依次粘贴当前批次的每个部分（不发送）
      for (let i = 0; i < batch.length; i++) {
        const part = batch[i];
        log(`[wechat-mixed] Batch ${batchIndex + 1}, part ${i + 1}/${batch.length}: ${part.type}`);

        if (part.type === "text") {
          await typeOrPasteText(part.content);
        } else if (part.type === "media") {
          await pasteMedia(part.path);
        }

        // 部分之间稍微等待
        if (i < batch.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      // 3. 发送当前批次
      await sendAndSwitchToBackground();
      log(`[wechat-mixed] Batch ${batchIndex + 1} sent`);

      // 4. 如果还有下一批，等待后继续
      if (batchIndex < batches.length - 1) {
        log(`[wechat-mixed] Waiting before next batch...`);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    log(`[wechat-mixed] All ${batches.length} batch(es) sent successfully`);
    return { ok: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    error(`[wechat-mixed] Failed: ${errorMsg}`);
    return { ok: false, error: errorMsg };
  } finally {
    if (clipboardSnapshot) {
      await restoreClipboardSnapshot(clipboardSnapshot);
    }
  }
}

// ============================================================
// 原有的单独发送函数（供 outbound.sendText/sendMedia 使用）
// ============================================================

async function sendToWeChat(text: string): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const log = pluginApi?.logger?.info?.bind(pluginApi?.logger) ?? console.log;
  const error = pluginApi?.logger?.error?.bind(pluginApi?.logger) ?? console.error;

  // 清理 Markdown 格式
  const cleanText = stripMarkdown(text);
  let clipboardSnapshot: ClipboardSnapshot | null = null;

  try {
    clipboardSnapshot = await captureClipboardSnapshot();
    log(`[wechat-send] Starting to send message (${cleanText.length} chars): ${cleanText.substring(0, 50)}...`);

    // 1. 确保微信在前台并有窗口
    log(`[wechat-send] Activating WeChat and ensuring window is open...`);
    await execWithUtf8(`osascript -e '
      tell application "System Events"
        set frontmost of process "WeChat" to true
      end tell
    '`);

    // 2. 等待窗口完全激活
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 3. Cmd+↓ 再 Cmd+↑ 聚焦到第一个聊天输入框
    log(`[wechat-send] Focusing first chat input (Cmd+Down then Cmd+Up)...`);
    await execWithUtf8(`osascript -e '
      tell application "System Events"
        tell process "WeChat"
          key code 125 using {command down}
          delay 0.1
          key code 126 using {command down}
        end tell
      end tell
    '`);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 5. 使用剪贴板粘贴
    log(`[wechat-send] Pasting text (${cleanText.length} chars)...`);
    const escapedText = escapeForShell(cleanText);
    await execWithUtf8(`printf '%s' '${escapedText}' | pbcopy`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await execWithUtf8(`osascript -e '
      tell application "System Events"
        tell process "WeChat"
          key code 9 using {command down}
        end tell
      end tell
    '`);

    // 6. 等待粘贴完成
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 7. 发送消息 (Cmd+Enter)
    log(`[wechat-send] Sending message (Cmd+Enter)...`);
    await execWithUtf8(`osascript -e '
      tell application "System Events"
        tell process "WeChat"
          key code 36 using {command down}
        end tell
      end tell
    '`);

    // 8. 等待发送完成
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 9. 切换到 Finder，让微信进入后台（这样才能收到通知）
    log(`[wechat-send] Switching to background (Finder)...`);
    await execWithUtf8(`osascript -e 'tell application "Finder" to activate'`);

    log(`[wechat-send] Message sent successfully`);
    return { ok: true, messageId: `wechat-${Date.now()}` };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    error(`[wechat-send] Failed to send message: ${errorMsg}`);
    return { ok: false, error: errorMsg };
  } finally {
    if (clipboardSnapshot) {
      await restoreClipboardSnapshot(clipboardSnapshot);
    }
  }
}

// 发送媒体文件到微信（图片/文件）
async function sendMediaToWeChat(mediaPath: string): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const log = pluginApi?.logger?.info?.bind(pluginApi?.logger) ?? console.log;
  const error = pluginApi?.logger?.error?.bind(pluginApi?.logger) ?? console.error;
  let clipboardSnapshot: ClipboardSnapshot | null = null;

  try {
    clipboardSnapshot = await captureClipboardSnapshot();
    log(`[wechat-send-media] Starting to send media: ${mediaPath}`);

    // 1. 确保微信在前台并有窗口
    log(`[wechat-send-media] Activating WeChat and ensuring window is open...`);
    await execWithUtf8(`osascript -e '
      tell application "System Events"
        set frontmost of process "WeChat" to true
      end tell
    '`);

    // 2. 等待窗口完全激活
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 3. Cmd+↓ 再 Cmd+↑ 聚焦到第一个聊天输入框
    log(`[wechat-send-media] Focusing first chat input (Cmd+Down then Cmd+Up)...`);
    await execWithUtf8(`osascript -e '
      tell application "System Events"
        tell process "WeChat"
          key code 125 using {command down}
          delay 0.1
          key code 126 using {command down}
        end tell
      end tell
    '`);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 5. 用 AppleScript 把文件复制到剪贴板
    log(`[wechat-send-media] Copying file to clipboard...`);
    const escapedPath = escapeForShell(mediaPath);
    await execWithUtf8(`osascript -e 'set the clipboard to (POSIX file "${escapedPath}")'`);

    // 6. 等待剪贴板就绪
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 7. 粘贴 (Cmd+V)
    log(`[wechat-send-media] Pasting file (Cmd+V)...`);
    await execWithUtf8(`osascript -e '
      tell application "System Events"
        tell process "WeChat"
          key code 9 using {command down}
        end tell
      end tell
    '`);

    // 8. 等待粘贴完成
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 9. 发送消息 (Cmd+Enter)
    log(`[wechat-send-media] Sending media (Cmd+Enter)...`);
    await execWithUtf8(`osascript -e '
      tell application "System Events"
        tell process "WeChat"
          key code 36 using {command down}
        end tell
      end tell
    '`);

    // 10. 等待发送完成
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 11. 切换到 Finder，让微信进入后台（这样才能收到通知）
    log(`[wechat-send-media] Switching to background (Finder)...`);
    await execWithUtf8(`osascript -e 'tell application "Finder" to activate'`);

    log(`[wechat-send-media] Media sent successfully`);
    return { ok: true, messageId: `wechat-media-${Date.now()}` };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    error(`[wechat-send-media] Failed to send media: ${errorMsg}`);
    return { ok: false, error: errorMsg };
  } finally {
    if (clipboardSnapshot) {
      await restoreClipboardSnapshot(clipboardSnapshot);
    }
  }
}

// ============================================================
// 解析消息中的 MEDIA: 标记
// ============================================================

type MessagePart = 
  | { type: "text"; content: string }
  | { type: "media"; path: string };

function parseMessageWithMedia(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const processedPaths = new Set<string>(); // 用于去重
  
  // 第一步：匹配 MEDIA:/path/to/file 格式（要求以已知文件扩展名结尾，防止误匹配对话文字）
  const extPattern = Array.from(SUPPORTED_MEDIA_EXTENSIONS)
    .map((ext) => ext.replace(".", ""))
    .join("|");
  const mediaRegex = new RegExp(`MEDIA:\\s*([^\\s\\n]+\\.(?:${extPattern}))`, "gi");
  
  let lastIndex = 0;
  let match;
  
  while ((match = mediaRegex.exec(text)) !== null) {
    // 添加 MEDIA 之前的文本
    if (match.index > lastIndex) {
      const textBefore = text.slice(lastIndex, match.index).trim();
      if (textBefore) {
        parts.push({ type: "text", content: textBefore });
      }
    }
    
    // 添加媒体文件
    const mediaPath = match[1];
    parts.push({ type: "media", path: mediaPath });
    processedPaths.add(mediaPath);
    
    lastIndex = mediaRegex.lastIndex;
  }
  
  // 添加剩余的文本
  if (lastIndex < text.length) {
    const textAfter = text.slice(lastIndex).trim();
    if (textAfter) {
      parts.push({ type: "text", content: textAfter });
    }
  }
  
  // 如果没有找到任何 MEDIA 标记，返回整个文本
  if (parts.length === 0 && text.trim()) {
    parts.push({ type: "text", content: text });
  }
  
  // 第二步：在文本部分中检测本地文件路径（自动检测功能）
  const finalParts: MessagePart[] = [];
  
  for (const part of parts) {
    if (part.type !== "text") {
      finalParts.push(part);
      continue;
    }
    
    // 检测文本中的本地文件路径
    const detectedPaths = detectLocalFilePaths(part.content);
    
    // 过滤掉已经通过 MEDIA: 处理过的路径
    const newPaths = detectedPaths.filter((p) => !processedPaths.has(p));
    
    if (newPaths.length === 0) {
      // 没有检测到新的路径，保留原文本
      finalParts.push(part);
    } else {
      // 有检测到路径，拆分文本
      let remainingText = part.content;
      
      for (const filePath of newPaths) {
        const pathIndex = remainingText.indexOf(filePath);
        if (pathIndex === -1) continue;
        
        // 路径之前的文本
        const textBefore = remainingText.slice(0, pathIndex).trim();
        if (textBefore) {
          finalParts.push({ type: "text", content: textBefore });
        }
        
        // 添加媒体
        finalParts.push({ type: "media", path: filePath });
        processedPaths.add(filePath);
        
        // 更新剩余文本
        remainingText = remainingText.slice(pathIndex + filePath.length);
      }
      
      // 添加最后剩余的文本
      const finalText = remainingText.trim();
      if (finalText) {
        finalParts.push({ type: "text", content: finalText });
      }
    }
  }
  
  return finalParts;
}

// ============================================================
// Reply Dispatcher (参考飞书)
// ============================================================

type CreateWechatReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtimeEnv: RuntimeEnv;
  chatId: string;
};

function createWechatReplyDispatcher(params: CreateWechatReplyDispatcherParams) {
  const core = getWechatRuntime();
  const { cfg, agentId, runtimeEnv, chatId } = params;

  const prefixContext = createReplyPrefixContext({
    cfg,
    agentId,
  });

  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      runtimeEnv.log?.(`wechat: typing started`);
    },
    stop: async () => {
      runtimeEnv.log?.(`wechat: typing stopped`);
    },
    onStartError: () => {},
    onStopError: () => {},
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit({
    cfg,
    channel: "wechat",
    defaultLimit: 2000,
  });

  let deliverCalled = false;
  let deliverBuffer = "";

  // 将 buffer 内容解析并发送，可附加额外的媒体文件
  async function flushDeliverBuffer(extraMediaPaths?: string[]): Promise<void> {
    const text = deliverBuffer;
    deliverBuffer = "";

    const hasText = !!text.trim();
    const hasMedia = extraMediaPaths && extraMediaPaths.length > 0;

    if (!hasText && !hasMedia) return;

    deliverCalled = true;

    // 从文本中解析 parts（文字 + MEDIA: 标记 + 自动检测路径）
    const parts: MessagePart[] = hasText ? parseMessageWithMedia(text) : [];

    // 追加框架传入的媒体文件
    if (hasMedia) {
      for (const mediaPath of extraMediaPaths) {
        parts.push({ type: "media", path: mediaPath });
      }
    }

    runtimeEnv.log?.(`wechat deliver flush: ${parts.length} parts (text=${hasText}, extraMedia=${extraMediaPaths?.length ?? 0}) target=${chatId}`);

    const result = await sendMixedContent(parts, chatId);
    if (!result.ok) {
      runtimeEnv.error?.(`wechat deliver failed: ${result.error}`);
    }

    runtimeEnv.log?.(`wechat deliver flush: complete`);
  }

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: typingCallbacks.onReplyStart,
      deliver: async (payload: ReplyPayload) => {
        runtimeEnv.log?.(`wechat deliver called: text=${payload.text?.slice(0, 100)}`);

        // ── Token 用量追踪（输出侧） ──
        if (payload.text) {
          addTokenUsage("", payload.text);
        }

        // 提取框架传入的媒体路径（mediaUrls 优先，fallback mediaUrl）
        const payloadAny = payload as any;
        const mediaPaths: string[] = [];
        if (Array.isArray(payloadAny.mediaUrls) && payloadAny.mediaUrls.length > 0) {
          for (const u of payloadAny.mediaUrls) {
            if (typeof u === "string" && u.trim()) mediaPaths.push(u.trim());
          }
        } else if (typeof payloadAny.mediaUrl === "string" && payloadAny.mediaUrl.trim()) {
          mediaPaths.push(payloadAny.mediaUrl.trim());
        }

        if (mediaPaths.length > 0) {
          runtimeEnv.log?.(`wechat deliver: found ${mediaPaths.length} media from payload: ${mediaPaths.join(", ")}`);
        }

        const incoming = payload.text ?? "";
        if (!incoming.trim() && !deliverBuffer && mediaPaths.length === 0) {
          runtimeEnv.log?.(`wechat deliver: empty text and no media, skipping`);
          return;
        }

        // 纯媒体 payload（无文字）→ 立即发送，不走 buffer
        if (!incoming.trim() && !deliverBuffer && mediaPaths.length > 0) {
          await flushDeliverBuffer(mediaPaths);
          return;
        }

        deliverBuffer += incoming;

        // 有媒体附件时立即 flush（不等 MEDIA: 标记完整性检查）
        if (mediaPaths.length > 0) {
          await flushDeliverBuffer(mediaPaths);
          return;
        }

        // 检查 buffer 末尾是否有未闭合的 MEDIA: 标记（路径可能被截断）
        const lastMediaIdx = deliverBuffer.lastIndexOf("MEDIA:");
        if (lastMediaIdx !== -1) {
          const tail = deliverBuffer.slice(lastMediaIdx);
          const hasCompleteTag = /MEDIA:\s*[^\s\n]+\.\w{2,5}(\s|$)/i.test(tail);
          if (!hasCompleteTag) {
            runtimeEnv.log?.(`wechat deliver: incomplete MEDIA: tag at tail, buffering`);
            return;
          }
        }

        // buffer 完整，flush
        await flushDeliverBuffer();
      },
      onError: (err, info) => {
        runtimeEnv.error?.(`wechat ${info.kind} reply failed: ${String(err)}`);
        typingCallbacks.onIdle?.();
      },
      onIdle: async () => {
        // 流结束时，强制 flush 剩余 buffer
        if (deliverBuffer.trim()) {
          runtimeEnv.log?.(`wechat onIdle: flushing remaining buffer (${deliverBuffer.length} chars)`);
          await flushDeliverBuffer();
        }
        typingCallbacks.onIdle?.();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
    },
    markDispatchIdle,
    wasDelivered: () => deliverCalled,
  };
}

// ============================================================
// 消息处理 (参考飞书的 handleFeishuMessage)
// ============================================================

type WechatMessageContext = {
  chatId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  chatType: "direct" | "group";
  content: string;
};

async function handleWechatMessage(params: {
  cfg: ClawdbotConfig;
  ctx: WechatMessageContext;
  runtimeEnv: RuntimeEnv;
}): Promise<void> {
  const { cfg, ctx, runtimeEnv } = params;
  const log = runtimeEnv.log ?? console.log;
  const error = runtimeEnv.error ?? console.error;

  log(`wechat: received message from ${ctx.senderName} in ${ctx.chatId} (type: ${ctx.chatType})`);

  // ── 群聊限定：私聊消息直接忽略 ──
  const wechatCfg = (cfg as any)?.channels?.wechat ?? {};
  const groupOnly: boolean = wechatCfg.groupOnly ?? true;
  if (groupOnly && ctx.chatType !== "group") {
    log(`wechat: ignoring DM (groupOnly=true)`);
    return;
  }

  // ── 动态激活群 + 绑定指令 ──
  const bindTrigger: string = wechatCfg.bindTrigger ?? "！洛茜";
  if (ctx.content.trim() === bindTrigger) {
    // ！洛茜 指令：将当前群设为激活群
    activeGroup = ctx.chatId;
    log(`wechat: 🔗 bound active group to "${ctx.chatId}"`);
    await sendToWeChat(`✅ 已绑定到「${ctx.chatId}」，现在可以用 ＆洛茜 跟我聊天啦！`);
    return;
  }

  // ── 群名过滤：只响应激活群 ──
  if (activeGroup && ctx.chatId !== activeGroup) {
    log(`wechat: group "${ctx.chatId}" is not active group "${activeGroup}", skipping`);
    return;
  }
  if (!activeGroup) {
    // 未绑定任何群，回退到 allowedGroups 配置
    const allowedGroups: string[] = wechatCfg.allowedGroups ?? [];
    if (allowedGroups.length > 0 && !allowedGroups.some((g: string) => ctx.chatId.includes(g))) {
      log(`wechat: group "${ctx.chatId}" not in allowedGroups and no active group, skipping`);
      return;
    }
  }

  // ── 触发符检测（群聊） ──
  // 使用自定义触发符（如 ＆洛茜）代替 @mention，因为微信通知会吞掉 @ 后的实际内容
  const botTrigger: string = wechatCfg.botTrigger ?? "＆洛茜";
  let wasMentioned = false;
  if (ctx.chatType === "group" && botTrigger) {
    const triggerPattern = new RegExp(`${botTrigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`);
    if (triggerPattern.test(ctx.content)) {
      wasMentioned = true;
      // 去掉触发符前缀
      ctx.content = ctx.content.replace(triggerPattern, "").trim();
      if (!ctx.content) {
        ctx.content = "你好";
      }
      log(`wechat: trigger matched, content after strip: ${ctx.content.slice(0, 50)}`);
    } else {
      // 无触发符：消息仍传入 session 作为上下文，洛茜自行判断是否回复
      log(`wechat: group message without trigger, passing as context (sender=${ctx.senderName})`);
    }
  }

  // ── 频率限制检查 ──
  const rateLimitResult = checkRateLimit(cfg);
  if (!rateLimitResult.allowed) {
    let limitMsg = "";
    if (rateLimitResult.reason === "per_minute") {
      limitMsg = `⏳ 请求太频繁，请 ${rateLimitResult.retryAfterSec} 秒后再试`;
    } else if (rateLimitResult.reason === "daily_budget") {
      const usedK = Math.round(rateLimitResult.usedTokens / 1000);
      const budgetK = Math.round(rateLimitResult.budgetTokens / 1000);
      limitMsg = `🚫 今日用量已达上限（${usedK}K / ${budgetK}K tokens），明天再来吧`;
    }
    log(`wechat: rate limited (${rateLimitResult.reason}), sending notice`);
    await sendToWeChat(limitMsg);
    return;
  }

  // 记录本次请求
  recordMessageSent();

  try {
    const core = getWechatRuntime();

    const wechatFrom = `wechat:${ctx.senderId}`;
    const wechatTo = `wechat:${ctx.chatId}`;

    // 解析路由（获取 agentId 和 accountId）
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "wechat",
      peer: {
        kind: ctx.chatType === "group" ? "group" : "dm",
        id: ctx.chatId,
      },
    });

    // ── Token 用量追踪（输入侧） ──
    const inputTokenEstimate = estimateTokens(ctx.content);

    // 生成独立的 sessionKey，确保每个微信用户/群有独立的 session
    // 格式：agent:agentId:wechat:group:群ID（包含 agentId 以确保路由到正确的 agent）
    const sessionKey = `agent:${route.agentId}:wechat:${ctx.chatType === "group" ? "group" : "dm"}:${ctx.chatId}`;

    // 构建消息体：被触发时按用户消息处理；未触发时注入系统前缀，作为静默上下文传给 agent
    const body = wasMentioned
      ? ctx.content
      : buildSilentContextMessage(cfg, ctx.senderName, ctx.content);

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: ctx.content,
      CommandBody: ctx.content,
      From: wechatFrom,
      To: wechatTo,
      SessionKey: sessionKey,  // 使用自定义的 sessionKey
      AccountId: route.accountId,
      ChatType: ctx.chatType,
      SenderName: ctx.senderName,
      SenderId: ctx.senderId,
      Provider: "wechat" as const,
      Surface: "wechat" as const,
      MessageSid: ctx.messageId,
      Timestamp: Date.now(),
      WasMentioned: wasMentioned,
      CommandAuthorized: true,
      OriginatingChannel: "wechat" as const,
      OriginatingTo: wechatTo,
    });

    const { dispatcher, replyOptions, markDispatchIdle, wasDelivered } = createWechatReplyDispatcher({
      cfg,
      agentId: route.agentId,
      runtimeEnv,
      chatId: ctx.chatId,
    });

    log(`wechat: dispatching to agent (session=${sessionKey})`);

    const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    });

    markDispatchIdle();

    log(`wechat: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final}, delivered=${wasDelivered()})`);

    // 只有当被直接触发但没有任何输出时才发 ⏹️
    // 非触发消息（上下文消息）没有回复是正常的，不需要提示
    if (wasMentioned && !queuedFinal && counts.final === 0 && !wasDelivered()) {
      log(`wechat: no replies sent for triggered message, sending stop notification`);
      await sendToWeChat("⏹️");
    }
  } catch (err) {
    error(`wechat: failed to dispatch message: ${String(err)}`);
  }
}

// ============================================================
// Webhook Handler
// ============================================================

async function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024) {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({ ok: false, error: "empty payload" });
          return;
        }
        resolve({ ok: true, value: JSON.parse(raw) as unknown });
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

async function handleWechatWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ClawdbotConfig,
  runtimeEnv: RuntimeEnv
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/webhook") return false;

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  const body = await readJsonBody(req, 1024 * 1024);
  if (!body.ok) {
    res.statusCode = body.error === "payload too large" ? 413 : 400;
    res.end(body.error ?? "invalid payload");
    return true;
  }

  const webhookData = body.value as any;
  const messages = Array.isArray(webhookData?.messages) ? webhookData.messages : [];

  if (messages.length === 0) {
    res.statusCode = 200;
    res.end("ok");
    return true;
  }

  const log = runtimeEnv.log ?? console.log;

  log(`[wechat-webhook] Received ${messages.length} messages`);

  // 立即返回 200，异步处理消息
    res.statusCode = 200;
    res.end("ok");

  const coreRuntime = getWechatRuntime();

  // 处理每条消息
  for (const msg of messages) {
    // 打印消息详情用于调试
    log(`[wechat-webhook] Message: seq=${msg.seq}, isSelf=${msg.isSelf}, sender=${msg.sender}, content=${String(msg.content).substring(0, 30)}...`);
    
    // 跳过自己发送的消息
    if (msg.isSelf === true) {
      log(`[wechat-webhook] Skipping self message`);
      continue;
    }

    // 处理消息类型
    const messageType = msg.type;
    let content = msg.content;

    switch (messageType) {
      case 1:
        // 纯文本，保持原样
        break;
      case 3:
        content = `[图片] ${content}`;
        break;
      case 34:
        content = `[语音] ${content}`;
        break;
      case 43:
        content = `[视频] ${content}`;
        break;
      case 49:
        content = `[文件/链接] ${content}`;
        break;
      default:
        content = `[消息类型:${messageType}] ${content}`;
        break;
    }

    const senderName = msg.senderName || msg.sender || "微信用户";

    // 发件人白名单过滤（allowedSenders 未配置时不过滤）
    const allowedSenders = (cfg as any)?.channels?.wechat?.allowedSenders as string[] | undefined;
    if (allowedSenders && allowedSenders.length > 0) {
      if (!allowedSenders.includes(senderName)) {
        log(`[wechat-webhook] Ignored message from unlisted sender: ${senderName}`);
        continue;
      }
    }

    // === 新的去重逻辑：与通知监控配合 ===
    
    // 检查是否已被通知处理过（用发送者+内容前20字符去重）
    if (isMessageProcessed(senderName, content)) {
      log(`[wechat-webhook] Message already processed by notification, skipping: ${senderName}`);
      continue;
    }

    log(`[wechat-webhook] New message from webhook: ${senderName}`);
    markMessageProcessed(senderName, content);

    const senderId = msg.sender || msg.talker || "unknown";
    const chatId = msg.talker || msg.sender || "unknown";
    const messageId = `wechat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    log(`[wechat-webhook] Processing message from ${senderName}: ${content.substring(0, 50)}...`);

    const ctx: WechatMessageContext = {
      chatId,
      messageId,
      senderId,
      senderName,
      chatType: msg.isChatRoom ? "group" : "direct",
      content,
    };

    // 调用内部消息处理
    handleWechatMessage({ cfg, ctx, runtimeEnv }).catch((err) => {
      runtimeEnv.error?.(`[wechat-webhook] Failed to handle message: ${err}`);
    });
  }

  return true;
}

// ============================================================
// Channel Plugin 定义 (参考飞书)
// ============================================================

type WechatChannelConfig = {
  enabled?: boolean;
  name?: string;
  allowedSenders?: string[];
};

function getWechatConfig(cfg: any): WechatChannelConfig {
  return (cfg?.channels?.wechat as WechatChannelConfig) ?? {};
}

function resolveWechatAccount(cfg: any): {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
} {
  const wechatCfg = getWechatConfig(cfg);
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    name: wechatCfg.name ?? "WeChat",
    enabled: wechatCfg.enabled ?? true,
    configured: true, // 微信通过 UI 自动化，不需要额外配置
  };
}

const wechatPlugin = {
  id: "wechat",
  meta: {
    id: "wechat",
    label: "WeChat",
    selectionLabel: "WeChat (Webhook + UI)",
    blurb: "微信通道，通过 Webhook 接收消息，AppleScript/Peekaboo 发送",
    aliases: ["wechat", "weixin"],
    order: 80,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    edit: false,
    reply: false,
  },
  reload: { configPrefixes: ["channels.wechat"] },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg: any) => resolveWechatAccount(cfg),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: () => true,
    describeAccount: (account: any) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  outbound: {
    deliveryMode: "stream",
    textChunkLimit: 2000,
    sendText: async ({ cfg, to, text }: { cfg: any; to: string; text: string }) => {
      pluginApi?.logger?.info(`[wechat-outbound] sendText called! to=${to}`);
      const result = await sendToWeChat(text);
      return {
        channel: "wechat",
        ok: result.ok,
        messageId: result.messageId ?? "",
        error: result.error,
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl }: { cfg: any; to: string; text?: string; mediaUrl?: string }) => {
      pluginApi?.logger?.info(`[wechat-outbound] sendMedia called! to=${to}, mediaUrl=${mediaUrl}`);
      
      // 如果有文字，先发送文字
      if (text?.trim()) {
        const textResult = await sendToWeChat(text);
        if (!textResult.ok) {
          return {
            channel: "wechat",
            ok: false,
            messageId: "",
            error: textResult.error,
          };
        }
        // 等待一下再发送媒体
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      
      // 发送媒体文件
      if (mediaUrl) {
        // 处理本地路径（去掉 file:// 前缀）
        let filePath = mediaUrl;
        if (filePath.startsWith("file://")) {
          filePath = filePath.replace("file://", "");
        }
        if (filePath.startsWith("~")) {
          filePath = filePath.replace("~", process.env.HOME ?? "");
        }
        
        const mediaResult = await sendMediaToWeChat(filePath);
        return {
          channel: "wechat",
          ok: mediaResult.ok,
          messageId: mediaResult.messageId ?? "",
          error: mediaResult.error,
        };
      }
      
      return {
        channel: "wechat",
        ok: true,
        messageId: `wechat-${Date.now()}`,
      };
    },
  },
  gateway: {
    startAccount: async (gatewayCtx: any) => {
      gatewayCtx.log?.info?.(`wechat: starting provider`);
      gatewayCtx.setStatus({ accountId: gatewayCtx.accountId, port: null });

      const log = gatewayCtx.log?.info?.bind(gatewayCtx.log) ?? console.log;
      const error = gatewayCtx.log?.error?.bind(gatewayCtx.log) ?? console.error;
      const cfg = gatewayCtx.cfg; // 注意：飞书插件用的是 ctx.cfg，不是 ctx.config

      // 构建 runtimeEnv
      const runtimeEnv: RuntimeEnv = {
        log,
        error,
      };

      // 辅助函数：从通知数据创建消息并发送给 Agent
      // 微信群通知格式：sender = 群名, body = "发送者: 消息内容" 或 "发送者在群聊中@了你"
      async function processNotificationMessage(sender: string, content: string): Promise<void> {
        const messageId = `wechat-notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // 检测是否为群聊消息：body 中包含 "发送者: 内容" 格式
        // 微信群通知的 body 格式：
        //   "张三: 消息内容"
        //   "张三在群聊中@了你"
        //   "张三: @扫拖一体🤖 消息内容"
        const groupMessageMatch = content.match(/^(.+?)[:：]\s*(.+)$/s);
        const groupMentionMatch = content.match(/^(.+?)在群聊中@了你$/);

        let chatType: "direct" | "group" = "direct";
        let senderName = sender;
        let chatId = sender;
        let actualContent = content;

        if (groupMessageMatch) {
          // "发送者: 内容" 格式 → 群聊
          chatType = "group";
          senderName = groupMessageMatch[1].trim();
          chatId = sender; // sender 是群名
          actualContent = groupMessageMatch[2].trim();
        } else if (groupMentionMatch) {
          // "发送者在群聊中@了你" → 旧式 @mention 通知，无实际内容，忽略
          // 用户应使用 ＆洛茜 触发符代替 @
          log(`[wechat-notify] @mention notification without content, ignoring (use trigger symbol instead)`);
          return;
        }

        log(`[wechat-notify] Parsed: chatType=${chatType}, group=${chatId}, sender=${senderName}, content=${actualContent.slice(0, 50)}`);

        const messageCtx: WechatMessageContext = {
          chatId,
          messageId,
          senderId: senderName,
          senderName,
          chatType,
          content: actualContent,
        };

        await handleWechatMessage({ cfg, ctx: messageCtx, runtimeEnv });
      }

      // 启动通知监控
      await startNotificationMonitor(
        async (sender: string, content: string) => {
          // 发件人白名单过滤（allowedSenders 未配置时不过滤）
          const allowedSenders = (cfg as any)?.channels?.wechat?.allowedSenders as string[] | undefined;
          if (allowedSenders && allowedSenders.length > 0) {
            if (!allowedSenders.includes(sender)) {
              log(`[wechat-notify] Ignored notification from unlisted sender: ${sender}`);
              return;
            }
          }

          // 通知监控不做去重检查，收到就处理
          // 去重只在 webhook 端做，防止 webhook 重复处理已被通知处理过的消息

          let finalContent = content;
          if (shouldWaitForWebhook(content)) {
            if (isMediaMessage(content)) {
              log(`[wechat-notify] Media message cannot be recovered from notification OCR, skipped: ${sender}`);
              return;
            }
            log(`[wechat-notify] Attempting OCR recovery for truncated notification: ${sender}: ${content.slice(0, 30)}...`);
            finalContent = await Promise.race([
              enrichNotificationWithOcr(sender, content, log),
              new Promise<string>((resolve) => setTimeout(() => resolve(content), OCR_TOTAL_TIMEOUT_MS)),
            ]);
          } else {
            log(`[wechat-notify] Processing short message directly: ${sender}: ${content}`);
          }

          markMessageProcessed(sender, finalContent);

          try {
            await processNotificationMessage(sender, finalContent);
          } catch (err) {
            error(`[wechat-notify] Failed to process message: ${err}`);
          }
        },
        log
      );

      // 返回一个永不 resolve 的 Promise 保持运行
      return new Promise<void>((resolve) => {
        gatewayCtx.abortSignal?.addEventListener("abort", () => {
          gatewayCtx.log?.info?.(`wechat: provider stopped`);
          stopNotificationMonitor();
          resolve();
        });
      });
    },
  },
};

// ============================================================
// 插件注册
// ============================================================

const plugin = {
  id: "wechat",
  name: "WeChat Webhook Channel",
  description: "Receives WeChat messages via Webhook and registers WeChat channel.",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    pluginApi = api;

    // 保存 runtime 引用 (关键!)
    setWechatRuntime(api.runtime);

    api.logger.info(`[wechat-webhook] Plugin registering...`);

    // 注册 channel
    api.registerChannel({ plugin: wechatPlugin as any });

    // 注册 HTTP route（webhook 接收端）
    api.registerHttpRoute({
      path: "/api/webhook",
      auth: "plugin",
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        await handleWechatWebhookRequest(
          req,
          res,
          api.config as ClawdbotConfig,
          api.runtime as unknown as RuntimeEnv
        );
      },
    });

    api.logger.info("WeChat Webhook channel plugin activated. Listening for webhooks on /api/webhook");
  },
};

export default plugin;
