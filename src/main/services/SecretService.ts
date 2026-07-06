// src/main/services/SecretService.ts
// API Key 安全存储（来自 04、07 文档）
//
// 安全约束（严格）：
// - API Key 使用 keytar 或 Electron safeStorage
// - API Key 不进入 renderer
// - API Key 不进 SQLite
// - API Key 不进日志
// - 连接测试失败时不显示 key
// - 删除模型配置时同时删除 SecretService 中的 key
//
// Key 命名规范：recall:model:<configId>:apiKey

import * as keytar from "keytar";
import { KEYTAR_SERVICE_PREFIX } from "../../shared/constants";

export class SecretService {
  /**
   * 保存 API Key
   * key name: recall:model:<configId>:apiKey
   */
  async setApiKey(configId: string, apiKey: string): Promise<void> {
    await keytar.setPassword(
      KEYTAR_SERVICE_PREFIX,
      this.accountName(configId),
      apiKey
    );
  }

  /**
   * 读取 API Key
   * 失败时返回 null（不抛错，不写入日志）
   */
  async getApiKey(configId: string): Promise<string | null> {
    try {
      return await keytar.getPassword(KEYTAR_SERVICE_PREFIX, this.accountName(configId));
    } catch {
      // keytar 在某些环境下可能不可用（如未安装 secret-service-daemon）
      // 失败时仅返回 null，不抛错，不记录 key
      return null;
    }
  }

  /**
   * 删除 API Key（删除模型配置时调用）
   */
  async deleteApiKey(configId: string): Promise<boolean> {
    try {
      return await keytar.deletePassword(KEYTAR_SERVICE_PREFIX, this.accountName(configId));
    } catch {
      return false;
    }
  }

  private accountName(configId: string): string {
    return `model:${configId}:apiKey`;
  }
}

export const secretService = new SecretService();
