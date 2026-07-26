// src/main/services/secretsMigration.ts
// keytar → safeStorage 一次性迁移
//
// 背景：v0.5.x 之前 API Key 存在 keytar（Windows 凭据管理器）。keytar 是需要
// electron-rebuild 的原生模块且上游已归档，现改为 Electron 内置 safeStorage
// 加密后写 %APPDATA%/Recall/data/secrets.json。
//
// 迁移策略：
// - 启动时跑一次，把 keytar 里 service=recall 的条目全部读出来，写进 safeStorage，
//   确认写成功后再删除 keytar 里的原条目。
// - keytar 模块缺失（已从依赖里移除）或系统凭据服务不可用时，静默跳过——
//   老用户没迁移成功最坏结果是需要重新填一次 API Key，不能因此挡住启动。
// - 全程不记录 key 本身，日志里只有条数。
//
// keytar 依赖的去留：本模块是它在生产代码里唯一的调用点，package.json 里已钉死到
// 精确版本（不再接受 range 升级，上游已归档）。等到不再需要照顾 v0.5.x 之前的
// 安装时，直接把 keytar 从 dependencies 删掉即可——defaultLoadKeytar 的 require
// 会落到 catch，整个迁移退化成 skipped/keytar_unavailable，不需要改任何代码。

import { safeStorage } from "electron";
import { KEYTAR_SERVICE_PREFIX } from "../../shared/constants";
import { logger } from "./Logger";
import type { SecretService } from "./SecretService";

/** keytar 的最小接口。用它来避免直接静态 import 一个可能已被移除的依赖。 */
interface KeytarLike {
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

export interface SecretsMigrationDeps {
  secretService: Pick<SecretService, "setApiKey">;
  /** 注入点：测试里替换成假的；生产走 require("keytar")。 */
  loadKeytar?: () => KeytarLike | null;
  isEncryptionAvailable?: () => boolean;
}

export interface SecretsMigrationResult {
  status: "skipped" | "done";
  migrated: number;
  failed: number;
  reason?: string;
}

function defaultLoadKeytar(): KeytarLike | null {
  try {
    // 动态 require：keytar 后续从 dependencies 移除后，这里会走到 catch 直接跳过，
    // 不需要再改代码。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("keytar") as KeytarLike;
  } catch {
    return null;
  }
}

/**
 * 把 keytar 里的 API Key 搬到 safeStorage。幂等：搬完即删源，第二次跑时 findCredentials
 * 返回空数组，直接 done/0。
 *
 * 没有落"已迁移"标记：代价只是每次启动多一次 require("keytar") 加一次空查询，
 * 而 keytar 从 dependencies 移除后连这个也没有了（直接走 keytar_unavailable）。
 * 与其为此多存一份状态，不如让这条路径保持无状态。
 */
export async function migrateKeytarSecrets(
  deps: SecretsMigrationDeps,
): Promise<SecretsMigrationResult> {
  const encryptionAvailable = deps.isEncryptionAvailable ?? (() => safeStorage.isEncryptionAvailable());
  if (!encryptionAvailable()) {
    return { status: "skipped", migrated: 0, failed: 0, reason: "encryption_unavailable" };
  }

  const keytar = (deps.loadKeytar ?? defaultLoadKeytar)();
  if (!keytar) {
    return { status: "skipped", migrated: 0, failed: 0, reason: "keytar_unavailable" };
  }

  let credentials: Array<{ account: string; password: string }>;
  try {
    credentials = await keytar.findCredentials(KEYTAR_SERVICE_PREFIX);
  } catch {
    // Linux 上没起 secret-service、Windows 上凭据服务被策略禁用等。
    return { status: "skipped", migrated: 0, failed: 0, reason: "keytar_read_failed" };
  }

  if (credentials.length === 0) {
    return { status: "done", migrated: 0, failed: 0 };
  }

  let migrated = 0;
  let failed = 0;
  for (const { account, password } of credentials) {
    // account 形如 model:<configId>:apiKey，只迁移这个形状的。
    const configId = parseConfigId(account);
    if (!configId || !password) {
      failed += 1;
      continue;
    }
    try {
      await deps.secretService.setApiKey(configId, password);
      // 只有确认新位置写成功了才删源，否则宁可留着下次再试。
      await keytar.deletePassword(KEYTAR_SERVICE_PREFIX, account);
      migrated += 1;
    } catch {
      failed += 1;
    }
  }

  if (migrated > 0 || failed > 0) {
    logger.info({
      message: `API Key 存储迁移完成：${migrated} 条已转入 safeStorage，${failed} 条失败`,
    });
  }
  return { status: "done", migrated, failed };
}

/** model:<configId>:apiKey → configId；不匹配返回 null。 */
export function parseConfigId(account: string): string | null {
  const match = /^model:(.+):apiKey$/.exec(account);
  return match ? match[1] : null;
}
