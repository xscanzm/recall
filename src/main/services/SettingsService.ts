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
import type { UpdateSettings } from "../../shared/updateTypes";
import { DEFAULT_UPDATE_SETTINGS } from "../../shared/updateTypes";
import type { ModelConfig, PrivacyRule } from "../../shared/types";
import type { UserFeedback } from "../models/types";
import { SettingsRepository } from "../db/repositories/SettingsRepository";
import type { SecretService } from "./SecretService";
import {
  DATA_DIR,
  SETTINGS_FILENAME,
} from "../../shared/constants";
import { normalizeReportRequirements } from "../../shared/reportRequirements";

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
   * patch 采用浅合并：observation/screenshot/notification/dailyReport/personalReview/reportRequirements/schedule/onboardingCompleted 各自整体替换
   * - schedule 字段：仅 ReportScheduler 内部写，外部 API 不应直接 patch；
   *   这里提供独立方法 setSchedule() 以便区分。
   */
  update(patch: Partial<AppSettings>): AppSettings {
    if (!this.initialized) this.init();

    this.cache = {
      observation: patch.observation ?? this.cache.observation,
      screenshot: patch.screenshot ?? this.cache.screenshot,
      notification: patch.notification ?? this.cache.notification,
      endOfDayReview: patch.endOfDayReview ?? this.cache.endOfDayReview,
      dailyReport: patch.dailyReport ?? this.cache.dailyReport,
      personalReview: patch.personalReview ?? this.cache.personalReview,
      reportRequirements:
        patch.reportRequirements ?? this.cache.reportRequirements,
      schedule: patch.schedule ?? this.cache.schedule,
      onboardingCompleted:
        patch.onboardingCompleted ?? this.cache.onboardingCompleted,
      debug: patch.debug ?? this.cache.debug,
      update: patch.update ?? this.cache.update,
    };

    this.saveToFile(this.cache);
    return this.cache;
  }

  /**
   * 调试模式是否开启（总开关）
   * 控制Logger devDebug、各层 debugEvents 收集、DebugPage 入口可见性
   */
  isDebugMode(): boolean {
    if (!this.initialized) this.init();
    return this.cache.debug?.enabled ?? false;
  }

  /**
   * 是否记录完整模型输入输出到 model_jobs.raw_input_json
   * 需 isDebugMode() 同时为 true 才生效（开销较大，单独控制）
   */
  isVerboseModelIO(): boolean {
    if (!this.initialized) this.init();
    return this.cache.debug?.enabled === true && this.cache.debug?.verboseModelIO === true;
  }

  /**
   * 仅更新 schedule 字段（用于 ReportScheduler 写入 lastRunDate）
   * - 单独方法避免误覆盖其他字段
   * - 同步写 settings.json 保证重启后能恢复
   */
  setSchedule(patch: Partial<AppSettings["schedule"]>): AppSettings {
    if (!this.initialized) this.init();
    this.cache = {
      ...this.cache,
      schedule: { ...this.cache.schedule, ...patch },
    };
    this.saveToFile(this.cache);
    return this.cache;
  }

  /**
   * 仅更新 update 字段（用于 UpdateService 持久化检查结果/忽略版本/下载路径）
   * - 单独方法避免误覆盖其他字段
   * - 同步写 settings.json 保证重启后能恢复
   */
  setUpdateSettings(patch: Partial<UpdateSettings>): AppSettings {
    if (!this.initialized) this.init();
    this.cache = {
      ...this.cache,
      update: { ...this.cache.update, ...patch },
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
    kind?: "vision" | "language" | "multimodal";
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

  listMultimodalModelConfigs(): ModelConfig[] {
    return this.settingsRepo.listMultimodalModelConfigs();
  }

  /**
   * 获取当前启用的多模态模型配置 id
   * - 优先返回 listMultimodalModelConfigs() 中第一个 enabled 配置
   * - 无启用配置时返回 null
   * - 供 Pipeline / 新合并 Worker 解析当前生效的多模态配置
   */
  getActiveMultimodalModelConfigId(): string | null {
    try {
      const configs = this.listMultimodalModelConfigs();
      const enabled = configs.find((c) => c.enabled);
      return enabled?.id ?? null;
    } catch {
      return null;
    }
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
        endOfDayReview: { ...DEFAULT_SETTINGS.endOfDayReview, ...parsed.endOfDayReview },
        dailyReport: { ...DEFAULT_SETTINGS.dailyReport, ...parsed.dailyReport },
        personalReview: {
          ...DEFAULT_SETTINGS.personalReview,
          ...parsed.personalReview,
        },
        reportRequirements: normalizeReportRequirements(parsed.reportRequirements),
        schedule: { ...DEFAULT_SETTINGS.schedule, ...parsed.schedule },
        onboardingCompleted:
          parsed.onboardingCompleted ?? DEFAULT_SETTINGS.onboardingCompleted,
        debug: { ...DEFAULT_SETTINGS.debug, ...(parsed.debug ?? {}) },
        update: { ...DEFAULT_UPDATE_SETTINGS, ...(parsed.update ?? {}) },
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
