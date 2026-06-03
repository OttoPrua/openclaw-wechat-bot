export type WechatAgentConfig = {
  id: string;
  bindTrigger: string;
  unbindTrigger: string;
  mentionNames: string[];
};

export type LegacyRossiTriggerMatch = {
  kind: "bind" | "unbind";
  notice: string;
};

export type NotificationCandidate = {
  appName?: string;
  title: string;
  body: string;
};

export type NotificationGateOptions = {
  requireWechatAppName?: boolean;
};

export type DedupeState = Map<string, number>;

export const DEFAULT_WECHAT_AGENT_ID = "tomimi";
export const DEFAULT_TOMIMI_BIND_TRIGGER = "&特米米";
export const DEFAULT_TOMIMI_UNBIND_TRIGGER = "！特米米";
export const DEFAULT_TOMIMI_MENTION_NAMES = ["特米米", "Tomimi", "tomimi"];
export const ARCHIVED_ROSSI_NOTICE = "洛茜入口已归档，请使用 &特米米";
export const DEFAULT_MESSAGE_BUFFER_MAX = 10;

export const DEFAULT_DEDUPE_WINDOW_MS = 5_000;

export type WechatMentionMatch = {
  mentioned: boolean;
  content: string;
  agentId?: string;
  matchedName?: string;
  matchType?: "botName" | "name";
};

export function normalizeSymbols(text: string): string {
  return text.replace(/＆/g, "&").replace(/!/g, "！");
}

function stripMentionSeparator(text: string): string {
  return text
    .replace(/^[\s,，:：;；、!！?？]+/u, "")
    .replace(/[\s,，:：;；、!！?？]+$/u, "")
    .trim();
}

function removeMentionName(content: string, index: number, name: string): string {
  return stripMentionSeparator(`${content.slice(0, index)}${content.slice(index + name.length)}`)
    .replace(/\s+/g, " ");
}

function hasDirectMentionBoundary(text: string): boolean {
  return text === "" || /^[\s,，:：;；、!！?？]/u.test(text);
}

export function detectWechatAgentMention(
  content: string,
  agentConfigs: WechatAgentConfig[],
  botName = "扫拖一体🤖",
): WechatMentionMatch {
  const trimmed = content.trim();
  if (!trimmed) return { mentioned: false, content: "" };

  const normalizedBotName = botName.trim();
  const botMention = normalizedBotName ? `@${normalizedBotName}` : "";
  if (botMention && trimmed.startsWith(botMention)) {
    const rest = trimmed.slice(botMention.length);
    if (hasDirectMentionBoundary(rest)) {
      return {
        mentioned: true,
        content: stripMentionSeparator(rest),
        matchType: "botName",
      };
    }
  }

  for (const agentConfig of agentConfigs) {
    for (const rawName of agentConfig.mentionNames) {
      const name = rawName.trim();
      if (!name) continue;
      const index = trimmed.indexOf(name);
      if (index < 0) continue;
      return {
        mentioned: true,
        content: removeMentionName(trimmed, index, name),
        agentId: agentConfig.id,
        matchedName: name,
        matchType: "name",
      };
    }
  }

  return { mentioned: false, content: trimmed };
}

export function appendBoundedBufferMessage<T>(
  messages: readonly T[],
  message: T,
  maxMessages = DEFAULT_MESSAGE_BUFFER_MAX,
): T[] {
  const boundedMax = Number.isFinite(maxMessages) && maxMessages > 0
    ? Math.floor(maxMessages)
    : DEFAULT_MESSAGE_BUFFER_MAX;
  return [...messages, message].slice(-boundedMax);
}

