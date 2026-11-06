/**
 * 解释流水线（v2）。
 *
 * 顺序就是花钱的顺序：先查记忆（0 成本），再调视觉模型（按次计费）。
 *
 * 记忆在这里承担的不是「缓存」，是「经验」：
 *   - 能想起来 → 直接复用，并且这次想起会让它记得更牢（间隔效应）
 *   - 想不起来 → 重新查一遍，查完重新记住
 *   - 太老了 → 不删，只是降级成「需要重新确认」
 */

import { readFile } from "node:fs/promises";
import { sha256Fingerprint } from "./store.js";
import { chatJSON, guessMime, VisionProviderError } from "./providers/openai-compat.js";
import { ANALYSIS_SYSTEM_PROMPT, buildAnalysisMessages } from "./prompts.js";
import { normalizeAnswer, ANSWER_VERSION } from "./answer.js";

export { ANSWER_VERSION };

/**
 * @param {string} imagePath
 */
export async function readImage(imagePath) {
  const bytes = await readFile(imagePath);
  if (bytes.byteLength === 0) throw new Error(`dsh-memelens: 空文件 ${imagePath}`);
  return { bytes, fingerprint: sha256Fingerprint(bytes), mime: guessMime(imagePath) };
}

/**
 * 没配 key 时的返回。不抛错、不进缓存、给出可操作提示。
 * @param {string} fingerprint
 */
export function unconfiguredAnswer(fingerprint) {
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
      lifecycle: null,
      drift: null,
      combo: null,
      boundary: null,
      risk: { level: "low", reasons: [] },
      reply: { meme: null, plain: null, why: null },
      usage: [],
      uncertainty: null,
    },
    meta: { source: "unconfigured", fingerprint, memoryStage: null, stale: false },
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
 * @param {number} [input.now]
 */
export async function explainMeme({
  imagePath,
  replyContext,
  store,
  vision,
  onProgress,
  signal,
  now = Date.now(),
}) {
  const image = await readImage(imagePath);
  onProgress?.("fingerprint", { fingerprint: image.fingerprint });

  // —— 第一档：想得起来吗
  const recalled = await store.recall(image.fingerprint, now);
  if (recalled.record !== null && recalled.recallable) {
    await store.reinforce(recalled.record.id, now);
    await store.noteLookup(recalled.record.id, now);
    onProgress?.("recall", { id: recalled.record.id, stage: recalled.memory.stage });
    return {
      answer: recalled.record.card,
      meta: {
        source: "memory",
        fingerprint: image.fingerprint,
        memeId: recalled.record.id,
        memoryStage: recalled.memory.stage,
        memoryStrength: Number(recalled.memory.strength.toFixed(2)),
        ageDays: Math.round(recalled.memory.ageDays),
        stale: recalled.memory.stage === "fading",
      },
    };
  }

  if (vision === null) return unconfiguredAnswer(image.fingerprint);

  if (image.bytes.byteLength > vision.maxImageBytes) {
    throw new Error(
      `dsh-memelens: 图片 ${Math.round(image.bytes.byteLength / 1024)}KB 超过上限 `
      + `${Math.round(vision.maxImageBytes / 1024)}KB。表情包通常很小，`
      + `如果这是整张聊天截图，请先裁到表情包本体。`,
    );
  }

  // 本地共现经验：这个梗以前常跟谁一起出现（不是提示词编的，是真的被问过）
  const localCombos = recalled.record === null
    ? []
    : (await store.combosFor(recalled.record.id)).map((item) => ({ name: item.name, count: item.count }));

  const messages = buildAnalysisMessages({ replyContext, localCombos });

  let raw;
  try {
    raw = await chatJSON({
      config: vision,
      system: ANALYSIS_SYSTEM_PROMPT,
      userText: messages[1].content,
      image: { base64: image.bytes.toString("base64"), mime: image.mime },
      signal,
    });
    onProgress?.("vision", { model: vision.model, combos: localCombos.length });
  } catch (error) {
    if (error instanceof VisionProviderError) {
      return {
        answer: {
          ...unconfiguredAnswer(image.fingerprint).answer,
          needsSetup: false,
          summary: error.retriable
            ? "视觉模型暂时不可用，这张图先没解读出来。稍后重试通常就好了。"
            : "视觉模型调用失败，请检查 baseURL / model / 额度是否配置正确。",
          uncertainty: error.message,
        },
        meta: { source: "provider-error", fingerprint: image.fingerprint, memoryStage: null, stale: false },
      };
    }
    throw error;
  }

  const answer = normalizeAnswer(raw);
  const saved = await store.remember({
    fingerprint: image.fingerprint,
    name: answer.memeName,
    card: answer,
    now,
  });
  await store.noteLookup(saved.id, now);

  return {
    answer,
    meta: {
      source: recalled.record === null ? "fresh" : "refreshed",
      fingerprint: image.fingerprint,
      memeId: saved.id,
      memoryStage: "fresh",
      stale: false,
    },
  };
}
