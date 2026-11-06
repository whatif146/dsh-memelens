/**
 * 解释流水线。
 *
 * 花钱顺序：先查本地库（0 成本），再调视觉模型（按次计费），
 * 检索（将来）排最后，因为它最贵也最不稳定。
 *
 * 插件里没有「失败」这个终态：没配 key 要给出可操作的提示，
 * 模型挂了要保留已拿到的证据，任何一环出问题都不能让宿主崩掉。
 */

import { readFile } from "node:fs/promises";
import { sha256Fingerprint } from "./store.js";
import { chatJSON, guessMime, VisionProviderError } from "./providers/openai-compat.js";
import { ANALYSIS_SYSTEM_PROMPT, buildAnalysisMessages } from "./prompts.js";

export const ANSWER_VERSION = 1;

/** 结论的保鲜期：梗会过气，过期后仍然展示，但要提醒。 */
export const STALE_AFTER_MS = 1000 * 60 * 60 * 24 * 180;

const ALLOWED_CONFIDENCE = new Set(["high", "medium", "low"]);

export class PipelineNotWiredError extends Error {
  /** @param {string} stage */
  constructor(stage) {
    super(`dsh-memelens: 流水线环节「${stage}」尚未接入`);
    this.name = "PipelineNotWiredError";
    this.stage = stage;
  }
}

/**
 * @param {string} imagePath
 */
export async function readImage(imagePath) {
  const bytes = await readFile(imagePath);
  if (bytes.byteLength === 0) throw new Error(`dsh-memelens: 空文件 ${imagePath}`);
  return { bytes, fingerprint: sha256Fingerprint(bytes), mime: guessMime(imagePath) };
}

/**
 * 把模型的原始输出收拢成固定形状，防住字段缺失和类型漂移。
 * @param {any} raw
 */
export function normalizeAnalysis(raw) {
  const pick = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
  const list = Array.isArray(raw?.usage_examples)
    ? raw.usage_examples.filter((item) => typeof item === "string" && item.trim() !== "").slice(0, 4)
    : [];

  const confidence = ALLOWED_CONFIDENCE.has(raw?.confidence) ? raw.confidence : "low";

  return {
    version: ANSWER_VERSION,
    textOnImage: pick(raw?.text_on_image) ?? "",
    visual: pick(raw?.visual),
    memeName: pick(raw?.meme_name),
    summary: pick(raw?.meaning) ?? "没读懂这张图",
    tone: pick(raw?.tone),
    origin: null,
    usage: list,
    reply: pick(raw?.reply_suggestion),
    confidence,
    uncertainty: pick(raw?.uncertainty),
  };
}

/**
 * @param {object} input
 * @param {string} input.imagePath
 * @param {string} [input.replyContext]
 * @param {import("./store.js").MemeStore} input.store
 * @param {import("./config.js").VisionConfig | null} input.vision
 * @param {(stage: string, detail: unknown) => void} [input.onProgress]
 * @param {AbortSignal} [input.signal]
 */
export async function explainMeme({ imagePath, replyContext, store, vision, onProgress, signal }) {
  const image = await readImage(imagePath);
  onProgress?.("fingerprint", { fingerprint: image.fingerprint });

  const cached = await store.find(image.fingerprint);
  if (cached?.answer) {
    const seenAt = Date.parse(cached.lastSeen ?? cached.firstSeen ?? "");
    return {
      answer: cached.answer,
      meta: {
        source: "cache",
        fingerprint: image.fingerprint,
        stale: Number.isFinite(seenAt) ? Date.now() - seenAt > STALE_AFTER_MS : false,
      },
    };
  }

  if (vision === null) {
    return {
      answer: {
        version: ANSWER_VERSION,
        confidence: "unknown",
        needsSetup: true,
        summary:
          "还没配置视觉模型，认不出这张图。在插件配置里填上 vision.baseURL / vision.apiKey / vision.model 就能用了。",
        textOnImage: "",
        visual: null,
        memeName: null,
        origin: null,
        usage: [],
        reply: null,
        uncertainty: null,
      },
      meta: { source: "unconfigured", fingerprint: image.fingerprint, stale: false },
    };
  }

  if (image.bytes.byteLength > vision.maxImageBytes) {
    throw new Error(
      `dsh-memelens: 图片 ${Math.round(image.bytes.byteLength / 1024)}KB 超过上限 `
      + `${Math.round(vision.maxImageBytes / 1024)}KB。表情包通常很小，` 
      + `如果这是整张聊天截图，请先裁到表情包本体。`,
    );
  }

  const messages = buildAnalysisMessages({ replyContext });
  let raw;
  try {
    raw = await chatJSON({
      config: vision,
      system: ANALYSIS_SYSTEM_PROMPT,
      userText: messages[1].content,
      image: { base64: image.bytes.toString("base64"), mime: image.mime },
      signal,
    });
    onProgress?.("vision", { model: vision.model });
  } catch (error) {
    if (error instanceof VisionProviderError) {
      return {
        answer: {
          version: ANSWER_VERSION,
          confidence: "unknown",
          summary: error.retriable
            ? "视觉模型暂时不可用，这张图先没解读出来。稍后重试通常就好了。"
            : "视觉模型调用失败，请检查 baseURL / model / 额度是否配置正确。",
          textOnImage: "",
          visual: null,
          memeName: null,
          origin: null,
          usage: [],
          reply: null,
          uncertainty: error.message,
        },
        meta: { source: "provider-error", fingerprint: image.fingerprint, stale: false },
      };
    }
    throw error;
  }

  const answer = normalizeAnalysis(raw);
  const now = new Date().toISOString();
  await store.upsert({
    fingerprint: image.fingerprint,
    answer,
    firstSeen: now,
    lastSeen: now,
  });

  return { answer, meta: { source: "fresh", fingerprint: image.fingerprint, stale: false } };
}
