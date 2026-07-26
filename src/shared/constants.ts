// src/shared/constants.ts
// 跨进程共享常量

/**
 * 应用元信息
 */
export const APP_NAME_ZH = "回声";
export const APP_NAME_EN = "Recall";
export const APP_TAGLINE = "把你电脑前流逝的工作上下文，变成可行动的记忆和提醒";

/**
 * 默认 Vite dev server 端口（与 vite.config.ts 保持一致）
 */
export const DEV_SERVER_PORT = 5173;

/**
 * 截图本地缓存目录名（相对于 %APPDATA%/Recall/）
 */
export const SCREENSHOT_CACHE_DIR = "cache/screenshots";

/**
 * 数据目录名（相对于 %APPDATA%/Recall/），存放 recall.db 与 settings.json
 */
export const DATA_DIR = "data";

/**
 * 数据库文件名（位于 DATA_DIR 下）
 */
export const DATABASE_FILENAME = "recall.db";

/**
 * 应用设置文件名（位于 DATA_DIR 下，不进 SQLite）
 */
export const SETTINGS_FILENAME = "settings.json";

/**
 * API Key 密文文件名（位于 DATA_DIR 下，safeStorage 加密，不进 SQLite）
 */
export const SECRETS_FILENAME = "secrets.json";

/**
 * 旧版 keytar 服务名（key 命名规范：recall:model:<configId>:apiKey）
 * 仅供一次性迁移读取历史条目使用，新写入不再经过 keytar。
 */
export const KEYTAR_SERVICE_PREFIX = "recall";

/**
 * 默认隐私黑名单应用（来自 07_CAPTURE_PRIVACY_SECURITY.md）
 */
export const DEFAULT_BLACKLIST_APPS: string[] = [
  "1Password",
  "Bitwarden",
  "KeePass",
  "Windows Credential Manager",
];

/**
 * 默认敏感词列表（中英）
 */
export const DEFAULT_SENSITIVE_KEYWORDS: string[] = [
  // 英文
  "password",
  "login",
  "bank",
  "pay",
  "wallet",
  "medical",
  "passport",
  "id card",
  "secret",
  "token",
  "api key",
  // 中文
  "密码",
  "登录",
  "支付",
  "银行",
  "钱包",
  "证件",
  "身份证",
  "医疗",
  "病历",
  "私密",
  "密钥",
];

/**
 * 品牌色（来自 08_UI_UX_BRAND_SPEC.md）
 */
export const BRAND_COLORS = {
  background: "#F7F6F2",
  surface: "#FFFFFF",
  textPrimary: "#1E2423",
  textSecondary: "#66706D",
  border: "#E2E0D8",
  accentGreen: "#2F8F83",
  accentAmber: "#D9912B",
  danger: "#C74D3C",
} as const;

/**
 * 圆角与阴影约束
 */
export const DESIGN_TOKENS = {
  radiusCard: "8px",
  radiusButton: "8px",
  radiusPill: "999px",
} as const;