export function getWechatAgentConfigs(wechatCfg: any): WechatAgentConfig[] {
  if (Array.isArray(wechatCfg?.agents) && wechatCfg.agents.length > 0) {
    const configuredAgents = wechatCfg.agents
      .filter((agent: any) => agent?.id !== "rossi")
      .map((agent: any) => ({
        id: String(agent.id),
        bindTrigger: String(agent.bindTrigger ?? `&${agent.mentionNames?.[0] ?? agent.id}`),
        unbindTrigger: String(agent.unbindTrigger ?? agent.bindTrigger?.replace(/^&/, "！") ?? `！${agent.mentionNames?.[0] ?? agent.id}`),
        mentionNames: Array.isArray(agent.mentionNames) ? agent.mentionNames.map(String) : [String(agent.id)],
      }));
    if (!configuredAgents.some((agent) => agent.id === DEFAULT_WECHAT_AGENT_ID)) {
      configuredAgents.unshift({
        id: DEFAULT_WECHAT_AGENT_ID,
        bindTrigger: DEFAULT_TOMIMI_BIND_TRIGGER,
        unbindTrigger: DEFAULT_TOMIMI_UNBIND_TRIGGER,
        mentionNames: [...DEFAULT_TOMIMI_MENTION_NAMES],
      });
    }
    return configuredAgents;
  }

  const agentId = wechatCfg?.agent && wechatCfg.agent !== "rossi" ? String(wechatCfg.agent) : DEFAULT_WECHAT_AGENT_ID;
  if (agentId === DEFAULT_WECHAT_AGENT_ID) {
    return [{
      id: DEFAULT_WECHAT_AGENT_ID,
      bindTrigger: DEFAULT_TOMIMI_BIND_TRIGGER,
      unbindTrigger: DEFAULT_TOMIMI_UNBIND_TRIGGER,
      mentionNames: [...DEFAULT_TOMIMI_MENTION_NAMES],
    }];
  }

  const trigger = String(wechatCfg?.botTrigger ?? `&${agentId}`);
  const nameFromTrigger = trigger.replace(/[＆&]/g, "");
  return [{
    id: agentId,
    bindTrigger: `&${nameFromTrigger}`,
    unbindTrigger: `！${nameFromTrigger}`,
    mentionNames: [nameFromTrigger],
  }];
}

export function matchBindTrigger(content: string, agentConfigs: WechatAgentConfig[]): WechatAgentConfig | null {
  const normalized = normalizeSymbols(content.trim());
  for (const agentConfig of agentConfigs) {
    const trigger = normalizeSymbols(agentConfig.bindTrigger);
    if (trigger && normalized.includes(trigger)) return agentConfig;
  }
  return null;
}

export function matchUnbindTrigger(content: string, agentConfigs: WechatAgentConfig[]): WechatAgentConfig | null {
  const normalized = normalizeSymbols(content.trim());
  for (const agentConfig of agentConfigs) {
    const trigger = normalizeSymbols(agentConfig.unbindTrigger);
    if (trigger && normalized.includes(trigger)) return agentConfig;
  }
  return null;
}

export function matchLegacyRossiTrigger(content: string): LegacyRossiTriggerMatch | null {
  const normalized = normalizeSymbols(content.trim());
  if (normalized.includes("&洛茜")) return { kind: "bind", notice: ARCHIVED_ROSSI_NOTICE };
  if (normalized.includes("！洛茜")) return { kind: "unbind", notice: ARCHIVED_ROSSI_NOTICE };
  return null;
}

export function isAllowedGroup(groupName: string, allowedGroups?: string[]): boolean {
  if (!Array.isArray(allowedGroups) || allowedGroups.length === 0) return true;
  return allowedGroups.includes(groupName);
}

export function getAllowedWechatGroups(wechatCfg: any): string[] {
  if (!Array.isArray(wechatCfg?.allowedGroups)) return [];
  return wechatCfg.allowedGroups
    .map((group: unknown) => String(group).trim())
    .filter(Boolean);
}

export function normalizeWechatOutboundTarget(raw: string): string {
  let target = String(raw ?? "").trim();
  for (;;) {
    const next = target.replace(/^(wechat|weixin|group):/i, "").trim();
    if (next === target) break;
    target = next;
  }
  return target;
}

