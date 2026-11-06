/**
 * 本地梗库 v2。
 *
 * 两层结构（v1 只有一层，同一个梗换个配图就重复花钱）：
 *   fingerprint  →  memeId   （一张图对应哪个梗）
 *   memeId       →  card     （这个梗的完整结论）
 *
 * 每次「想起来」都会 reinforce，强度按 memory.js 的模型衰减。
 * 忘掉不是删除记录，而是让它降级到「需要重新查」——
 * 真的删掉只发生在又旧又弱的时候。
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { describe, isRecallable, reinforced, shouldForget } from "./memory.js";

export const RECORD_VERSION = 2;

/** 两个梗在这么久之内被先后问到，算「一起出现过」。 */
export const COOCCURRENCE_WINDOW_MS = 5 * 60 * 1000;

/**
 * @param {Buffer} buffer
 */
export function sha256Fingerprint(buffer) {
  return "sha256:" + createHash("sha256").update(buffer).digest("hex");
}

/**
 * 梗名当 id。名字不稳定时退回指纹，保证同一个梗至少有稳定主键。
 * @param {string | null} nameValue
 * @param {string} fingerprint
 */
export function memeIdFrom(nameValue, fingerprint) {
  const base = String(nameValue ?? "").trim().toLowerCase();
  if (base === "") return fingerprint;
  const slug = base.replace(/[\s\p{P}\p{S}]+/gu, "-").replace(/^-+|-+$/g, "");
  return slug === "" ? fingerprint : `meme:${slug}`;
}

export class MemeStore {
  /**
   * @param {string} indexPath
   * @param {{ halfLifeDays?: number }} [options]
   */
  constructor(indexPath, options = {}) {
    this.indexPath = indexPath;
    this.halfLifeDays = options.halfLifeDays;
    /** @type {Map<string, any>} */
    this.byId = new Map();
    /** @type {Map<string, string>} */
    this.fingerprintToId = new Map();
    this.loaded = false;
    this.lastLookup = null;
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    let raw = "";
    try {
      raw = await readFile(this.indexPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let record;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue; // 单行损坏不该拖垮整个库
      }
      if (record?.kind === "tombstone" && typeof record.id === "string") {
        this.byId.delete(record.id);
        for (const [fp, id] of this.fingerprintToId) if (id === record.id) this.fingerprintToId.delete(fp);
        continue;
      }
      if (record?.kind === "meme" && typeof record.id === "string") {
        this.byId.set(record.id, record);
        for (const fp of record.fingerprints ?? []) this.fingerprintToId.set(fp, record.id);
      }
    }
  }

  /**
   * @param {string} fingerprint
   */
  async findByFingerprint(fingerprint) {
    await this.load();
    const id = this.fingerprintToId.get(fingerprint);
    return id === undefined ? undefined : this.byId.get(id);
  }

  /**
   * 尝试回忆：命中且还没过期才返回，过期则返回 stage 供调用方决定重查。
   * @param {string} fingerprint
   * @param {number} [now]
   */
  async recall(fingerprint, now = Date.now()) {
    const record = await this.findByFingerprint(fingerprint);
    if (record === undefined) return { record: null, memory: null };
    const memory = describe(record, { now, halfLifeDays: this.halfLifeDays });
    return { record, memory, recallable: isRecallable(record, { now, halfLifeDays: this.halfLifeDays }) };
  }

  /**
   * @param {object} input
   * @param {string} input.fingerprint
   * @param {string | null} input.name
   * @param {object} input.card
   * @param {number} [input.now]
   */
  async remember({ fingerprint, name, card, now = Date.now() }) {
    await this.load();
    const id = memeIdFrom(name, fingerprint);
    const existing = this.byId.get(id);
    const iso = new Date(now).toISOString();

    const record = existing === undefined
      ? {
        kind: "meme",
        version: RECORD_VERSION,
        id,
        name,
        card,
        fingerprints: [fingerprint],
        contexts: [],
        firstSeen: iso,
        lastSeen: iso,
        reinforcements: 1,
        combos: {},
      }
      : {
        ...existing,
        name: name ?? existing.name,
        card,
        fingerprints: existing.fingerprints.includes(fingerprint)
          ? existing.fingerprints
          : [...existing.fingerprints, fingerprint],
        lastSeen: iso,
        reinforcements: (existing.reinforcements ?? 1) + 1,
      };

    this.byId.set(id, record);
    this.fingerprintToId.set(fingerprint, id);
    await appendFile(this.indexPath, JSON.stringify(record) + "\n", "utf8");
    return { record, id, updated: existing !== undefined };
  }

