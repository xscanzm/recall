// src/main/db/Database.ts
// SQLite 数据库管理（来自 04、06 文档）
//
// 职责：
// - 首次启动时自动创建 SQLite 数据库（位于 %APPDATA%/Recall/data/recall.db）
// - 按顺序执行 migrations
// - 首次建库后插入默认隐私规则
// - 提供 Database 实例（better-sqlite3）
//
// 重要约束：
// - SQLite 读写只在 main 进程
// - API Key 不进 SQLite
// - migration 失败时不允许进入观察状态（抛错阻断）
// - better-sqlite3 串行写入（同步 API）

import Database from "better-sqlite3";
import { app } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import { logger } from "../services/Logger";
import {
  DATABASE_FILENAME,
  DATA_DIR,
  DEFAULT_BLACKLIST_APPS,
  DEFAULT_SENSITIVE_KEYWORDS,
} from "../../shared/constants";

export type DB = Database.Database;

/**
 * migrations 元表名（记录已执行的 migration 版本）
 */
const MIGRATIONS_TABLE = "_migrations";

/**
 * 撞锁等待窗口（毫秒）
 * 超过后仍抛 SQLITE_BUSY，避免无限期挂住调用方。
 */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * 迁移前备份保留份数
 * 备份是完整库拷贝（VACUUM INTO），重度用户单份可达数百 MB，
 * 跨多个版本升级会累积成串，因此只保留最近若干份。
 */
const MIGRATION_BACKUP_KEEP = 2;

let dbInstance: DB | null = null;

/**
 * 获取数据库实例（单例）
 * 首次调用时打开数据库并执行 migrations
 *
 * 有待执行 migration 时先创建一致性备份；任何 migration 失败都保留原库并阻止启动。
 */
export function getDatabase(): DB {
  if (dbInstance) {
    return dbInstance;
  }
  dbInstance = openDatabase();
  try {
    runMigrations(dbInstance);
  } catch (err) {
    try { dbInstance.close(); } catch { /* preserve the migration error */ }
    dbInstance = null;
    throw err;
  }
  // 迁移成功后再清理历史备份：迁移失败时保留全部备份用于人工恢复。
  pruneMigrationBackups();
  seedDefaultPrivacyRules(dbInstance);
  return dbInstance;
}

/**
 * 清理历史迁移备份，只保留最近 MIGRATION_BACKUP_KEEP 份
 *
 * 每次有待执行 migration 都会 VACUUM INTO 一份完整库拷贝，跨版本升级会累积。
 * 备份文件名内嵌 ISO 时间戳（冒号/点替换为短横），按名排序即按时间排序。
 * 清理失败不影响启动。
 */
