/**
 * 配置归一化。
 *
 * 公共插件的第一原则：**别人的 key 永远不在代码里，也不在日志里。**
 * 因此配置层做三件事：
 *   1. 支持 ${env:VAR} 插值，key 可以只放环境变量，配置文件里留空；
 *   2. 所有字段给默认值，缺 key 不是崩溃而是「该能力关闭」；
 *   3. 对外暴露脱敏后的视图，便于诊断时不泄露凭据。
 */

export const DEFAULT_TIMEOUT_MS = 45_000;
export const DEFAULT_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * @param {unknown} value
 * @returns {string}
 */
export function resolveSecret(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  const envMatch = /^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(text);
  if (envMatch !== null) return process.env[envMatch[1]] ?? "";
  return text;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * @typedef {object} VisionConfig
 * @property {string} baseURL    OpenAI 兼容的 /v1 地址
 * @property {string} apiKey
 * @property {string} model
 * @property {number} timeoutMs
 * @property {number} maxImageBytes
 * @property {boolean} jsonMode  服务端是否支持 response_format: json_object
 */

/**
 * 大多数国内厂商（豆包、智谱、Qwen、Kimi、SiliconFlow…）都提供
 * OpenAI 兼容的 /chat/completions，因此一个适配器就能覆盖绝大部分。
 * @param {any} raw
 * @returns {{ vision: VisionConfig | null, memory: { halfLifeDays: number } }}
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const vision = source.vision && typeof source.vision === "object" ? source.vision : {};
  const memory = source.memory && typeof source.memory === "object" ? source.memory : {};

  const halfLifeDays = positiveNumber(memory.halfLifeDays) ?? 30;

  const baseURL = typeof vision.baseURL === "string" ? vision.baseURL.trim() : "";
  const apiKey = resolveSecret(vision.apiKey);
  const model = typeof vision.model === "string" ? vision.model.trim() : "";

  const memoryConfig = { halfLifeDays };

  if (baseURL === "" || apiKey === "" || model === "") {
    // 三缺一就等于没配。返回 null 表示「该能力关闭」，而不是抛错。
    return { vision: null, memory: memoryConfig };
  }

  return {
    memory: memoryConfig,
    vision: {
      baseURL,
      apiKey,
      model,
      timeoutMs: positiveNumber(vision.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
      maxImageBytes: positiveNumber(vision.maxImageBytes) ?? DEFAULT_MAX_IMAGE_BYTES,
      jsonMode: vision.jsonMode !== false,
    },
  };
}

/**
 * 给日志/诊断用的脱敏视图。
 * @param {{ vision: VisionConfig | null }} config
 */
export function describeConfig(config) {
  if (config.vision === null) return { vision: "未配置" };
  const { apiKey, ...rest } = config.vision;
  return {
    vision: { ...rest, apiKey: apiKey.length > 8 ? `***${apiKey.slice(-4)}` : "***" },
  };
}
