/**
 * 视觉模型的提示词（v2）。
 *
 * v2 相比 v1 多要三样东西，对应三个真实需求：
 *   origin / lifecycle  —— 梗从哪来、现在还在不在用（来源与去处）
 *   combo               —— 这个梗能跟什么一起用、不能跟什么一起用
 *   boundary + reply×2  —— 什么场合不该玩梗，以及永远给一条不玩梗的退路
 */

export const ANALYSIS_SYSTEM_PROMPT = [
  "你是一个中文网络表情包解读助手。读者是另一个 AI agent，它会把你的结论转述给人类。",
  "",
  "三条铁律，违反其中任何一条都是失败：",
  "1. 不要编造出处。没有可靠依据就写 null。编一个出处比说不知道有害得多。",
  "2. 你对「现在还流不流行」的判断来自训练数据，永远是过去时。",
  "   不确定就写 unknown，不要写 stable。用过期梗比不懂梗更尴尬。",
  "3. 每条回复建议必须给两个版本：玩梗版和不玩梗版。",
  "   不会玩梗的人只是无趣，分寸错了的人会得罪人。",
  "",
  "其余要求：",
  "- 只输出一个 JSON 对象，不要用 markdown 代码块包裹，不要任何解释性文字。",
  "- 图上的字看不清就写近似内容，并在 uncertainty 里说明。",
  "- confidence 只能是 high / medium / low。不确定给 low，这不丢人。",
  "- meaning 和 reply 都要写成能直接说出口的人话，不要科普腔。",
].join("\n");

const SCHEMA = [
  "{",
  '  "text_on_image": "图上文字，竖排/多段用 / 分隔；没有则为空字符串",',
  '  "visual": "画面描述，一两句",',
  '  "meme_name": "这个梗的常见叫法，不知道为 null",',
  '  "meaning": "一句话说清它想表达什么",',
  '  "tone": "示好/玩笑/反讽/阴阳/敷衍/求安慰/其它",',
  '  "origin": {',
  '    "type": "影视|游戏|动漫|主播|社会事件|广告|方言|梗图|其他",',
  '    "time": "大致时间，如 2021 年；不知道为 null",',
  '    "carrier": "首发载体，如 某剧第3集/某主播直播/某游戏",',
  '    "first_seen_by": "最早是谁带火的，不知道为 null",',
  '    "sources": ["可靠来源的简短描述，不要编 URL"],',
  '    "confidence": "high|medium|low"',
  "  },",
  '  "lifecycle": {',
  '    "status": "rising|stable|fading|dead|unknown",',
  '    "peak_year": "最火的年份，如 2022；不知道为 null",',
  '    "last_evidence": "你为什么这么判断，一句话",',
  '    "reasons": ["判断依据"]',
  "  },",
  '  "drift": { "variants": ["变体写法或配图"], "meaning_shift": "词义/用法有没有变，没有则为 null" },',
  '  "combo": {',
  '    "works_with": [{ "meme": "能一起用的梗", "effect": "叠一起的效果" }],',
  '    "avoid_with": [{ "meme": "不能混着用的梗", "reason": "为什么违和" }]',
  "  },",
  '  "boundary": {',
  '    "safe": ["什么场合/对什么人可以用"],',
  '    "avoid": ["什么场合绝对别用"],',
  '    "rule": "一句话总结用它的前提条件"',
  "  },",
  '  "risk": { "level": "low|medium|high", "reasons": ["冒犯/地域/性别/政治等风险点"] },',
  '  "reply": {',
  '    "meme": "玩梗版回复，二十字以内，自然口语",',
  '    "plain": "不玩梗版回复，正经但不生硬",',
  '    "why": "两个版本分别适合什么情况"',
  "  },",
  '  "usage_examples": ["别人一般在什么场景发它"],',
  '  "confidence": "high|medium|low",',
  '  "uncertainty": "你不确定的地方，没有则为 null"',
  "}",
].join("\n");

/**
 * @param {{ replyContext?: string, localCombos?: { name: string, count: number }[] }} input
 */
export function buildAnalysisMessages({ replyContext, localCombos }) {
  const contextLine =
    typeof replyContext === "string" && replyContext.trim() !== ""
      ? `对方发这张图时的上下文原话是：「${replyContext.trim()}」。请据此判断语气。`
      : "没有提供上下文，请按常见用法判断。";

  const comboLine =
    Array.isArray(localCombos) && localCombos.length > 0
      ? `本机历史记录显示，这个梗常和这些梗前后脚出现：${localCombos
        .map((item) => `${item.name}(${item.count}次)`)
        .join("、")}。可作参考，但不要当作出处证据。`
      : "";

  const userText = [
    "请解读这张表情包，并按下面的 JSON 结构输出。",
    contextLine,
    comboLine,
    "",
    SCHEMA,
  ].filter((line) => line !== "").join("\n");

  return [
    { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
    { role: "user", content: userText },
  ];
}
