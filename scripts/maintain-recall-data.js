#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function parseArgs(argv) {
  const options = { apply: false, vacuum: false, dbPath: null, backupPath: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--vacuum") options.vacuum = true;
    else if (arg === "--db") options.dbPath = argv[++index];
    else if (arg === "--backup") options.backupPath = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log([
    "Recall 数据维护（默认 dry-run）",
    "",
    "用法:",
    "  npm run maintain:data",
    "  npm run maintain:data -- --apply",
    "  npm run maintain:data -- --apply --vacuum",
    "",
    "参数:",
    "  --apply             请先退出 Recall；先创建一致性备份，再压缩终态批次并清理历史调试字段",
    "  --vacuum            apply 后执行 VACUUM；请只在 Recall 已退出时使用",
    "  --db <path>         指定 recall.db 路径",
    "  --backup <path>     指定备份路径，目标已存在时命令会拒绝覆盖",
  ].join("\n"));
}

function resolveDefaultDatabasePath({ platform, env, homeDir }) {
  let recallDataRoot;
  if (platform === "win32") {
    const appData = env.APPDATA || path.join(homeDir, "AppData", "Roaming");
    recallDataRoot = path.join(appData, "Recall", "data");
  } else if (platform === "darwin") {
    recallDataRoot = path.join(homeDir, "Library", "Application Support", "Recall", "data");
  } else {
    recallDataRoot = path.join(homeDir, ".config", "Recall", "data");
  }
  return path.join(recallDataRoot, "recall.db");
}

async function main() {
  // 惰性加载：让本模块可在无 dist 构建 / 原生模块的环境下被单测导入。
  const Database = require("better-sqlite3");
  const { runRecallDataMaintenance } = require("../dist/main/db/RecallDataMaintenance.js");

  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const dbPath = path.resolve(options.dbPath || resolveDefaultDatabasePath({
    platform: process.platform,
    env: process.env,
    homeDir: os.homedir(),
  }));
  if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在: ${dbPath}`);
  if (options.vacuum && !options.apply) throw new Error("--vacuum 必须和 --apply 一起使用");

  const db = new Database(dbPath, { readonly: !options.apply, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    const result = runRecallDataMaintenance(db, dbPath, {
      apply: options.apply,
      vacuum: options.vacuum,
      backupPath: options.backupPath ? path.resolve(options.backupPath) : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { resolveDefaultDatabasePath };
