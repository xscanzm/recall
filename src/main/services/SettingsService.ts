// src/main/services/SettingsService.ts
// 应用设置服务
//
// 职责：
// - 应用偏好（观察阈值、截图保留策略、通知设置）存储于 settings.json 文件，不进 SQLite
// - model_configs / privacy_rules / user_feedback 通过 SettingsRepository 存 SQLite
// - 删除模型配置时编排 SecretService 删除对应 API Key
// - 维护内存缓存，启动时从文件加载
//
// 重要约束：
// - API Key 不进 SQLite、不进 settings.json、不进 renderer、不进日志
// - settings.json 位于 %APPDATA%/Recall/data/settings.json

import { app } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type CreateModelConfigInput,
  type UpdateModelConfigInput,
  type CreatePrivacyRuleInput,
  type UpdatePrivacyRuleInput,
  type CreateUserFeedbackInput,
} from "../models/types";
import type { ModelConfig, PrivacyRule } from "../../shared/types";
import type { UserFeedback } from "../models/types";
import { SettingsRepository } from "../db/repositories/SettingsRepository";
import type { SecretService } from "./SecretService";
import {
  DATA_DIR,
  SETTINGS_FILENAME,
} from "../../shared/constants";

export class SettingsService {
  private cache: AppSettings = DEFAULT_SETTINGS;
  private settingsRepo: SettingsRepository;
  private secretService: SecretService;
  private initialized = false;

  constructor(settingsRepo: SettingsRepository, secretService: SecretService) {
    this.settingsRepo = settingsRepo;
    this.secretService = secretService;
  }

  /**
   * 初始化：从 settings.json 加载应用偏好
   * 必须在 app.whenReady() 之后调用（依赖 app.getPath）
   */
  init(): void {
    if (this.initialized) return;
    this.cache = this.loadFromFile();
    this.initialized = true;
  }

  /**
   * 获取全部应用偏好（来自内存缓存）
   */
  getAll(): AppSettings {
    if (!this.initialized) this.init();
    return this.cache;
  }

  /**
   * 更新应用偏好（写入 settings.json）
   * patch 采用浅合并：observation/screenshot/notification/dailyReport/onboardingCompleted 各自整体替换
   */
  update(patch: Partial<AppSettings>): AppSettings {
    if (!this.initialized) this.init();

    this.cache = {
      observation: patch.observation ?? this.cache.observation,
      screenshot: patch.screenshot ?? this.cache.screenshot,
      notification: patch.notification ?? this.cache.notification,
      dailyReport: patch.dailyReport ?? this.cache.dailyReport,
      onboardingCompleted:
        patch.onboardingCompleted ?? this.cache.onboardingCompleted,
    };

    this.saveToFile(this.cache);
    return this.cache;
  }

  // ---------------------- model_configs ----------------------

  /**
   * 创建模型配置
   * 注意：API Key 通过 SecretService 单独存储，不在此方法处理
   */
  createModelConfig(input: CreateModelConfigInput): ModelConfig {
    return this.settingsRepo.createModelConfig(input);
  }

  getModelConfigById(id: string): ModelConfig | null {
    return this.settingsRepo.getModelConfigById(id);
  }

  listModelConfigs(opts: {
    kind?: "vision" | "language";
    enabled?: boolean;
  } = {}): ModelConfig[] {
    return this.settingsRepo.listModelConfigs(opts);
  }

  listVisionModelConfigs(): ModelConfig[] {
    return this.settingsRepo.listVisionModelConfigs();
  }

  listLanguageModelConfigs(): ModelConfig[] {
    return this.settingsRepo.listLanguageModelConfigs();
  }

  updateModelConfig(id: string, patch: UpdateModelConfigInput): ModelConfig | null {
    return this.settingsRepo.updateModelConfig(id, patch);
  }

