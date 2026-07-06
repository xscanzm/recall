// src/main/services/PrivacyGuard.ts
// 三重过滤（来自 06、07 文档）
//
// 职责：
// - 判断当前窗口是否可采集
// - 黑名单应用（app name 匹配）
// - 标题/URL 敏感词（中英文）
// - 用户暂停状态
// - 高敏场景跳过
// - 捕获前检查一次
// - 视觉模型返回 high_sensitive 后再处理一次
//
// 三重过滤：
// 1. 黑名单应用：DEFAULT_BLACKLIST_APPS（1Password / Bitwarden / KeePass / Windows Credential Manager / 银行/支付类应用）
// 2. 标题/URL 敏感词：DEFAULT_SENSITIVE_KEYWORDS（中英文）
// 3. 用户暂停状态：isPaused == true 时不采集
//
// Rule action:
// - exclude：完全不采集
// - ask_before_capture：暂不实现也可预留
// - blur_sensitive：MVP 可不实现
//
// 默认黑名单（来自 07 文档）：1Password / Bitwarden / KeePass / Windows Credential Manager / 银行/支付类应用
// 默认敏感词（来自 07 文档）：password、login、bank、pay、wallet、medical、passport、id card、secret、token、api key、密码、登录、支付、银行、钱包、证件、身份证、医疗、病历、私密、密钥、API Key

import { EventEmitter } from "node:events";
import { DEFAULT_BLACKLIST_APPS, DEFAULT_SENSITIVE_KEYWORDS } from "../../shared/constants";
import type { PrivacyRule } from "../../shared/types";
import type { SettingsService } from "./SettingsService";

/**
 * 捕获前检查原因
 */
export type PreCaptureReason =
  | "ok"
  | "blacklist_app"
  | "sensitive_keyword"
  | "paused"
  | "locked"
  | "unknown";

/**
 * 捕获前检查结果
 */
export interface PreCaptureCheckResult {
  allowed: boolean;
  reason: PreCaptureReason;
  /** 命中的规则 id（如果有） */
  ruleId?: string;
  /** 命中的关键词/应用名（用于日志，不含敏感原文） */
  matchedPattern?: string;
}

/**
 * 视觉模型返回后处理动作
 */
export type PostVisionAction =
  | "keep"
  | "delete_observation"
  | "keep_blocked_event_only";

/**
 * 视觉模型返回后检查结果
 */
export interface PostVisionCheckResult {
  allowed: boolean;
  action: PostVisionAction;
  /** 视觉模型给出的 sensitivity */
  sensitivity: "normal" | "possibly_sensitive" | "high_sensitive";
  /** 原因（用于日志） */
  reason?: string;
}

/**
 * 兼容旧接口（保留）
 */
export type PrivacyCheckResult =
  | { allowed: true }
  | { allowed: false; reason: "blacklist" | "sensitive_keyword" | "paused" | "high_sensitive" | "locked"; ruleId?: string };

/**
 * 捕获前检查输入
 */
export interface PreCaptureInput {
  appName: string;
  windowTitle: string;
  urlOrDomain?: string;
  /** 用户是否暂停观察 */
  isPaused: boolean;
  /** 是否锁屏（systemLocked） */
  isLocked?: boolean;
}

/**
 * PrivacyGuard 事件
 */
export interface PrivacyGuardEvents {
  /** 命中黑名单或敏感词时触发（用于 UI 显示"当前应用被跳过"） */
  blocked: (info: { reason: PreCaptureReason; appName: string; windowTitle: string }) => void;
}

/**
 * PrivacyGuard：三重过滤 + 视觉模型后处理
 */
export class PrivacyGuard extends EventEmitter {
  private rules: PrivacyRule[] = [];
  private settingsService: SettingsService | null = null;
  private cachedRulesTimestamp = 0;
  /** 规则缓存有效期（毫秒），默认 60 秒 */
  private static readonly RULES_CACHE_TTL = 60_000;

