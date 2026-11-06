/**
 * 视觉模型调用的提示词。
 *
 * 要点：让模型同时做两件它擅长的事（认字 + 描述画面），
 * 但**不要**让它硬猜梗的出处——那是检索的活。把「不确定」作为一等公民，
 * 模型才敢在不知道时说不知道。
 */

export const ANALYSIS_SYSTEM_PROMPT = [
  "你是一个中文网络表情包解读助手。",
  "用户会给你一张表情包图片（可能是聊天截图里的一格）。",
  "你的任务是：读出图上的文字、描述画面、判断它在当下语境里想表达什么。",
  "",
  "硬性要求：",
  "1. 只输出一个 JSON 对象，不要输出任何解释性文字、不要用 markdown 代码块包裹。",
  "2. 图上的字如果看不清，就写你看到的近似内容，并在 uncertainty 里说明。",
  "3. 不要编造梗的出处、作者、具体事件。你不知道就说 null。",
  "4. confidence 只能是 high / medium / low 之一。不确定就给 low，这不丢人。",
].join("\n");

/**
 * @param {{ replyContext?: string }} input
 */
export function buildAnalysisMessages({ replyContext }) {
  const contextLine =
    typeof replyContext === "string" && replyContext.trim() !== ""
      ? `对方发这张图时的上下文原话是：「${replyContext.trim()}」。请据此判断语气。`
      : "没有提供上下文，请按常见用法判断。";

  const userText = [
    "请解读这张表情包。",
    contextLine,
    "",
    "输出 JSON，字段如下：",
    "{",
    '  "text_on_image": "图上文字，竖排/多段用 / 分隔；没有文字则为空字符串",',
    '  "visual": "画面描述，一两句",',
    '  "meme_name": "这个梗的常见叫法，不知道则为 null",',
    '  "meaning": "一句话说清它想表达什么，要像人说话",',
    '  "tone": "语气：示好/玩笑/反讽/阴阳/敷衍/求安慰/其它",',
    '  "usage_examples": ["别人一般什么场景发它", "另一条"],',
    '  "reply_suggestion": "收到这张图的人可以怎么接一句，二十字以内，自然口语",',
    '  "confidence": "high | medium | low",',
    '  "uncertainty": "你不确定的地方，没有则为 null"',
    "}",
  ].join("\n");

  return [
    { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
    { role: "user", content: userText },
  ];
}
