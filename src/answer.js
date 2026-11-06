/**
 * 结论的数据模型（v2）。
 *
 * v1 只有一个 summary + usage，够用但表达不了三件事：
 *   - 来源与去处（一个梗从哪来、现在还在不在用）
 *   - 组合（这个梗能跟什么一起用、不能跟什么一起用）
 *   - 界限（什么场合不该玩这个梗）
 *
 * v2 把它们都变成一等字段，并且允许为 null——
 * 「不知道」是合法答案，比编一个更值钱。
 */

export const ANSWER_VERSION = 2;

const ORIGIN_TYPES = new Set([
  "影视",
  "游戏",
  "动漫",
  "主播",
  "社会事件",
  "广告",
  "方言",
  "梗图",
  "其他",
]);

const LIFECYCLE_STATUS = new Set(["rising", "stable", "fading", "dead", "unknown"]);

const RISK_LEVELS = new Set(["low", "medium", "high"]);

const CONFIDENCE = new Set(["high", "medium", "low"]);

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {unknown} value
 * @param {number} max
 */
function stringList(value, max = 4) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => text(item))
    .filter((item) => item !== null)
    .slice(0, max);
}

/**
 * @param {unknown} value
 */
function pairs(value, keyField, valueField, max = 3) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object" && text(item[keyField]) !== null)
    .map((item) => ({
      [keyField]: text(item[keyField]),
      [valueField]: text(item[valueField]),
    }))
    .slice(0, max);
}

/**
 * @param {any} raw
 */
export function normalizeOrigin(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = ORIGIN_TYPES.has(raw.type) ? raw.type : "其他";
  return {
    type,
    time: text(raw.time),
    carrier: text(raw.carrier),
    firstSeenBy: text(raw.first_seen_by),
    sources: stringList(raw.sources, 3),
    confidence: CONFIDENCE.has(raw.confidence) ? raw.confidence : "low",
  };
}

/**
 * @param {any} raw
 */
export function normalizeLifecycle(raw) {
  if (!raw || typeof raw !== "object") return null;
  const status = LIFECYCLE_STATUS.has(raw.status) ? raw.status : "unknown";
  return {
    status,
    peakYear: text(raw.peak_year),
    lastEvidence: text(raw.last_evidence),
    reasons: stringList(raw.reasons, 3),
  };
}

/**
 * 把模型的原始输出收拢成固定形状。
 * @param {any} raw
 */
export function normalizeAnswer(raw) {
  return {
    version: ANSWER_VERSION,
    summary: text(raw?.meaning) ?? "没读懂这张图",
    textOnImage: text(raw?.text_on_image) ?? "",
    memeName: text(raw?.meme_name),
    tone: text(raw?.tone),
    origin: normalizeOrigin(raw?.origin),
    lifecycle: normalizeLifecycle(raw?.lifecycle),
    drift: raw?.drift && typeof raw.drift === "object"
      ? {
        variants: stringList(raw.drift.variants, 4),
        meaningShift: text(raw.drift.meaning_shift),
      }
      : null,
    combo: raw?.combo && typeof raw.combo === "object"
      ? {
        worksWith: pairs(raw.combo.works_with, "meme", "effect", 3),
        avoidWith: pairs(raw.combo.avoid_with, "meme", "reason", 3),
      }
      : null,
    boundary: raw?.boundary && typeof raw.boundary === "object"
      ? {
        safe: stringList(raw.boundary.safe, 4),
        avoid: stringList(raw.boundary.avoid, 4),
        rule: text(raw.boundary.rule),
      }
      : null,
    risk: raw?.risk && typeof raw.risk === "object"
      ? {
        level: RISK_LEVELS.has(raw.risk.level) ? raw.risk.level : "low",
        reasons: stringList(raw.risk.reasons, 3),
      }
      : { level: "low", reasons: [] },
    reply: {
      meme: text(raw?.reply?.meme) ?? text(raw?.reply_suggestion),
      plain: text(raw?.reply?.plain),
      why: text(raw?.reply?.why),
    },
    usage: stringList(raw?.usage_examples, 4),
    confidence: CONFIDENCE.has(raw?.confidence) ? raw.confidence : "low",
    uncertainty: text(raw?.uncertainty),
  };
}

/**
 * 给 agent 的一句话用法提示。这是「玩梗界限」在输出层的体现：
 * 不确定就不玩，永远给一条不玩梗的退路。
 * @param {ReturnType<typeof normalizeAnswer>} answer
 */
export function boundaryAdvice(answer) {
  if (answer.risk.level === "high") return "这图有冒犯风险，别用，也别接梗。";
  if (answer.confidence === "low") return "没把握，建议不玩梗，直接说人话。";
  const rule = answer.boundary?.rule;
  return rule ?? "关系不熟或话题严肃时，用不玩梗的那一版。";
}
