import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

const coreUrl = new URL("../src/wechat-core.ts", import.meta.url);

if (!existsSync(coreUrl)) {
  test("wechat core seam is available", { skip: "src/wechat-core.ts is not present in this packaging-only refresh" }, () => {});
} else {
  const {
    ARCHIVED_ROSSI_NOTICE,
    appendBoundedBufferMessage,
    buildAgentSessionKey,
    detectWechatAgentMention,
    DEFAULT_MESSAGE_BUFFER_MAX,
    getAllowedWechatGroups,
    getWechatAgentConfigs,
    isAllowedGroup,
    isDuplicateMessage,
    isLikelyWechatGroupNotification,
    listWechatAllowedGroupEntries,
    matchBindTrigger,
    matchLegacyRossiTrigger,
    matchUnbindTrigger,
    normalizeWechatOutboundTarget,
    parseWechatAtMentionNotification,
    resolveWechatAllowedGroupTarget,
  } = await import(coreUrl.href);

test("defaults to Tomimi when no multi-agent config is present", () => {
  const agents = getWechatAgentConfigs({});

  assert.deepEqual(agents, [
    {
      id: "tomimi",
      bindTrigger: "&特米米",
      unbindTrigger: "！特米米",
      mentionNames: ["特米米", "Tomimi", "tomimi"],
    },
  ]);
});

test("injects Tomimi and filters archived Rossi when multi-agent config omits Tomimi", () => {
  const agents = getWechatAgentConfigs({
    agent: "rossi",
    agents: [
      {
        id: "rossi",
        bindTrigger: "&洛茜",
        unbindTrigger: "！洛茜",
        mentionNames: ["洛茜", "Rossi", "rossi"],
      },
      {
        id: "tangtang",
        bindTrigger: "&汤汤",
        unbindTrigger: "！汤汤",
        mentionNames: ["汤汤", "tangtang"],
      },
    ],
  });

  assert.deepEqual(agents, [
    {
      id: "tomimi",
      bindTrigger: "&特米米",
      unbindTrigger: "！特米米",
      mentionNames: ["特米米", "Tomimi", "tomimi"],
    },
    {
      id: "tangtang",
      bindTrigger: "&汤汤",
      unbindTrigger: "！汤汤",
      mentionNames: ["汤汤", "tangtang"],
    },
  ]);
});

test("matches Tomimi bind and unbind triggers with full-width variants", () => {
  const agents = getWechatAgentConfigs({});

  assert.equal(matchBindTrigger("＆特米米 帮我看看这个", agents)?.id, "tomimi");
  assert.equal(matchUnbindTrigger("!特米米", agents)?.id, "tomimi");
});

test("legacy Rossi trigger is archived and never maps to an agent", () => {
  const agents = getWechatAgentConfigs({});

  assert.equal(matchBindTrigger("&洛茜", agents), null);
  assert.equal(matchUnbindTrigger("！洛茜", agents), null);
  assert.deepEqual(matchLegacyRossiTrigger("＆洛茜 你好"), {
    kind: "bind",
    notice: ARCHIVED_ROSSI_NOTICE,
  });
  assert.deepEqual(matchLegacyRossiTrigger("!洛茜"), {
    kind: "unbind",
    notice: ARCHIVED_ROSSI_NOTICE,
  });
});

test("allowedGroups blocks unlisted group notifications", () => {
  assert.equal(isAllowedGroup("目标群", ["目标群"]), true);
  assert.equal(isAllowedGroup("陌生群", ["目标群"]), false);
  assert.equal(isAllowedGroup("任何群", []), true);
  assert.equal(isAllowedGroup("任何群", undefined), true);
});

test("wechat outbound target resolution is restricted to configured allowedGroups", () => {
  const wechatCfg = { allowedGroups: ["测试群A", "测试测试"] };

  assert.deepEqual(getAllowedWechatGroups(wechatCfg), ["测试群A", "测试测试"]);
  assert.equal(normalizeWechatOutboundTarget("wechat:测试测试"), "测试测试");
  assert.equal(normalizeWechatOutboundTarget("group: 测试群A"), "测试群A");
  assert.deepEqual(resolveWechatAllowedGroupTarget("wechat:测试测试", wechatCfg), {
    to: "测试测试",
    kind: "group",
    display: "测试测试",
    source: "directory",
  });
  assert.equal(resolveWechatAllowedGroupTarget("陌生群", wechatCfg), null);
  assert.deepEqual(listWechatAllowedGroupEntries(wechatCfg, "测试", 5), [
    {
      kind: "group",
      id: "测试测试",
      name: "测试测试",
      rank: 0,
    },
  ]);
});

test("notification gate requires WeChat source and group-like body", () => {
  assert.equal(
    isLikelyWechatGroupNotification({
      appName: "微信",
      title: "目标群",
      body: "管理员: &特米米 hello",
    }),
    true,
  );
  assert.equal(
    isLikelyWechatGroupNotification({
      appName: "Slack",
      title: "目标群",
      body: "管理员: &特米米 hello",
    }),
    false,
  );
  assert.equal(
    isLikelyWechatGroupNotification({
      appName: "微信",
      title: "目标群",
      body: "plain body without sender separator",
    }),
    false,
  );
  assert.equal(
    isLikelyWechatGroupNotification({
      title: "目标群",
      body: "管理员: &特米米 hello",
    }),
    false,
  );
  assert.equal(
    isLikelyWechatGroupNotification(
      {
        title: "目标群",
        body: "管理员: &特米米 hello",
      },
      { requireWechatAppName: false },
    ),
    true,
  );
});

test("notification gate accepts WeChat at-mention wording without message content", () => {
  assert.equal(parseWechatAtMentionNotification("虚构用户A在群中@了你"), "虚构用户A");
  assert.equal(parseWechatAtMentionNotification("虚构用户A在群聊中@了你"), "虚构用户A");
  assert.equal(parseWechatAtMentionNotification("虚构用户A: @扫拖一体🤖 hello"), null);
  assert.equal(
    isLikelyWechatGroupNotification({
      appName: "微信",
      title: "测试测试",
      body: "虚构用户A在群中@了你",
    }),
    true,
  );
});

test("message dedupe uses sender, content prefix, and a short time window", () => {
  const state = new Map();

  assert.equal(isDuplicateMessage(state, "群", "发送者", "同一条消息内容", 1000), false);
  assert.equal(isDuplicateMessage(state, "群", "发送者", "同一条消息内容", 1100), true);
  assert.equal(isDuplicateMessage(state, "群", "发送者", "同一条消息内容", 10_000), false);
});

test("session keys include Tomimi agent id and group name", () => {
  assert.equal(
    buildAgentSessionKey("tomimi", "group", "目标群"),
    "agent:tomimi:wechat:group:目标群",
  );
});

test("bound group mentions trigger when Tomimi is named anywhere or bot is at-mentioned", () => {
  const agents = getWechatAgentConfigs({});

  assert.deepEqual(
    detectWechatAgentMention("特米米看看这个", agents, "扫拖一体🤖"),
    {
      mentioned: true,
      content: "看看这个",
      agentId: "tomimi",
      matchedName: "特米米",
      matchType: "name",
    },
  );
  assert.deepEqual(
    detectWechatAgentMention("特米米觉得呢", agents, "扫拖一体🤖"),
    {
      mentioned: true,
      content: "觉得呢",
      agentId: "tomimi",
      matchedName: "特米米",
      matchType: "name",
    },
  );
  assert.deepEqual(
    detectWechatAgentMention("Tomimi：请回复一句英文触发收到", agents, "扫拖一体🤖"),
    {
      mentioned: true,
      content: "请回复一句英文触发收到",
      agentId: "tomimi",
      matchedName: "Tomimi",
      matchType: "name",
    },
  );
  assert.deepEqual(
    detectWechatAgentMention("@扫拖一体🤖 请回复一句 at 触发收到", agents, "扫拖一体🤖"),
    {
      mentioned: true,
      content: "请回复一句 at 触发收到",
      matchType: "botName",
    },
  );
  assert.deepEqual(
    detectWechatAgentMention("我觉得 tomimi 这个模型名字挺可爱的", agents, "扫拖一体🤖"),
    {
      mentioned: true,
      content: "我觉得 这个模型名字挺可爱的",
      agentId: "tomimi",
      matchedName: "tomimi",
      matchType: "name",
    },
  );
  assert.deepEqual(
    detectWechatAgentMention("今天特米米会不会插话", agents, "扫拖一体🤖"),
    {
      mentioned: true,
      content: "今天会不会插话",
      agentId: "tomimi",
      matchedName: "特米米",
      matchType: "name",
    },
  );
});

test("bounded group buffer keeps only the latest ten messages", () => {
  let messages = [];
  for (let i = 0; i < 12; i += 1) {
    messages = appendBoundedBufferMessage(messages, { idx: i }, DEFAULT_MESSAGE_BUFFER_MAX);
  }

  assert.equal(messages.length, 10);
  assert.equal(messages[0].idx, 2);
  assert.equal(messages[9].idx, 11);
});
}
