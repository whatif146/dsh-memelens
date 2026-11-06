/**
 * 像人一样记忆，也像人一样遗忘。
 *
 * 三条来自人类记忆的规则，都被显式建模：
 *
 * 1. **间隔效应**：同一个梗被回忆的次数越多，它衰减得越慢。
 *    第一次见 30 天就淡了；见过五次，能撑小半年。
 * 2. **遗忘是渐进的**，不是开关。所以强度是连续的，不是「有/无」。
 * 3. **想不起来就重新问一次**：低于阈值不直接复用，而是重新查一遍——
 *    查完强度会回来，这恰好也是人类复述一遍就记牢的机制。
 *
 * 一个反直觉但重要的推论：**忘掉是功能，不是缺陷。**
 * 一个 2021 年的梗在你脑子里保持满格强度，只会让你在 2026 年说错话。
 */

export const DAY_MS = 86_400_000;

/** 首次见到的强度是 1 时的半衰期。 */
export const DEFAULT_HALF_LIFE_DAYS = 30;

/** 强度上限，防止高频梗无限膨胀到永不过期。 */
export const MAX_STRENGTH = 5;

/** 低于这个强度：记忆过期，应该重新查，但记录不删。 */
export const RECALL_THRESHOLD = 0.2;

/** 低于这个强度且足够老：真的删掉。 */
export const FORGET_THRESHOLD = 0.02;

export const FORGET_AFTER_DAYS = 365;

/**
 * @param {object} record
 * @param {{ now?: number, halfLifeDays?: number }} [options]
 * @returns {number}
 */
export function strength(record, options = {}) {
  const now = options.now ?? Date.now();
  const halfLifeDays = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;

  const reinforcements = Math.max(1, Number(record?.reinforcements) || 1);
  const lastSeen = Date.parse(record?.lastSeen ?? record?.firstSeen ?? "");
  if (!Number.isFinite(lastSeen)) return 0;

  const age = Math.max(0, (now - lastSeen) / DAY_MS);

  // 间隔效应：见过 n 次，半衰期按 ln(1+n) 变长。
  // n=1 → 1.0x，n=5 → 2.8x，n=20 → 4.0x，再往上收益递减。
  const halfLife = halfLifeDays * (1 + Math.log(reinforcements));

  const decayed = Math.pow(0.5, age / halfLife);
  return Math.min(MAX_STRENGTH, reinforcements * decayed);
}

/**
 * @param {object} record
 * @param {{ now?: number, halfLifeDays?: number }} [options]
 */
export function describe(record, options = {}) {
  const now = options.now ?? Date.now();
  const s = strength(record, options);
  const lastSeen = Date.parse(record?.lastSeen ?? record?.firstSeen ?? "");
  const ageDays = Number.isFinite(lastSeen) ? Math.max(0, (now - lastSeen) / DAY_MS) : Infinity;

  /** @type {"fresh" | "fading" | "expired"} */
  let stage;
  if (s >= 0.6) stage = "fresh";
  else if (s >= RECALL_THRESHOLD) stage = "fading";
  else stage = "expired";

  return { strength: s, stage, ageDays };
}

/**
 * 能不能直接复用这条记忆。
 * @param {object} record
 * @param {object} [options]
 */
export function isRecallable(record, options = {}) {
  return describe(record, options).stage !== "expired";
}

/**
 * 该不该从库里真正删掉。
 * @param {object} record
 * @param {object} [options]
 */
export function shouldForget(record, options = {}) {
  const { strength: s, ageDays } = describe(record, options);
  return s < FORGET_THRESHOLD && ageDays > FORGET_AFTER_DAYS;
}

/**
 * 回忆一次之后的新强度（用于展示与调试，真正写库看 store）。
 * @param {object} record
 * @param {object} [options]
 */
export function reinforced(record, options = {}) {
  const before = strength(record, options);
  const reinforcements = Math.max(1, Number(record?.reinforcements) || 1) + 1;
  const now = options.now ?? Date.now();
  const after = strength({ ...record, reinforcements, lastSeen: new Date(now).toISOString() }, options);
  return { before, after, reinforcements };
}