  /**
   * 记一次「想起来」。只加深，不新写卡片。
   * @param {string} id
   * @param {number} [now]
   */
  async reinforce(id, now = Date.now()) {
    await this.load();
    const record = this.byId.get(id);
    if (record === undefined) return null;
    const next = {
      ...record,
      lastSeen: new Date(now).toISOString(),
      reinforcements: (record.reinforcements ?? 1) + 1,
    };
    this.byId.set(id, next);
    await appendFile(this.indexPath, JSON.stringify(next) + "\n", "utf8");
    return next;
  }

  /**
   * 记录一次查询，并在时间窗内自动统计「梗的组合」共现。
   * @param {string} id
   * @param {number} [now]
   * @returns {{ pairedWith: string | null }}
   */
  async noteLookup(id, now = Date.now()) {
    await this.load();
    const previous = this.lastLookup;
    this.lastLookup = { id, at: now };

    if (
      previous === null
      || previous.id === id
      || now - previous.at > COOCCURRENCE_WINDOW_MS
    ) {
      return { pairedWith: null };
    }

    await this.bumpCombo(id, previous.id);
    await this.bumpCombo(previous.id, id);
    return { pairedWith: previous.id };
  }

  /**
   * @param {string} id
   * @param {string} otherId
   */
  async bumpCombo(id, otherId) {
    const record = this.byId.get(id);
    if (record === undefined) return;
    const combos = { ...(record.combos ?? {}) };
    combos[otherId] = (combos[otherId] ?? 0) + 1;
    const next = { ...record, combos };
    this.byId.set(id, next);
    await appendFile(this.indexPath, JSON.stringify(next) + "\n", "utf8");
  }

  /**
   * 这个梗在本地最常跟谁一起被问到。这是「学会组合」的真实来源，
   * 不是提示词编出来的搭配。
   * @param {string} id
   * @param {number} [limit]
   */
  async combosFor(id, limit = 3) {
    await this.load();
    const record = this.byId.get(id);
    if (record === undefined) return [];
    return Object.entries(record.combos ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([otherId, count]) => ({ id: otherId, name: this.byId.get(otherId)?.name ?? otherId, count }));
  }

  /**
   * 真正忘掉一批：又弱又老的记录。
   * @param {number} [now]
   */
  async prune(now = Date.now()) {
    await this.load();
    const forgotten = [];
    for (const [id, record] of this.byId) {
      if (shouldForget(record, { now, halfLifeDays: this.halfLifeDays })) {
        forgotten.push(id);
        this.byId.delete(id);
        for (const fp of record.fingerprints ?? []) this.fingerprintToId.delete(fp);
      }
    }
    if (forgotten.length === 0) return { forgotten };

    const lines = [...this.byId.values()].map((record) => JSON.stringify(record) + "\n").join("");
    await mkdir(dirname(this.indexPath), { recursive: true });
    await writeFile(this.indexPath, lines, "utf8");
    return { forgotten };
  }

  /** 库里的梗数量。 */
  get size() {
    return this.byId.size;
  }

  /** 调试用快照。 */
  snapshot() {
    return [...this.byId.values()];
  }

  /**
   * @param {object} record
   * @param {number} [now]
   */
  memoryOf(record, now = Date.now()) {
    return describe(record, { now, halfLifeDays: this.halfLifeDays });
  }

  /**
   * @param {object} record
   * @param {number} [now]
   */
  projectedReinforcement(record, now = Date.now()) {
    return reinforced(record, { now, halfLifeDays: this.halfLifeDays });
  }
}
