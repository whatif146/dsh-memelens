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
import { boundaryAdvice } from "./answer.js";

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

const LIFECYCLE_LABELS = {
  rising: "正在火",
  stable: "还在用",
  fading: "在退潮",
  dead: "基本没人用了",
  unknown: "不确定",
};

/**
 * 给人看的一眼摘要。细节留在结构化返回值里，由 agent 自己组织语言。
 * 这里写太长会和 agent 的回复重复。
 */
function renderAnswer(result) {
  const { answer, meta } = result;

  if (answer.needsSetup === true) return answer.summary;

  const label = CONFIDENCE_LABELS[answer.confidence] ?? answer.confidence;
  const first = [`表情包：${answer.summary}`];
  if (answer.tone) first.push(`语气：${answer.tone}`);

  const second = [];
  const status = answer.lifecycle?.status;
  if (status && status !== "unknown") {
    second.push(`现在还能用吗：${LIFECYCLE_LABELS[status] ?? status}`);
  }
  second.push(`置信度：${label}${meta.source === "memory" ? "（凭记忆，没花钱）" : ""}`);

  const lines = [first.join(" ｜ "), second.join(" ｜ ")];

  const memeLine = answer.reply?.meme;
  const plainLine = answer.reply?.plain;
  if (memeLine || plainLine) {
    const both = [];
    if (memeLine) both.push(`玩梗：${memeLine}`);
    if (plainLine) both.push(`不玩梗：${plainLine}`);
    lines.push(both.join("　／　"));
  }
  if (answer.risk?.level === "high" || answer.confidence === "low") {
    lines.push(`分寸：${boundaryAdvice(answer)}`);
  }

  return lines.join("\n");
}

/**
 * @param {any} ctx
 * @param {any} rawConfig
 */
async function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const { defineTool } = await resolveHostPackage("@deepseek-ai/dsh-tools");
  const store = new MemeStore(join(dataDir(), "index.jsonl"), {
    halfLifeDays: config.memory.halfLifeDays,
  });

  // 启动时顺手做一次遗忘：又旧又弱的记忆直接删掉。
  // 「学会忘记」不是隐喻，是每次启动都真的执行的一步。
  void store.prune().catch(() => {});

  ctx.tools.register(
    defineTool({
      name: "meme_explain",
      description:
        "当用户在对话里贴了表情包、而你看不懂它想表达什么时调用。"
        + "返回：图意、语气、来源与去处（这个梗从哪来、现在还能不能用）、"
        + "可搭配/不可混用的梗、玩梗与不玩梗两版回复、冒犯风险、置信度。"
        + "使用约定：confidence 为 low 或带 uncertainty 时必须如实转述，不要圆场；"
        + "risk.level 为 high 时不要顺着玩这个梗；返回 needsSetup 时提示用户去配置视觉模型。",
      parameters: {
        image: "string，本地图片路径或 http(s) 地址；用户刚贴的图直接传其本地附件路径",
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
