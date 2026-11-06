/**
 * OpenAI 兼容协议的视觉调用适配器。
 *
 * 为什么只做一个适配器：豆包、智谱、Qwen、Kimi、SiliconFlow、OpenAI、Gemini 的
 * OpenAI 兼容端点……全都吃同一套 /chat/completions + image_url 格式。
 * 让用户填 baseURL / apiKey / model 三个字段，比内置十家厂商的适配层更可靠，
 * 因为新厂商出来时用户自己就能接上，不用等我们发版。
 */

export class VisionProviderError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, retriable?: boolean }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = "VisionProviderError";
    this.status = options.status;
    this.retriable = options.retriable ?? false;
  }
}

const MIME_BY_EXT = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
]);

/**
 * @param {string} filePath
 */
export function guessMime(filePath) {
  const dot = filePath.lastIndexOf(".");
  const ext = dot === -1 ? "" : filePath.slice(dot).toLowerCase();
  return MIME_BY_EXT.get(ext) ?? "image/png";
}

/**
 * 模型偶尔会用 ```json 包裹，或者前后带一句废话。
 * 这里做最小限度的容错，不追求「修复一切」。
 * @param {string} raw
 */
export function extractJsonObject(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") throw new VisionProviderError("模型返回了空内容");

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced !== null ? fenced[1].trim() : text;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new VisionProviderError("模型没有返回 JSON 对象");
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    throw new VisionProviderError(`模型返回的 JSON 无法解析：${error.message}`);
  }
}

/**
 * @param {object} input
 * @param {import("../config.js").VisionConfig} input.config
 * @param {string} input.system
 * @param {string} input.userText
 * @param {{ base64: string, mime: string }} [input.image]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<any>}
 */
export async function chatJSON({ config, system, userText, image, signal }) {
  const base = config.baseURL.replace(/\/+$/, "");
  const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;

  /** @type {any[]} */
  const userContent = [{ type: "text", text: userText }];
  if (image !== undefined) {
    userContent.push({
      type: "image_url",
      image_url: { url: `data:${image.mime};base64,${image.base64}` },
    });
  }

  /** @type {Record<string, unknown>} */
  const body = {
    model: config.model,
    temperature: 0.2,
    max_tokens: 900,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
  };
  if (config.jsonMode) body.response_format = { type: "json_object" };

  const timeout = AbortSignal.timeout(config.timeoutMs);
  const merged = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: merged,
    });
  } catch (error) {
    const aborted = error?.name === "AbortError" || error?.name === "TimeoutError";
    throw new VisionProviderError(
      aborted
        ? `视觉模型调用超时（${config.timeoutMs}ms）`
        : `连不上视觉模型端点 ${url}：${error?.message ?? error}`,
      { retriable: true },
    );
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      // 读不到错误体就算了
    }
    const retriable = response.status === 429 || response.status >= 500;
    throw new VisionProviderError(
      `视觉模型返回 ${response.status}${detail === "" ? "" : `：${detail}`}`,
      { status: response.status, retriable },
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new VisionProviderError(`视觉模型返回的不是 JSON：${error.message}`, { retriable: true });
  }

  const content = payload?.choices?.[0]?.message?.content;
  const text = Array.isArray(content)
    ? content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("")
    : content;

  return extractJsonObject(typeof text === "string" ? text : "");
}