  /**
   * 删除模型配置
   * 级联删除 SecretService 中的 API Key
   */
  async deleteModelConfig(id: string): Promise<boolean> {
    const deleted = this.settingsRepo.deleteModelConfig(id);
    if (deleted) {
      // 删除对应 API Key（即使删除失败也不抛错，避免数据不一致）
      try {
        await this.secretService.deleteApiKey(id);
      } catch {
        // SecretService 删除失败不阻断配置删除
      }
    }
    return deleted;
  }

  // ---------------------- privacy_rules ----------------------

  createPrivacyRule(input: CreatePrivacyRuleInput): PrivacyRule {
    return this.settingsRepo.createPrivacyRule(input);
  }

  getPrivacyRuleById(id: string): PrivacyRule | null {
    return this.settingsRepo.getPrivacyRuleById(id);
  }

  listPrivacyRules(opts: { enabled?: boolean } = {}): PrivacyRule[] {
    return this.settingsRepo.listPrivacyRules(opts);
  }

  updatePrivacyRule(id: string, patch: UpdatePrivacyRuleInput): PrivacyRule | null {
    return this.settingsRepo.updatePrivacyRule(id, patch);
  }

  deletePrivacyRule(id: string): boolean {
    return this.settingsRepo.deletePrivacyRule(id);
  }

  // ---------------------- user_feedback ----------------------

  createUserFeedback(input: CreateUserFeedbackInput): UserFeedback {
    return this.settingsRepo.createUserFeedback(input);
  }

  getUserFeedbackById(id: string): UserFeedback | null {
    return this.settingsRepo.getUserFeedbackById(id);
  }

  listUserFeedbackByTarget(targetType: string, targetId: string): UserFeedback[] {
    return this.settingsRepo.listByTarget(targetType, targetId);
  }

  listUserFeedbackByType(feedbackType: string): UserFeedback[] {
    return this.settingsRepo.listByType(feedbackType);
  }

  deleteUserFeedback(id: string): boolean {
    return this.settingsRepo.deleteUserFeedback(id);
  }

  // ---------------------- settings.json 文件 I/O ----------------------

  /**
   * settings.json 路径：与数据库同目录（%APPDATA%/Recall/data/settings.json）
   */
  private getSettingsFilePath(): string {
    const userData = app.getPath("userData");
    const dataDir = path.join(userData, DATA_DIR);
    fs.mkdirSync(dataDir, { recursive: true });
    return path.join(dataDir, SETTINGS_FILENAME);
  }

  /**
   * 从文件加载设置，文件不存在时返回默认值
   */
  private loadFromFile(): AppSettings {
    try {
      const filePath = this.getSettingsFilePath();
      if (!fs.existsSync(filePath)) {
        // 首次启动：写入默认设置
        this.saveToFile(DEFAULT_SETTINGS);
        return DEFAULT_SETTINGS;
      }
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content) as Partial<AppSettings>;
      // 合并默认值，避免缺失字段（兼容旧版本 settings.json）
      return {
        observation: { ...DEFAULT_SETTINGS.observation, ...parsed.observation },
        screenshot: { ...DEFAULT_SETTINGS.screenshot, ...parsed.screenshot },
        notification: { ...DEFAULT_SETTINGS.notification, ...parsed.notification },
        dailyReport: { ...DEFAULT_SETTINGS.dailyReport, ...parsed.dailyReport },
        onboardingCompleted:
          parsed.onboardingCompleted ?? DEFAULT_SETTINGS.onboardingCompleted,
      };
    } catch {
      // 文件损坏时回退到默认值
      return DEFAULT_SETTINGS;
    }
  }

  /**
   * 保存设置到文件
   */
  private saveToFile(settings: AppSettings): void {
    const filePath = this.getSettingsFilePath();
    const content = JSON.stringify(settings, null, 2);
    fs.writeFileSync(filePath, content, "utf-8");
  }
}

export function createSettingsService(
  settingsRepo: SettingsRepository,
  secretService: SecretService
): SettingsService {
  return new SettingsService(settingsRepo, secretService);
}