  /**
   * 注入 SettingsService（用于从 SQLite 加载 privacy_rules）
   */
  setSettingsService(settingsService: SettingsService): void {
    this.settingsService = settingsService;
  }

  /**
   * 重新加载规则缓存
   * - 从 SettingsService.listPrivacyRules 拉取所有启用的规则
   * - 失败时使用默认黑名单和敏感词
   */
  reloadRules(): void {
    if (!this.settingsService) {
      this.rules = [];
      this.cachedRulesTimestamp = Date.now();
      return;
    }
    try {
      this.rules = this.settingsService.listPrivacyRules({ enabled: true });
      this.cachedRulesTimestamp = Date.now();
    } catch {
      // 加载失败时保持现有规则
    }
  }

  /**
   * 设置规则（直接注入，用于测试或跳过 SettingsService）
   */
  setRules(rules: PrivacyRule[]): void {
    this.rules = rules;
    this.cachedRulesTimestamp = Date.now();
  }

  /**
   * 获取当前规则
   */
  getRules(): PrivacyRule[] {
    return this.rules;
  }

  /**
   * 捕获前检查（spec.md 要求的接口）
   *
   * 检查顺序：
   * 1. 用户暂停 -> paused
   * 2. 锁屏 -> locked
   * 3. 默认黑名单应用 -> blacklist_app
   * 4. 用户自定义黑名单应用（type=app_name, action=exclude）-> blacklist_app
   * 5. 默认敏感词 -> sensitive_keyword
   * 6. 用户自定义敏感词（type=window_title_keyword / domain_keyword, action=exclude）-> sensitive_keyword
   *
   * 不应采集场景（来自 07 文档）：
   * - 全屏历史录像（不在此处判断，由 CaptureService 控制）
   * - 黑名单应用 ✓
   * - 密码、支付、银行、证件、医疗等高敏场景 ✓（敏感词）
   * - 用户暂停期间 ✓
   * - 锁屏 ✓
   * - 登录页（"login" 敏感词覆盖）
   */
  checkPreCapture(window: {
    appName: string;
    windowTitle: string;
    urlOrDomain?: string;
  }): PreCaptureCheckResult {
    return this.checkBeforeCapture({
      appName: window.appName,
      windowTitle: window.windowTitle,
      urlOrDomain: window.urlOrDomain,
      isPaused: false,
      isLocked: false,
    });
  }

  /**
   * 完整版捕获前检查（带 isPaused / isLocked 状态）
   */
  checkBeforeCapture(input: PreCaptureInput): PreCaptureCheckResult {
    // 1. 暂停状态
    if (input.isPaused) {
      return { allowed: false, reason: "paused" };
    }

    // 2. 锁屏
    if (input.isLocked) {
      return { allowed: false, reason: "locked" };
    }

    // 检查规则缓存是否过期
    if (Date.now() - this.cachedRulesTimestamp > PrivacyGuard.RULES_CACHE_TTL) {
      this.reloadRules();
    }

    const appNameLower = input.appName.toLowerCase();
    const titleLower = input.windowTitle.toLowerCase();
    const urlLower = (input.urlOrDomain ?? "").toLowerCase();

    // 3. 默认黑名单应用
    for (const bl of DEFAULT_BLACKLIST_APPS) {
      if (appNameLower.includes(bl.toLowerCase())) {
        return {
          allowed: false,
          reason: "blacklist_app",
          matchedPattern: bl,
        };
      }
    }

    // 银行/支付应用（来自 07 文档默认黑名单的中文部分）
    const bankPayKeywords = ["银行", "支付", "bank", "pay"];
    for (const kw of bankPayKeywords) {
      if (appNameLower.includes(kw.toLowerCase())) {
        return {
          allowed: false,
          reason: "blacklist_app",
          matchedPattern: kw,
        };
      }
    }

    // 4. 用户自定义规则（按 type 匹配）
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.action !== "exclude") continue; // MVP 只处理 exclude

      let target = "";
      if (rule.type === "app_name") {
        target = appNameLower;
      } else if (rule.type === "window_title_keyword") {
        target = titleLower;
      } else if (rule.type === "domain_keyword") {
        target = urlLower;
      }