export function resolveWechatAllowedGroupTarget(raw: string, wechatCfg: any): {
  to: string;
  kind: "group";
  display: string;
  source: "directory" | "normalized";
} | null {
  const target = normalizeWechatOutboundTarget(raw);
  if (!target) return null;

  const allowedGroups = getAllowedWechatGroups(wechatCfg);
  if (allowedGroups.length === 0) {
    return {
      to: target,
      kind: "group",
      display: target,
      source: "normalized",
    };
  }

  const matched = allowedGroups.find((group) => group === target);
  if (!matched) return null;
  return {
    to: matched,
    kind: "group",
    display: matched,
    source: "directory",
  };
}

export function listWechatAllowedGroupEntries(wechatCfg: any, query?: string | null, limit?: number | null): Array<{
  kind: "group";
  id: string;
  name: string;
  rank: number;
}> {
  const normalizedQuery = normalizeWechatOutboundTarget(query ?? "");
  const groups = getAllowedWechatGroups(wechatCfg);
  const filtered = normalizedQuery
    ? groups.filter((group) => group.includes(normalizedQuery))
    : groups;
  const boundedLimit = Number.isFinite(limit) && Number(limit) > 0
    ? Math.floor(Number(limit))
    : filtered.length;

  return filtered.slice(0, boundedLimit).map((group) => ({
    kind: "group",
    id: group,
    name: group,
    rank: group === normalizedQuery ? 100 : 0,
  }));
}

export function parseWechatAtMentionNotification(body: string): string | null {
  const match = body.trim().match(/^(.+?)在群(?:聊)?中@了你$/);
  const senderName = match?.[1]?.trim();
  return senderName || null;
}

export function isLikelyWechatGroupNotification(
  candidate: NotificationCandidate,
  options: NotificationGateOptions = {},
): boolean {
  const requireWechatAppName = options.requireWechatAppName ?? true;
  const appName = candidate.appName?.trim();
  const isWechatApp = appName === "微信" || appName === "WeChat";
  if (requireWechatAppName && !isWechatApp) return false;
  if (!requireWechatAppName && appName && !isWechatApp) return false;

  const body = candidate.body.trim();
  if (!body) return false;
  if (parseWechatAtMentionNotification(body)) return true;

  const groupMessageMatch = body.match(/^(.+?)[:：]\s*(.+)$/s);
  if (!groupMessageMatch) return false;

  const senderName = groupMessageMatch[1]?.trim();
  const messageBody = groupMessageMatch[2]?.trim();
  if (!senderName || !messageBody) return false;

  const systemAppPattern = /^(Mail|Calendar|Messages|Reminders|FaceTime|Slack|Discord|Telegram|WhatsApp|Signal|Teams|Zoom|Outlook|Gmail|Chrome|Safari|Firefox|Arc|Notion|Linear|GitHub|VS Code|Xcode|Terminal|iTerm2|Finder|TED Talks Daily)$/i;
  return !systemAppPattern.test(senderName);
}

export function buildDedupeKey(chatId: string, sender: string, content: string): string {
  return `${chatId}:::${sender}:::${content.slice(0, 80)}`;
}

export function isDuplicateMessage(
  state: DedupeState,
  chatId: string,
  sender: string,
  content: string,
  now: number,
  windowMs = DEFAULT_DEDUPE_WINDOW_MS,
): boolean {
  const key = buildDedupeKey(chatId, sender, content);
  const lastSeenAt = state.get(key);
  state.set(key, now);

  for (const [entryKey, seenAt] of state) {
    if (now - seenAt > windowMs) {
      state.delete(entryKey);
    }
  }

  return typeof lastSeenAt === "number" && now - lastSeenAt <= windowMs;
}

export function buildAgentSessionKey(agentId: string, chatType: "direct" | "group", chatId: string): string {
  return `agent:${agentId}:wechat:${chatType === "group" ? "group" : "dm"}:${chatId}`;
}
