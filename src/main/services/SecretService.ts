// src/main/services/SecretService.ts
// API Key 安全存储（来自 04、07 文档）
//
// 安全约束（严格）：
// - API Key 使用 Electron safeStorage 加密（Windows 上底层是 DPAPI，按当前用户+机器绑定）
// - API Key 不进入 renderer
// - API Key 不进 SQLite
// - API Key 不进日志
// - 连接测试失败时不显示 key
// - 删除模型配置时同时删除 SecretService 中的 key
//
// 存储形态：%APPDATA%/Recall/data/secrets.json
//   { "version": 1, "secrets": { "model:<configId>:apiKey": "<base64 ciphertext>" } }
//
// 为什么从 keytar 换到 safeStorage：
// - keytar 是需要 electron-rebuild 的原生模块，每次 Electron 大版本升级都要重编，
//   打包体积和 CI 复杂度都在它身上；而且上游已归档不再维护。
// - safeStorage 是 Electron 内置 API，Windows 上走 DPAPI，安全等级与凭据管理器同源。
//
// 密文文件 vs SQLite：刻意不进 SQLite。db 文件会被备份/导出/VACUUM INTO 复制，
// 密钥跟着走会扩大暴露面；单独一个文件更容易讲清"这个文件不要拷"。

import { app, safeStorage } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import { DATA_DIR, SECRETS_FILENAME } from "../../shared/constants";

interface SecretsFile {
  version: 1;
  secrets: Record<string, string>;
}

const EMPTY_FILE: SecretsFile = { version: 1, secrets: {} };

export class SecretService {
  /**
   * 保存 API Key
   * account name: model:<configId>:apiKey
   *
   * safeStorage 不可用时**不降级写明文**，直接抛错。宁可让用户看到"保存失败"，
   * 也不能把 key 以可读形式落盘。
   */
  async setApiKey(configId: string, apiKey: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("系统安全存储不可用，API Key 未保存");
    }
    const encrypted = safeStorage.encryptString(apiKey).toString("base64");
    const file = this.read();
    file.secrets[this.accountName(configId)] = encrypted;
    this.write(file);
  }

  /**
   * 读取 API Key
   * 失败时返回 null（不抛错，不写入日志）
   */
  async getApiKey(configId: string): Promise<string | null> {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const encrypted = this.read().secrets[this.accountName(configId)];
      if (!encrypted) return null;
      return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    } catch {
      // 密文损坏、换机器（DPAPI 解不开）等情况：返回 null 让上层走"未配置"分支，
      // 不抛错也不记录任何与 key 相关的内容。
      return null;
    }
  }

  /**
   * 删除 API Key（删除模型配置时调用）
   * @returns 是否确实删掉了一条
   */
  async deleteApiKey(configId: string): Promise<boolean> {
    try {
      const file = this.read();
      const account = this.accountName(configId);
      if (!(account in file.secrets)) return false;
      delete file.secrets[account];
      this.write(file);
      return true;
    } catch {
      return false;
    }
  }

  private accountName(configId: string): string {
    return `model:${configId}:apiKey`;
  }

  private filePath(): string {
    const dataDir = path.join(app.getPath("userData"), DATA_DIR);
    fs.mkdirSync(dataDir, { recursive: true });
    return path.join(dataDir, SECRETS_FILENAME);
  }

  private read(): SecretsFile {
    try {
      const filePath = this.filePath();
      if (!fs.existsSync(filePath)) return { ...EMPTY_FILE, secrets: {} };
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<SecretsFile>;
      if (!parsed || typeof parsed.secrets !== "object" || parsed.secrets === null) {
        return { ...EMPTY_FILE, secrets: {} };
      }
      return { version: 1, secrets: parsed.secrets as Record<string, string> };
    } catch {
      // 文件损坏时当成空的。这里不能抛：否则一个坏文件会让所有模型调用都挂掉。
      return { ...EMPTY_FILE, secrets: {} };
    }
  }

  private write(file: SecretsFile): void {
    const filePath = this.filePath();
    // 先写临时文件再 rename：避免写一半断电留下半个 JSON，把所有 key 一起弄丢。
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(file, null, 2), "utf-8");
    fs.renameSync(tempPath, filePath);
  }
}

export const secretService = new SecretService();
