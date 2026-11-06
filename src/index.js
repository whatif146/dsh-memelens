/**
 * dsh-memelens 宿主端入口。
 *
 * 只做三件事：解析宿主依赖、注册一个工具、把结果渲染成人能看的文本。
 * 业务逻辑留在 pipeline.js / providers/，方便脱离宿主单独测试。
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { MemeStore } from "./store.js";
import { explainMeme } from "./pipeline.js";
import { normalizeConfig } from "./config.js";

const require_ = createRequire(import.meta.url);

export const name = "dsh-memelens";
export const inject = ["tools"];

/**
 * 插件被 link: 安装时看不到 $DSH_HOME/profiles 下的扁平依赖闭包，
 * 所以宿主包要在 profile 目录里再解析一次。
 */
function profileRoots() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return [join(home, "profiles"), join(home, "profiles", "desktop", "node_modules")];
}

async function resolveHostPackage(specifier) {
  try {
    return await import(specifier);
  } catch {
    // 落到 profile 闭包里再试一次
  }
  for (const dir of profileRoots()) {
    try {
      const resolved = require_.resolve(specifier, { paths: [dir] });
      return await import(pathToFileURL(resolved).href);
    } catch {
      // 继续试下一个候选目录
    }
  }
  throw new Error(
    `dsh-memelens: 无法解析宿主依赖 ${specifier}。请确认它已安装在当前 DSH profile 中。`,
  );
}

function dataDir() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "memelens");
}

const CONFIDENCE_LABELS = {
  high: "较高",
  medium: "中等",
  low: "较低",
  unknown: "未知",
};

function renderAnswer(result) {
  const { answer, meta } = result;
  const lines = [];

  if (answer.needsSetup === true) {
    lines.push(answer.summary);
    return lines.join("\n");
  }

  const badge = meta.source === "cache" ? "（本地库命中，没花钱）" : "";
  lines.push(`${answer.summary}${badge}`);

  if (answer.textOnImage) lines.push(`图上的字：「${answer.textOnImage}」`);
  if (answer.memeName) lines.push(`梗名：${answer.memeName}`);
  if (answer.tone) lines.push(`语气：${answer.tone}`);
  if (Array.isArray(answer.usage) && answer.usage.length > 0) {
    lines.push("别人一般这么用：");
    for (const item of answer.usage) lines.push(`  · ${item}`);
  }
  if (answer.reply) lines.push(`可以这样回：${answer.reply}`);

  lines.push(`置信度：${CONFIDENCE_LABELS[answer.confidence] ?? answer.confidence}`);
  if (answer.uncertainty) lines.push(`不确定的地方：${answer.uncertainty}`);
  if (meta.stale) lines.push("注意：这条结论是半年前的，梗可能已经变味。");

  return lines.join("\n");
}

/**
 * @param {any} ctx
 * @param {any} rawConfig
 */
async function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const { defineTool } = await resolveHostPackage("@deepseek-ai/dsh-tools");
  const store = new MemeStore(join(dataDir(), "index.jsonl"));

  ctx.tools.register(
    defineTool({
      name: "meme_explain",
      description:
        "解释一张中文网络表情包：它是什么意思、什么语气、对方大概想表达什么、可以怎么回。"
        + "适用于看不懂聊天或评论区里的表情包时。输入是本地图片绝对路径或 http(s) 图片地址。",
      parameters: {
        image: "string，本地图片绝对路径或 http(s) 地址",
        replyContext: "可选，对方发这张图时的上下文原话，能显著提升语气判断",
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => [{ type: "text", text: renderAnswer(value) }],
      },
      async execute(args) {
        const { image, replyContext } = args ?? {};
        if (typeof image !== "string" || image.trim() === "") {
          throw new Error("dsh-memelens: 需要一个图片路径或地址");
        }
        return explainMeme({
          imagePath: image.trim(),
          replyContext: typeof replyContext === "string" ? replyContext : undefined,
          store,
          vision: config.vision,
        });
      },
    }),
  );
}

export { apply };
export default apply;