      if (target && target.includes(rule.pattern.toLowerCase())) {
        // 区分原因：app_name -> blacklist_app，其他 -> sensitive_keyword
        const reason: PreCaptureReason =
          rule.type === "app_name" ? "blacklist_app" : "sensitive_keyword";
        return {
          allowed: false,
          reason,
          ruleId: rule.id,
          matchedPattern: rule.pattern,
        };
      }
    }

    // 5. 默认敏感词（中英文，匹配标题和 URL）
    // 注意：appName 已经在前面 blacklist 检查过；这里检查标题/URL
    const textToCheck = `${titleLower} ${urlLower}`;
    for (const kw of DEFAULT_SENSITIVE_KEYWORDS) {
      if (textToCheck.includes(kw.toLowerCase())) {
        return {
          allowed: false,
          reason: "sensitive_keyword",
          matchedPattern: kw,
        };
      }
    }

    return { allowed: true, reason: "ok" };
  }

  /**
   * 兼容旧接口：捕获前检查（返回简化结果）
   */
  check(input: PreCaptureInput): PrivacyCheckResult {
    const result = this.checkBeforeCapture(input);
    if (result.allowed) {
      return { allowed: true };
    }
    const mappedReason: "blacklist" | "sensitive_keyword" | "paused" | "high_sensitive" | "locked" =
      result.reason === "blacklist_app"
        ? "blacklist"
        : result.reason === "sensitive_keyword"
          ? "sensitive_keyword"
          : result.reason === "paused"
            ? "paused"
            : result.reason === "locked"
              ? "locked"
              : "paused";
    return { allowed: false, reason: mappedReason, ruleId: result.ruleId };
  }

  /**
   * 视觉模型返回后检查（spec.md 要求的接口）
   *
   * 策略：
   * - normal: keep（保留 observation 和截图）
   * - possibly_sensitive: keep（保留，但可能在 UI 上做模糊处理，MVP 不实现 blur）
   * - high_sensitive: delete_observation（删除截图，删除 observation 或只保留 blocked event）
   *
   * 来自 07 文档：
   * - 视觉模型返回 high_sensitive：删除截图，删除 observation 或只保留 blocked event
   * - UI 显示"这段内容看起来比较敏感，Recall 没有采集它"
   */
  checkPostVision(sensitivity: "normal" | "possibly_sensitive" | "high_sensitive"): PostVisionCheckResult {
    return this.checkAfterVisionOutput(sensitivity);
  }

  /**
   * 视觉模型返回后处理（保留方法名兼容）
   */
  checkAfterVisionOutput(
    sensitivity: "normal" | "possibly_sensitive" | "high_sensitive"
  ): PostVisionCheckResult {
    if (sensitivity === "high_sensitive") {
      return {
        allowed: false,
        action: "delete_observation",
        sensitivity,
        reason: "vision model marked as high_sensitive",
      };
    }
    // normal 和 possibly_sensitive 都保留（MVP 阶段不实现 blur）
    return {
      allowed: true,
      action: "keep",
      sensitivity,
    };
  }

  /**
   * 判断窗口是否处于"不应采集"场景
   * 用于 ActivityService 在采集前快速过滤
   *
   * 不应采集场景（来自 07 文档）：
   * - 全屏历史录像（不在此处判断）
   * - 黑名单应用 ✓
   * - 密码、支付、银行、证件、医疗等高敏场景 ✓
   * - 用户暂停期间 ✓
   * - 锁屏 ✓
   * - 登录页 ✓
   */
  shouldSkipCapture(input: PreCaptureInput): { skip: boolean; reason: PreCaptureReason } {
    const result = this.checkBeforeCapture(input);
    return {
      skip: !result.allowed,
      reason: result.reason,
    };
  }
}

/**
 * 单例
 */
let _instance: PrivacyGuard | null = null;

export function getPrivacyGuard(): PrivacyGuard {
  if (!_instance) {
    _instance = new PrivacyGuard();
  }
  return _instance;
}
