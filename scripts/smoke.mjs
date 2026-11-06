/**
 * 冒烟测试：用一个假的 OpenAI 兼容服务，验证 BYOK 链路能端到端跑通。
 * 不需要真 key，不联网，不依赖 DSH 宿主。
 *
 *   node scripts/smoke.mjs
 */

import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemeStore } from "../src/store.js";
import { explainMeme } from "../src/pipeline.js";
import { normalizeConfig } from "../src/config.js";

const FAKE_ANSWER = {
  text_on_image: "我真的会谢",
  visual: "一只狗面无表情地看着镜头，画面发灰",
  meme_name: "我真的会谢",
  meaning: "表面道谢，实际是无奈的抱怨，常用于被无语到的时候",
  tone: "反讽",
  usage_examples: ["别人帮你帮倒忙时", "事情走向离谱时"],
  reply_suggestion: "哈哈哈又一个受害者",
  confidence: "high",
  uncertainty: null,
};

/** 一个最小的 OpenAI 兼容端点。 */
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const authorized = req.headers.authorization === "Bearer test-key";
    if (req.url !== "/v1/chat/completions" || !authorized) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const parsed = JSON.parse(body);
    const hasImage = JSON.stringify(parsed).includes("data:image/png;base64,");
    if (!hasImage) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no image" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(FAKE_ANSWER) } }],
      }),
    );
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const dir = await mkdtemp(join(tmpdir(), "memelens-smoke-"));
const imagePath = join(dir, "meme.png");
await writeFile(imagePath, Buffer.from("pretend-this-is-a-png", "utf8"));

const store = new MemeStore(join(dir, "index.jsonl"));
const vision = normalizeConfig({
  vision: {
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: "test-key",
    model: "mock-vl",
  },
}).vision;

let failed = false;
const check = (label, condition) => {
  console.log(`${condition ? "  ok " : "  FAIL"}  ${label}`);
  if (!condition) failed = true;
};

const first = await explainMeme({ imagePath, store, vision });
console.log("[1] 首次调用");
check("来源是 fresh", first.meta.source === "fresh");
check("梗名解析出来了", first.answer.memeName === "我真的会谢");
check("建议回复非空", typeof first.answer.reply === "string" && first.answer.reply.length > 0);
check(`置信度是 high（实际 ${first.answer.confidence}）`, first.answer.confidence === "high");

const second = await explainMeme({ imagePath, store, vision });
console.log("[2] 再问一次");
check("命中本地库，没再调模型", second.meta.source === "cache");
check("库内只有一条", store.size === 1);

console.log("[3] 没配 key 时");
const otherPath = join(dir, "other.png");
await writeFile(otherPath, Buffer.from("another", "utf8"));
const bare = await explainMeme({ imagePath: otherPath, store, vision: null });
const bare2 = await explainMeme({ imagePath: otherPath, store, vision: null });
check("给出可操作的提示而不是抛错", bare.answer.needsSetup === true);
check("未配置的结果不进缓存", bare2.meta.source === "unconfigured" && store.size === 1);

server.close();
if (failed) {
  console.error("冒烟失败");
  process.exit(1);
}
console.log("冒烟通过。");
