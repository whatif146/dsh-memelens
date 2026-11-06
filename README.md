# dsh-memelens

> 给梗装个镜头。Explain Chinese internet memes in context — what it means, and how to reply.

一个 [DeepSeek Harness](https://deepseekdocs.com/) 插件。丢一张看不懂的表情包进去，它告诉你：**这图什么意思、什么语气、对方大概想表达什么、可以怎么回。**

**自带 key（BYOK）**：插件本身不含任何模型和密钥，你填自己的视觉模型，图只发到你选的那家厂商。

## 为什么做这个

DSH 的表情包生态里几乎全是「发图」的插件（`dsh-meme`、`dsh-stickers`、`dsh-emoji`），视觉插件做的是「读图转文字」。
**没有一个解决「这个梗什么意思 + 我该怎么接」**——而这恰恰是不懂网络梗的人真正卡住的地方。

## 设计

```
图片 → 指纹查本地库 ──命中──→ 直接返回（0 成本，秒回）
              │
              └─未命中→ 视觉模型（你的 key）→ 结论 → 写回本地库
                                      │
                                      └─（将来）以字搜梗，补充出处与用法
```

三个刻意的取舍：

1. **只做 OpenAI 兼容适配器。** 豆包、智谱、Qwen、Kimi、SiliconFlow、OpenAI、Gemini 的兼容端点全都吃同一套 `/chat/completions`。让用户填 `baseURL / apiKey / model` 三个字段，比内置十家厂商更可靠——新厂商出现时用户自己就能接上。
2. **本地库优先。** 同一个梗第二次遇到是零成本，图也不会二次上传。
3. **允许说「不知道」。** 置信度低就直说。认错一个梗比认不出更伤信任。

## 配置

在 profile 里给插件加 config：

```yaml
- id: dsh-memelens
  name: dsh-memelens
  config:
    vision:
      baseURL: https://ark.cn-beijing.volces.com/api/v3   # 或任何 OpenAI 兼容端点
      apiKey: ${env:ARK_API_KEY}                          # 建议走环境变量，别写死在配置里
      model: doubao-1.5-vision-pro
      timeoutMs: 45000        # 可选，默认 45s
      maxImageBytes: 4194304  # 可选，默认 4MB
      jsonMode: true          # 可选，服务端不支持 response_format 就设 false
```

`apiKey` 支持 `${env:VAR}` 插值。三个必填项有任何一项为空，插件会**关闭**而不是抛错，并在调用时提示你去配。

没配 key 时的返回长这样：

```
还没配置视觉模型，认不出这张图。在插件配置里填上 vision.baseURL / vision.apiKey / vision.model 就能用了。
```

## 隐私

- 图只发往你自己配置的端点，本插件不经过任何第三方中转。
- 同一张图（字节完全一致）第二次调用走本地库，不再外发。
- **别整张聊天截图丢进来**：截图里有群名、头像、别人的话。先裁到表情包本体。插件对超过 `maxImageBytes` 的图会直接拒绝并提示裁剪。

## 当前状态

| 环节 | 状态 | 说明 |
| --- | --- | --- |
| 本地梗库（JSONL 指纹索引） | ✅ | `src/store.js` |
| 流水线编排与降级 | ✅ | `src/pipeline.js`，任一环失败不整体崩 |
| 视觉模型调用（OpenAI 兼容） | ✅ | `src/providers/openai-compat.js` |
| 配置 / 脱敏 / env 插值 | ✅ | `src/config.js` |
| 宿主工具注册 `meme_explain` | ✅ | `src/index.js` |
| 感知哈希（抗压缩、水印） | ⏳ | 当前指纹是 sha256，转发压缩后同一张图会失配 |
| 以字搜梗（检索） | ⏳ | 调研中，见 `research/retrieval/` |
| 离线 OCR 兜底 | ⏳ | 没 key 也想认字，见 `research/ocr/` |
| 结论合成 / 出处归因 | ⏳ | 当前只靠模型自身知识 |

冒烟测试不联网、不需要真 key，用一个假的 OpenAI 兼容端点验证整条链路：

```sh
node scripts/smoke.mjs
```

## 安装（本地开发）

```sh
dsh plugin --profile desktop add "link:<本仓库绝对路径>"
```

重启 `dsh --profile desktop` 后，对话里就能调用 `meme_explain`。

## 数据

本地库在 `$DSH_HOME/memelens/index.jsonl`，一行一条：

```json
{"fingerprint":"sha256:...","answer":{"version":1,"confidence":"high","summary":"...","memeName":"...","tone":"反讽","usage":["..."],"reply":"..."},"firstSeen":"2026-11-06T10:00:00.000Z","lastSeen":"2026-11-06T10:00:00.000Z"}
```

将来 `data/` 会放**可提交的公开梗库**（本地库导出、经人工确认的条目）。梗会过气，所以每条都带时间戳，读取时按时间衰减。

## 路线图

- [ ] 以字搜梗：query 构造 → 渠道 → 解析 → 证据打分
- [ ] 把检索到的出处并入结论，标注「模型自述」还是「检索证据」
- [ ] pHash 替换 sha256 指纹
- [ ] 离线 OCR 兜底（没 key 也能认字）
- [ ] `data/` 公开梗库 + 贡献流程
- [ ] 「每日一梗」养成模式（同一个库的另一种出口）
- [ ] 设置面板（需要写 client 半边）

## 许可

MIT
