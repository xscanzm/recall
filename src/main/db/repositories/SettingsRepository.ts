// src/main/db/repositories/SettingsRepository.ts
// SettingsRepository：model_configs / privacy_rules / user_feedback 数据访问
//
// 涵盖表：
// - model_configs（模型配置，API Key 不在此表）
// - privacy_rules（隐私规则）
// - user_feedback（用户反馈）
//
// 重要约束：
// - API Key 不进 SQLite（model_configs 表不含 api_key 字段）
// - API Key 存在 SecretService，key name 为 recall:model:<configId>:apiKey
// - 删除模型配置时由 SettingsService 调用 SecretService.deleteApiKey

import type { DB } from "../Database";
import type { ModelConfig, PrivacyRule } from "../../../shared/types";
import { generateId } from "../../utils/id";
import type {
  UserFeedback,
  CreateModelConfigInput,
  UpdateModelConfigInput,
  CreatePrivacyRuleInput,
  UpdatePrivacyRuleInput,
  CreateUserFeedbackInput,
} from "../../models/types";

// ============================================================================
// DB Row 类型
// ============================================================================

interface ModelConfigRow {
  id: string;
  kind: string;
  provider_name: string;
  endpoint: string;
  model: string;
  options_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface PrivacyRuleRow {
  id: string;
  type: string;
  pattern: string;
  action: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface UserFeedbackRow {
  id: string;
  target_type: string;
  target_id: string;
  feedback_type: string;
  note: string | null;
  created_at: string;
}

// ============================================================================
// Repository
// ============================================================================

export class SettingsRepository {
  constructor(private db: DB) {}

  // ---------------------- model_configs ----------------------

  /**
   * 创建模型配置（API Key 不在此处存储）
   */
  createModelConfig(input: CreateModelConfigInput): ModelConfig {
    const id = input.id ?? generateId("model");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO model_configs (
          id, kind, provider_name, endpoint, model, options_json, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.kind,
        input.providerName,
        input.endpoint,
        input.model,
        input.optionsJson ?? "{}",
        input.enabled === false ? 0 : 1,
        now,
        now
      );
    return this.getModelConfigById(id)!;
  }

  /**
   * 按 id 查询模型配置
   */
  getModelConfigById(id: string): ModelConfig | null {
    const row = this.db.prepare("SELECT * FROM model_configs WHERE id = ?").get(id) as
      | ModelConfigRow
      | undefined;
    return row ? mapModelConfigRow(row) : null;
  }

  /**
   * 按 kind 查询（vision / language / multimodal）
   */
  listModelConfigs(opts: {
    kind?: "vision" | "language" | "multimodal";
    enabled?: boolean;
  } = {}): ModelConfig[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.kind) { conditions.push("kind = ?"); params.push(opts.kind); }
    if (opts.enabled !== undefined) { conditions.push("enabled = ?"); params.push(opts.enabled ? 1 : 0); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM model_configs ${where} ORDER BY created_at ASC`)
      .all(...params) as ModelConfigRow[];
    return rows.map(mapModelConfigRow);
  }

  /**
   * 查询 vision 模型配置
   */
  listVisionModelConfigs(): ModelConfig[] {
    return this.listModelConfigs({ kind: "vision" });
  }

  /**
   * 查询 language 模型配置
   */
  listLanguageModelConfigs(): ModelConfig[] {
    return this.listModelConfigs({ kind: "language" });
  }

  /**
   * 查询 multimodal 模型配置
   */
  listMultimodalModelConfigs(): ModelConfig[] {
    return this.listModelConfigs({ kind: "multimodal" });
  }

  /**
   * 查询启用的模型配置
   */
  listEnabledModelConfigs(kind?: "vision" | "language" | "multimodal"): ModelConfig[] {
    return this.listModelConfigs({ kind, enabled: true });
  }

  /**
   * 更新模型配置（kind 不可更新）
   */
  updateModelConfig(id: string, patch: UpdateModelConfigInput): ModelConfig | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.providerName !== undefined) { sets.push("provider_name = ?"); params.push(patch.providerName); }
    if (patch.endpoint !== undefined) { sets.push("endpoint = ?"); params.push(patch.endpoint); }
    if (patch.model !== undefined) { sets.push("model = ?"); params.push(patch.model); }
    if (patch.optionsJson !== undefined) { sets.push("options_json = ?"); params.push(patch.optionsJson); }
    if (patch.enabled !== undefined) { sets.push("enabled = ?"); params.push(patch.enabled ? 1 : 0); }
    if (sets.length === 0) return this.getModelConfigById(id);
    sets.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);
    this.db.prepare(`UPDATE model_configs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.getModelConfigById(id);
  }

  /**
   * 删除模型配置
   * 注意：调用方（SettingsService）需同时删除 SecretService 中的 API Key
   */
  deleteModelConfig(id: string): boolean {
    const result = this.db.prepare("DELETE FROM model_configs WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ---------------------- privacy_rules ----------------------

  /**
   * 创建隐私规则
   */
  createPrivacyRule(input: CreatePrivacyRuleInput): PrivacyRule {
    const id = input.id ?? generateId("rule");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO privacy_rules (id, type, pattern, action, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.type,
        input.pattern,
        input.action,
        input.enabled === false ? 0 : 1,
        now,
        now
      );
    return this.getPrivacyRuleById(id)!;
  }

  /**
   * 按 id 查询隐私规则
   */
  getPrivacyRuleById(id: string): PrivacyRule | null {
    const row = this.db.prepare("SELECT * FROM privacy_rules WHERE id = ?").get(id) as
      | PrivacyRuleRow
      | undefined;
    return row ? mapPrivacyRuleRow(row) : null;
  }

  /**
   * 查询全部隐私规则
   */
  listPrivacyRules(opts: { enabled?: boolean } = {}): PrivacyRule[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.enabled !== undefined) { conditions.push("enabled = ?"); params.push(opts.enabled ? 1 : 0); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM privacy_rules ${where} ORDER BY created_at ASC`)
      .all(...params) as PrivacyRuleRow[];
    return rows.map(mapPrivacyRuleRow);
  }

  /**
   * 更新隐私规则
   */
  updatePrivacyRule(id: string, patch: UpdatePrivacyRuleInput): PrivacyRule | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.pattern !== undefined) { sets.push("pattern = ?"); params.push(patch.pattern); }
    if (patch.action !== undefined) { sets.push("action = ?"); params.push(patch.action); }
    if (patch.enabled !== undefined) { sets.push("enabled = ?"); params.push(patch.enabled ? 1 : 0); }
    if (sets.length === 0) return this.getPrivacyRuleById(id);
    sets.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);
    this.db.prepare(`UPDATE privacy_rules SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.getPrivacyRuleById(id);
  }

  /**
   * 删除隐私规则
   */
  deletePrivacyRule(id: string): boolean {
    const result = this.db.prepare("DELETE FROM privacy_rules WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ---------------------- user_feedback ----------------------

  /**
   * 创建用户反馈
   */
  createUserFeedback(input: CreateUserFeedbackInput): UserFeedback {
    const id = input.id ?? generateId("fb");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO user_feedback (id, target_type, target_id, feedback_type, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.targetType,
        input.targetId,
        input.feedbackType,
        input.note ?? null,
        now
      );
    return this.getUserFeedbackById(id)!;
  }

  /**
   * 按 id 查询用户反馈
   */
  getUserFeedbackById(id: string): UserFeedback | null {
    const row = this.db.prepare("SELECT * FROM user_feedback WHERE id = ?").get(id) as
      | UserFeedbackRow
      | undefined;
    return row ? mapUserFeedbackRow(row) : null;
  }

  /**
   * 按目标查询用户反馈
   */
  listByTarget(targetType: string, targetId: string): UserFeedback[] {
    const rows = this.db
      .prepare("SELECT * FROM user_feedback WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC")
      .all(targetType, targetId) as UserFeedbackRow[];
    return rows.map(mapUserFeedbackRow);
  }

  /**
   * 按类型查询用户反馈
   */
  listByType(feedbackType: string): UserFeedback[] {
    const rows = this.db
      .prepare("SELECT * FROM user_feedback WHERE feedback_type = ? ORDER BY created_at DESC")
      .all(feedbackType) as UserFeedbackRow[];
    return rows.map(mapUserFeedbackRow);
  }

  /**
   * 删除用户反馈
   */
  deleteUserFeedback(id: string): boolean {
    const result = this.db.prepare("DELETE FROM user_feedback WHERE id = ?").run(id);
    return result.changes > 0;
  }
}

export function createSettingsRepository(db: DB): SettingsRepository {
  return new SettingsRepository(db);
}

// ============================================================================
// 内部辅助函数
// ============================================================================

function mapModelConfigRow(row: ModelConfigRow): ModelConfig {
  return {
    id: row.id,
    kind: row.kind as "vision" | "language" | "multimodal",
    providerName: row.provider_name,
    endpoint: row.endpoint,
    model: row.model,
    optionsJson: row.options_json,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPrivacyRuleRow(row: PrivacyRuleRow): PrivacyRule {
  return {
    id: row.id,
    type: row.type as PrivacyRule["type"],
    pattern: row.pattern,
    action: row.action as PrivacyRule["action"],
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapUserFeedbackRow(row: UserFeedbackRow): UserFeedback {
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    feedbackType: row.feedback_type,
    note: row.note,
    createdAt: row.created_at,
  };
}