export function pruneMigrationBackups(): void {
  try {
    const dataDir = path.join(app.getPath("userData"), DATA_DIR);
    const prefix = `${DATABASE_FILENAME}.pre-migration.`;
    const backups = fs
      .readdirSync(dataDir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".bak"))
      .sort();

    const stale = backups.slice(0, Math.max(0, backups.length - MIGRATION_BACKUP_KEEP));
    for (const name of stale) {
      try {
        fs.rmSync(path.join(dataDir, name), { force: true });
        logger.info({ message: `已清理过期迁移备份: ${name}` });
      } catch (err) {
        logger.warn({
          message: `清理迁移备份失败 ${name}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  } catch {
    // 目录不存在或不可读时跳过；备份清理不是启动关键路径。
  }
}

function openDatabase(): DB {
  const userData = app.getPath("userData");
  const dataDir = path.join(userData, DATA_DIR);

  // 确保数据目录存在
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, DATABASE_FILENAME);
  const db = new Database(dbPath);

  // 启用 WAL 模式提升并发读性能；启用外键约束
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // WAL 下写事务仍互斥，而本应用有多个并发写入方（BatchProcessor /
  // TimelineWindowCoordinator / ReportScheduler / ProjectionInvalidationProcessor /
  // ScreenshotCacheScheduler / 准入后台重评）。默认 busy_timeout=0 会让撞锁的写
  // 立即抛 SQLITE_BUSY；给出等待窗口让 better-sqlite3 自行重试。
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

  return db;
}

/**
 * 执行 migrations
 * 顺序执行 migrations 目录下的 .sql 文件
 * 失败时抛错，阻止应用进入观察状态
 */
export function runMigrations(db: DB): void {
  // 1. 确保 _migrations 元表存在
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version TEXT PRIMARY KEY,
      executed_at TEXT NOT NULL
    );
  `);

  // 2. 读取已执行的版本
  const executedRows = db
    .prepare(`SELECT version FROM ${MIGRATIONS_TABLE}`)
    .all() as Array<{ version: string }>;
  const executed = new Set(executedRows.map((r) => r.version));

  // 3. 扫描 migrations 目录
  const migrationsDir = resolveMigrationsDir();
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`migrations 目录不存在: ${migrationsDir}`);
  }

  const sqlFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (sqlFiles.length === 0) {
    throw new Error("migrations 目录为空，未找到任何 .sql 文件");
  }

  const pending = sqlFiles.filter((file) => !executed.has(file));
  let backupPath: string | null = null;
  const existingBusinessTables = (db.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> ?"
  ).get(MIGRATIONS_TABLE) as { count: number }).count;
  if (pending.length > 0 && existingBusinessTables > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(app.getPath("userData"), DATA_DIR, `${DATABASE_FILENAME}.pre-migration.${stamp}.bak`);
    try {
      db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      logger.info({ message: `数据库迁移前备份已创建: ${backupPath}` });
    } catch (err) {
      throw new Error(`迁移前一致性备份失败（未执行 migration）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4. 按序执行未执行的 migration（每个文件一个事务）
  for (const file of sqlFiles) {
    if (executed.has(file)) {
      continue;
    }
    const sqlPath = path.join(migrationsDir, file);
    const sqlContent = fs.readFileSync(sqlPath, "utf-8");

    const txn = db.transaction(() => {
      db.exec(sqlContent);
      db.prepare(
        `INSERT INTO ${MIGRATIONS_TABLE} (version, executed_at) VALUES (?, ?)`
      ).run(file, new Date().toISOString());
    });

    try {
      txn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 历史 schema 漂移防护：当 migration 因列/表已存在失败时（如旧版手动建表后未登记到 _migrations），
      // 备份当前 db 并从头重跑 migrations。旧数据以 .bak 形式保留，但不加载到主程序。
      throw new Error(`migration ${file} 执行失败（原库保留，备份: ${backupPath ?? "首次建库无历史数据"}）: ${msg}`);
    }
  }
}

/**
 * 判定 migration 失败是否由历史 schema 漂移引起。
 * SQLite 的 "duplicate column name: X" / "table X already exists" 即典型表现。
 */
/**
 * 解析 migrations 目录路径
 * - 开发模式：从 dist/main/db/ 指向 src/main/db/migrations/
 * - 打包模式：从 dist/main/db/ 指向同目录 migrations/
 */
function resolveMigrationsDir(): string {
  if (app.isPackaged) {
    return path.join(__dirname, "migrations");
  }
  // 开发模式：__dirname = dist/main/db/
  // 回到项目根：../../../  => dist/main/db -> dist/main -> dist -> <root>
  return path.join(
    __dirname,
    "..",
    "..",
    "..",
    "src",
    "main",
    "db",
    "migrations"
  );
}

/**
 * 首次建库时插入默认隐私规则
 * - 黑名单应用（app_name, exclude）
 * - 敏感词（window_title_keyword, exclude）
 * 仅在 privacy_rules 表为空时执行（幂等）
 */
function seedDefaultPrivacyRules(db: DB): void {
  const countRow = db
    .prepare("SELECT COUNT(*) as cnt FROM privacy_rules")
    .get() as { cnt: number };

  if (countRow.cnt > 0) {
    return; // 已有规则，跳过
  }

  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO privacy_rules (id, type, pattern, action, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const insertMany = db.transaction((rules: Array<{
    id: string;
    type: string;
    pattern: string;
    action: string;
  }>) => {
    for (const rule of rules) {
      insert.run(rule.id, rule.type, rule.pattern, rule.action, 1, now, now);
    }
  });

  const rules: Array<{
    id: string;
    type: string;
    pattern: string;
    action: string;
  }> = [];

  // 默认黑名单应用（app_name 类型，精确匹配）
  for (const appName of DEFAULT_BLACKLIST_APPS) {
    rules.push({
      id: `rule_app_${slugify(appName)}`,
      type: "app_name",
      pattern: appName,
      action: "exclude",
    });
  }

  // 银行/支付应用（app_name 类型）
  for (const appName of ["银行", "支付"]) {
    rules.push({
      id: `rule_app_${slugify(appName)}`,
      type: "app_name",
      pattern: appName,
      action: "exclude",
    });
  }

  // 默认敏感词（window_title_keyword 类型，关键词匹配）
  for (const keyword of DEFAULT_SENSITIVE_KEYWORDS) {
    rules.push({
      id: `rule_kw_${slugify(keyword)}`,
      type: "window_title_keyword",
      pattern: keyword,
      action: "exclude",
    });
  }

  insertMany(rules);
}

/**
 * 简单 slug 化（仅用于生成规则 id，不要求严格唯一性）
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/**
 * 关闭数据库（应用退出前调用）
 */
export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
