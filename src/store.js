/**
 * 本地梗库：一个追加写的 JSONL 索引。
 *
 * 设计要点：
 * - 主键是「内容指纹」(fingerprint)。远期应该用感知哈希 (pHash)，
 *   这样同一张图被压缩、加水印、裁剪后仍能命中；当前先用 sha256
 *   作为第一版指纹，等图像解码链路接上再升级。
 * - 一条记录 = 一个已解释过的表情包 + 当时的结论 + 首次见到的时间。
 *   结论会过期（梗会过气），所以记录里必须留 firstSeen / lastSeen，
 *   读取时按时间衰减给出可信度，而不是永远相信缓存。
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

export const RECORD_VERSION = 1;

export function sha256Fingerprint(buffer) {
  return "sha256:" + createHash("sha256").update(buffer).digest("hex");
}

export class MemeStore {
  /**
   * @param {string} indexPath JSONL 文件路径
   */
  constructor(indexPath) {
    this.indexPath = indexPath;
    /** @type {Map<string, any>} */
    this.byFingerprint = new Map();
    this.loaded = false;
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
      const text = line.trim();
      if (text === "") continue;
      try {
        const record = JSON.parse(text);
        if (typeof record?.fingerprint === "string") {
          this.byFingerprint.set(record.fingerprint, record);
        }
      } catch {
        // 单行损坏不该拖垮整个库：跳过并继续。
      }
    }
  }

  /**
   * @param {string} fingerprint
   * @returns {Promise<any | undefined>}
   */
  async find(fingerprint) {
    await this.load();
    return this.byFingerprint.get(fingerprint);
  }

  /**
   * @param {object} record
   */
  async upsert(record) {
    await this.load();
    const previous = this.byFingerprint.get(record.fingerprint);
    const merged = previous
      ? { ...previous, ...record, firstSeen: previous.firstSeen ?? record.firstSeen }
      : record;
    this.byFingerprint.set(merged.fingerprint, merged);
    await mkdir(dirname(this.indexPath), { recursive: true });
    await appendFile(this.indexPath, JSON.stringify(merged) + "\n", "utf8");
    return merged;
  }

  get size() {
    return this.byFingerprint.size;
  }
}
