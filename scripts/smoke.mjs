/**
 * 冒烟测试 v2：用假的 OpenAI 兼容服务验证「记忆 / 组合 / 界限」三条链路。
 * 不需要真 key，不联网，不依赖 DSH 宿主。
 *
 *   node scripts/smoke.mjs
 */

import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemeStore, memeIdFrom, sha256Fingerprint } from "../src/store.js";
import { explainMeme } from "../src/pipeline.js";
import { normalizeConfig } from "../src/config.js";
import { describe as describeMemory } from "../src/memory.js";

const names = ["我真的会谢", "绷不住了", "这很难评"];
let callCount = 0;

function fakeAnswer(name) {
  return {
    text_on_image: name,
    visual: "一只狗面无表情地看着镜头",
    meme_name: name,
    meaning: "表面平静，实际是无奈的抱怨",
    tone: "反讽",
    origin: {
      type: "社会事件",
      time: "2021 年",
      carrier: "微博",
      first_seen_by: "某博主",
      sources: ["媒体稿"],
      confidence: "medium",
    },
    lifecycle: {
      status: "fading",
      peak_year: "2022",
      last_evidence: "近两年新稿很少",
      reasons: ["解释页集中在 2021-2022"],
    },
    drift: { variants: ["我真的会谢"], meaning_shift: null },
    combo: {
      works_with: [{ meme: "绷不住了", effect: "加重无语" }],
      avoid_with: [{ meme: "破防了", reason: "两种情绪互相抵消" }],
    },
    boundary: {
      safe: ["同龄朋友之间"],
      avoid: ["工作群", "长辈"],
      rule: "只在熟人之间用",
    },
    risk: { level: "low", reasons: [] },
    reply: {
      meme: "哈哈哈又一个受害者",
      plain: "这事确实挺让人无语的",
      why: "熟人可玩梗，同事别",
    },
    usage_examples: ["被无语到时"],
    confidence: "high",
    uncertainty: null,
  };
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.url !== "/v1/chat/completions" || req.headers.authorization !== "Bearer test-key") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (!JSON.parse(body).messages?.[1]?.content?.[1]) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no image" }));
      return;
    }
    const name = names[callCount % names.length];
    callCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fakeAnswer(name)) } }] }));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const dir = await mkdtemp(join(tmpdir(), "memelens-smoke-"));
const vision = normalizeConfig({
  vision: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "test-key", model: "mock-vl" },
}).vision;

const store = new MemeStore(join(dir, "index.jsonl"));
let failed = false;
const check = (label, condition) => {
  console.log(`${condition ? "  ok " : "  FAIL"}  ${label}`);
  if (!condition) failed = true;
};

async function image(name, content) {
  const path = join(dir, name);
  await writeFile(path, Buffer.from(content, "utf8"));
  return { path, fingerprint: sha256Fingerprint(Buffer.from(content, "utf8")) };
}

const img1 = await image("a.png", "meme-a");

console.log("[1] 第一次见");
const first = await explainMeme({ imagePath: img1.path, store, vision });
check("来源是 fresh", first.meta.source === "fresh");
check("梗名解析出来", first.answer.memeName === "我真的会谢");
check("来源（origin）是一等字段", first.answer.origin?.type === "社会事件");
check("去处（lifecycle）是一等字段", first.answer.lifecycle?.status === "fading");
check("玩梗与不玩梗各给一版", Boolean(first.answer.reply.meme && first.answer.reply.plain));
check("组合有「不可混用」", first.answer.combo?.avoidWith.length === 1);
check("界限有「别用的场合」", first.answer.boundary?.avoid.length >= 1);

console.log("[2] 第二次见同一张图");
const second = await explainMeme({ imagePath: img1.path, store, vision });
check("凭记忆返回，没调模型", second.meta.source === "memory");
check(`模型只被调用了 1 次（实际 ${callCount}）`, callCount === 1);
check("记忆阶段是 fresh", second.meta.memoryStage === "fresh");
const reinforced = store.snapshot()[0];
check(`回忆加深了记忆（reinforcements=${reinforced.reinforcements}）`, reinforced.reinforcements >= 2);

console.log("[3] 紧接着问另一个梗（学组合）");
const img2 = await image("b.png", "meme-b");
await explainMeme({ imagePath: img2.path, store, vision });
const idA = memeIdFrom("我真的会谢", img1.fingerprint);
const idB = memeIdFrom("绷不住了", img2.fingerprint);
const combosB = await store.combosFor(idB);
check("两个梗被记成了「一起出现过」", combosB.some((item) => item.id === idA));

console.log("[4] 两百天后再见（该忘的忘了）");
const img3 = await image("c.png", "meme-c");
const longAgo = Date.now() - 200 * 86_400_000;
await store.remember({
  fingerprint: img3.fingerprint,
  name: "这很难评",
  card: first.answer,
  now: longAgo,
});
const old10 = store.snapshot().find((record) => record.name === "这很难评");
check(`两百天后强度降到 ${describeMemory(old10).strength.toFixed(2)}`, describeMemory(old10).stage === "expired");
const refreshed = await explainMeme({ imagePath: img3.path, store, vision });
check("过期不直接复用，而是重新查一遍", refreshed.meta.source === "refreshed");

console.log("[5] 又旧又弱的记忆被真正删掉");
const img4 = await image("d.png", "meme-d");
const ancient = Date.now() - 800 * 86_400_000;
await store.remember({
  fingerprint: img4.fingerprint,
  name: "上古梗",
  card: first.answer,
  now: ancient,
});
const pruned = await store.prune(Date.now());
check("prune 删掉了它", pruned.forgotten.some((id) => id.includes("上古梗")));

console.log("[6] 没配 key");
const img5 = await image("e.png", "meme-e");
const bare = await explainMeme({ imagePath: img5.path, store, vision: null });
check("给出可操作提示而不是抛错", bare.answer.needsSetup === true);
check("未配置的结果不进记忆", (await store.findByFingerprint(img5.fingerprint)) === undefined);

server.close();
if (failed) {
  console.error("冒烟失败");
  process.exit(1);
}
console.log("冒烟通过。");
