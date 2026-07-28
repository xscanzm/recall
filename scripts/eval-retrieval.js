const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { MemorySearchRepository } = require("../dist/main/db/repositories/MemorySearchRepository");
const { MemoryEmbeddingRepository } = require("../dist/main/db/repositories/MemoryEmbeddingRepository");
const { EmbeddingWorkerClient } = require("../dist/main/services/EmbeddingWorkerClient");
const { EmbeddingIndexerService } = require("../dist/main/services/EmbeddingIndexerService");
const { HybridSearchService } = require("../dist/main/services/HybridSearchService");

const repoRoot = path.join(__dirname, "..");
const migrationsDir = path.join(repoRoot, "src", "main", "db", "migrations");

function migrate(db) {
  for (const name of fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(fs.readFileSync(path.join(migrationsDir, name), "utf8"));
  }
}

function localDayRange(daysAgo) {
  const start = new Date();
  start.setDate(start.getDate() - daysAgo);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function lastWeekRange() {
  const end = new Date();
  const day = end.getDay() || 7;
  end.setDate(end.getDate() - day + 1);
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  return { start: start.toISOString(), end: end.toISOString() };
}

function fixture() {
  const today = localDayRange(0);
  const yesterday = localDayRange(1);
  const lastWeek = lastWeekRange();
  const todayAt = new Date(Date.parse(today.start) + 12 * 60 * 60_000).toISOString();
  const yesterdayAt = new Date(Date.parse(yesterday.start) + 12 * 60 * 60_000).toISOString();
  const lastWeekAt = new Date(Date.parse(lastWeek.start) + 2 * 24 * 60 * 60_000).toISOString();
  const defaultAt = todayAt;

  const records = [
    { id: "PRD-1024", type: "fact", title: "混合检索需求说明", summary: "检索机制与验收标准", kw: "需求文档" },
    { id: "TASK-8888", type: "task", title: "优化分词算法", summary: "处理分词边界", kw: "检索优化" },
    { id: "DECISION-555", type: "decision", title: "确定向量模型选型", summary: "采用 BGE Small 中文模型", kw: "模型选型" },
    { id: "REPORT-2026-07", type: "report", title: "离线评测报告", summary: "七月份评测指标汇总", kw: "评测指标" },
    { id: "PROJ-RECALL", type: "project", title: "回声 Recall 主项目", summary: "桌面记忆助理", kw: "回声" },

    { id: "fact-arch-diag", type: "fact", title: "architecture_diagram_v2.png 架构图", summary: "系统架构高清设计图", kw: "architecture_diagram_v2.png" },
    { id: "report-fin-q2", type: "report", title: "financial_report_q2.pdf 第二季度财报", summary: "财务收支汇总", kw: "financial_report_q2.pdf" },
    { id: "fact-login-flow", type: "fact", title: "user_login_flow.drawio 登录流程", summary: "画板登录逻辑", kw: "user_login_flow.drawio" },
    { id: "fact-deploy-config", type: "fact", title: "deployment_config.yaml 部署配置", summary: "Kubernetes 配置", kw: "deployment_config.yaml" },
    { id: "fact-db-guide", type: "fact", title: "database_migration_guide.docx 数据库迁移", summary: "SQLite migration 指南", kw: "database_migration_guide.docx" },

    { id: "person-zhangsan", type: "person", title: "张三", summary: "Recall 负责人", kw: "三哥 Recall", aliases: ["三哥 Recall"], role: "负责人", organization: "Recall" },
    { id: "person-lisi", type: "person", title: "李四", summary: "前端负责人", kw: "四哥", aliases: ["四哥"], role: "前端负责人" },
    { id: "person-wangwu", type: "person", title: "王五架构师", summary: "首席架构师", kw: "王五 架构", aliases: ["王五架构师"], role: "架构师" },
    { id: "person-zhaoliu", type: "person", title: "赵六 PM", summary: "产品经理", kw: "赵六 PM", aliases: ["赵六 PM"], role: "产品经理" },

    { id: "fact-tdw-settle", type: "fact", title: "TDW 结算逻辑", summary: "处理回款账期与结算", kw: "结算 TDW" },
    { id: "fact-pipi-api-v1", type: "fact", title: "皮皮未来 API 接口文档", summary: "接入说明", kw: "皮皮 API" },
    { id: "task-refactor-search", type: "task", title: "重构 Search 索引通道", summary: "代码重构", kw: "重构" },

    { id: "task-today-review", type: "task", title: "任务复盘", summary: "本日完成任务列表", kw: "今日复盘", createdAt: todayAt },
    { id: "decision-yesterday-arch", type: "decision", title: "架构评审决定", summary: "昨日确定的方案", kw: "架构决策", createdAt: yesterdayAt },
    { id: "report-lastweek", type: "report", title: "运维总结报告", summary: "上周运行情况", kw: "运维报告", createdAt: lastWeekAt },
    { id: "fact-trigram-doc", type: "fact", title: "trigram 索引配置资料", summary: "FTS5 详细参数", kw: "trigram" },

    { id: "fact-payment-dispute", type: "fact", title: "回款账期争议与延期收支", summary: "财务对账开票沟通记录", kw: "对账 账期" },
    { id: "fact-conn-instability", type: "fact", title: "链路高丢包与超时故障", summary: "TCP 报文重传诊断", kw: "丢包 超时" },
    { id: "fact-perf-bottleneck", type: "fact", title: "渲染线程卡顿与 UI 延迟", summary: "DOM 节点重绘瓶颈", kw: "延迟 瓶颈" },
    { id: "fact-legacy-upgrade", type: "fact", title: "重构过渡演进方案", summary: "软件构架重写与替换", kw: "构架 演进" },
    { id: "task-urgent-deadline", type: "task", title: "高优先级任务倒计时里程碑", summary: "项目节点紧急安排", kw: "节点 里程碑" },

    { id: "fact-tdw-1", type: "fact", title: "TDW 1.0 结算系统文档", summary: "旧版 TDW 结算模块说明", kw: "TDW 1.0 结算" },
    { id: "fact-tdw-2", type: "fact", title: "TDW 2.0 数据平台设计", summary: "新版 TDW 实时流计算架构", kw: "TDW 2.0 数据" },
    { id: "fact-pipi-v1", type: "fact", title: "皮皮未来 API v1 基础版", summary: "旧版 REST 接口", kw: "皮皮 v1" },
    { id: "fact-pipi-v2", type: "fact", title: "皮皮未来 API v2 开放接口", summary: "新版 GraphQL 开放平台", kw: "皮皮 v2" },
    { id: "proj-recall-desktop", type: "project", title: "Recall 桌面版客户端", summary: "Electron 桌面端", kw: "Recall 桌面版", aliases: ["Recall 桌面版"] },
    { id: "proj-recall-web", type: "project", title: "Recall Web 版轻量端", summary: "浏览器 Web 应用程序", kw: "Recall Web 版", aliases: ["Recall Web 版"] },
    { id: "person-zhangsan-dev", type: "person", title: "张三 研发工程师", summary: "后端 Dev", kw: "张三 Dev", aliases: ["张三工程师"], role: "研发工程师", organization: "研发部" },
    { id: "person-zhangsan-pm", type: "person", title: "张三 产品经理", summary: "产品 PM", kw: "张三 PM", aliases: ["张三产品经理"], role: "产品经理", organization: "产品部" },
    { id: "fact-mysql-8", type: "fact", title: "MySQL 8.0 性能调优实战", summary: "InnoDB 优化", kw: "MySQL 8.0" },
    { id: "fact-mysql-57", type: "fact", title: "MySQL 5.7 迁移注意与兼容", summary: "版本升级注意事项", kw: "MySQL 5.7" },
    { id: "fact-gpt4o", type: "fact", title: "OpenAI GPT-4o 接口调用指南", summary: "多模态 API", kw: "GPT-4o API" },
    { id: "fact-gpt35", type: "fact", title: "OpenAI GPT-3.5 降级方案与备用", summary: "备用模型配置", kw: "GPT-3.5 降级" },
  ].map((record) => ({ ...record, createdAt: record.createdAt ?? defaultAt }));

  const cases = [
    { query: "PRD-1024", category: "exact_id", targetId: "PRD-1024" },
    { query: "TASK-8888", category: "exact_id", targetId: "TASK-8888" },
    { query: "DECISION-555", category: "exact_id", targetId: "DECISION-555" },
    { query: "REPORT-2026-07", category: "exact_id", targetId: "REPORT-2026-07" },
    { query: "PROJ-RECALL", category: "exact_id", targetId: "PROJ-RECALL" },
    { query: "architecture_diagram_v2.png", category: "filename", targetId: "fact-arch-diag" },
    { query: "financial_report_q2.pdf", category: "filename", targetId: "report-fin-q2" },
    { query: "user_login_flow.drawio", category: "filename", targetId: "fact-login-flow" },
    { query: "deployment_config.yaml", category: "filename", targetId: "fact-deploy-config" },
    { query: "database_migration_guide.docx", category: "filename", targetId: "fact-db-guide" },
    { query: "张三", category: "person_name", targetId: "person-zhangsan" },
    { query: "李四", category: "person_name", targetId: "person-lisi" },
    { query: "王五架构师", category: "person_name", targetId: "person-wangwu" },
    { query: "三哥 Recall", category: "person_name", targetId: "person-zhangsan" },
    { query: "赵六 PM", category: "person_name", targetId: "person-zhaoliu" },
    { query: "回声", category: "two_char_zh", targetId: "PROJ-RECALL" },
    { query: "结算", category: "two_char_zh", targetId: "fact-tdw-settle" },
    { query: "皮皮", category: "two_char_zh", targetId: "fact-pipi-api-v1" },
    { query: "架构", category: "two_char_zh", targetId: "person-wangwu" },
    { query: "重构", category: "two_char_zh", targetId: "task-refactor-search" },
    { query: "今天 任务", category: "filter", targetId: "task-today-review", filters: { type: "task", timeFrom: today.start, timeTo: today.end } },
    { query: "昨天 决策", category: "filter", targetId: "decision-yesterday-arch", filters: { type: "decision", timeFrom: yesterday.start, timeTo: yesterday.end } },
    { query: "上周 报告", category: "filter", targetId: "report-lastweek", filters: { type: "report", timeFrom: lastWeek.start, timeTo: lastWeek.end } },
    { query: "项目 回声", category: "filter", targetId: "PROJ-RECALL", filters: { type: "project", projectId: "PROJ-RECALL" } },
    { query: "资料 trigram", category: "filter", targetId: "fact-trigram-doc", filters: { type: "fact" } },
    { query: "结算拖了很久", category: "semantic_zero_overlap", targetId: "fact-payment-dispute" },
    { query: "网络不好频繁挂掉", category: "semantic_zero_overlap", targetId: "fact-conn-instability" },
    { query: "跑得太慢卡死掉帧", category: "semantic_zero_overlap", targetId: "fact-perf-bottleneck" },
    { query: "老系统迁移新版本", category: "semantic_zero_overlap", targetId: "fact-legacy-upgrade" },
    { query: "老板要求下周完成", category: "semantic_zero_overlap", targetId: "task-urgent-deadline" },
    { query: "TDW 1.0 结算系统", category: "hard_negative", targetId: "fact-tdw-1", negativeIds: ["fact-tdw-2"] },
    { query: "TDW 2.0 数据平台", category: "hard_negative", targetId: "fact-tdw-2", negativeIds: ["fact-tdw-1"] },
    { query: "皮皮未来 API v1", category: "hard_negative", targetId: "fact-pipi-v1", negativeIds: ["fact-pipi-v2"] },
    { query: "皮皮未来 API v2 开放接口", category: "hard_negative", targetId: "fact-pipi-v2", negativeIds: ["fact-pipi-v1"] },
    { query: "Recall 桌面版", category: "hard_negative", targetId: "proj-recall-desktop", negativeIds: ["proj-recall-web"] },
    { query: "Recall Web 版", category: "hard_negative", targetId: "proj-recall-web", negativeIds: ["proj-recall-desktop"] },
    { query: "张三 工程师", category: "hard_negative", targetId: "person-zhangsan-dev", negativeIds: ["person-zhangsan-pm"] },
    { query: "张三 产品经理", category: "hard_negative", targetId: "person-zhangsan-pm", negativeIds: ["person-zhangsan-dev"] },
    { query: "MySQL 8.0 性能调优", category: "hard_negative", targetId: "fact-mysql-8", negativeIds: ["fact-mysql-57"] },
    { query: "MySQL 5.7 迁移注意", category: "hard_negative", targetId: "fact-mysql-57", negativeIds: ["fact-mysql-8"] },
    { query: "OpenAI GPT-4o 接口", category: "hard_negative", targetId: "fact-gpt4o", negativeIds: ["fact-gpt35"] },
    { query: "OpenAI GPT-3.5 降级方案", category: "hard_negative", targetId: "fact-gpt35", negativeIds: ["fact-gpt4o"] },
  ];
  return { records, cases };
}

function seedRecord(db, record) {
  const aliases = JSON.stringify(record.aliases ?? (record.kw ? [record.kw] : []));
  const tags = JSON.stringify(record.kw ? [record.kw] : []);
  const common = { created: record.createdAt, updated: record.createdAt };
  switch (record.type) {
    case "fact":
      db.prepare(`INSERT INTO facts
        (id,type,content,evidence_text,project_id,importance,confidence,inferred,source_observation_ids_json,tags_json,created_at,updated_at)
        VALUES (?,?,?,?,?,1,1,0,'[]',?,?,?)`)
        .run(record.id, "note", record.title, record.summary, record.projectId ?? null, tags, common.created, common.updated);
      break;
    case "task":
      db.prepare(`INSERT INTO tasks
        (id,title,status,project_id,summary,due_hint,priority,confidence,source_fact_ids_json,created_at,updated_at)
        VALUES (?,?,'pending',?,?,?,1,1,'[]',?,?)`)
        .run(record.id, record.title, record.projectId ?? null, record.summary, record.kw, common.created, common.updated);
      break;
    case "project":
      db.prepare(`INSERT INTO projects
        (id,name,summary,status,source_fact_ids_json,source_scene_ids_json,aliases_json,created_at,updated_at)
        VALUES (?,?,?,'active','[]','[]',?,?,?)`)
        .run(record.id, record.title, record.summary, aliases, common.created, common.updated);
      break;
    case "decision":
      db.prepare(`INSERT INTO decisions
        (id,title,decision,rationale,project_id,confidence,source_fact_ids_json,created_at,updated_at)
        VALUES (?,?,?,?,?,1,'[]',?,?)`)
        .run(record.id, record.title, record.summary, record.kw, record.projectId ?? null, common.created, common.updated);
      break;
    case "person":
      db.prepare(`INSERT INTO people
        (id,name,role,organization,summary,related_project_ids_json,source_fact_ids_json,aliases_json,created_at,updated_at)
        VALUES (?,?,?,?,?,'[]','[]',?,?,?)`)
        .run(record.id, record.title, record.role ?? null, record.organization ?? null, record.summary, aliases, common.created, common.updated);
      break;
    case "report":
      db.prepare(`INSERT INTO reports
        (id,type,date_key,title,content_json,source_fact_ids_json,source_scene_ids_json,project_id,created_at,updated_at)
        VALUES (?,'daily',?,?,?,'[]','[]',?,?,?)`)
        .run(record.id, record.createdAt.slice(0, 10), record.title, JSON.stringify({ summary: record.summary, keywords: record.kw }), record.projectId ?? null, common.created, common.updated);
      break;
    default:
      throw new Error(`Unsupported fixture type: ${record.type}`);
  }
}

async function waitFor(check, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

async function measure(cases, search) {
  const metrics = {
    hit1: 0, hit10: 0, reciprocalRank: 0, ndcg10: 0,
    semanticHits: 0, hardNegativeErrors: 0, latencies: [], resultsByCase: [],
  };
  for (const testCase of cases) {
    const started = performance.now();
    const response = await search(testCase);
    metrics.latencies.push(performance.now() - started);
    const rank = response.results.findIndex((item) => item.id === testCase.targetId);
    if (rank === 0) metrics.hit1++;
    if (rank >= 0 && rank < 10) {
      metrics.hit10++;
      metrics.reciprocalRank += 1 / (rank + 1);
      metrics.ndcg10 += 1 / Math.log2(rank + 2);
      if (testCase.category === "semantic_zero_overlap") metrics.semanticHits++;
    }
    if (testCase.negativeIds?.includes(response.results[0]?.id)) metrics.hardNegativeErrors++;
    metrics.resultsByCase.push({ testCase, response, rank });
  }
  return metrics;
}

function printMetrics(label, metrics, total) {
  console.log(`${label}: Recall@10=${(metrics.hit10 / total * 100).toFixed(1)}%, Hit@1=${(metrics.hit1 / total * 100).toFixed(1)}%, MRR=${(metrics.reciprocalRank / total).toFixed(4)}, nDCG@10=${(metrics.ndcg10 / total).toFixed(4)}, P50=${percentile(metrics.latencies, 0.5).toFixed(1)}ms, P95=${percentile(metrics.latencies, 0.95).toFixed(1)}ms`);
}

function makeDiverseVector(seed, queryVector) {
  let state = (seed + 1) * 2654435761 >>> 0;
  const vector = new Float32Array(512);
  let norm = 0;
  for (let index = 0; index < vector.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const noise = ((state >>> 0) / 0xffffffff) * 2 - 1;
    const value = seed < 256 ? queryVector[index] * 0.65 + noise * 0.35 : noise;
    vector[index] = value;
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  for (let index = 0; index < vector.length; index++) vector[index] /= norm;
  return vector;
}

async function runScaleBenchmark(workerClient) {
  const db = new Database(":memory:");
  migrate(db);
  const embeddingRepo = new MemoryEmbeddingRepository(db);
  const searchRepo = new MemorySearchRepository(db);
  const hybrid = new HybridSearchService(searchRepo, embeddingRepo, workerClient, { timeoutMs: 15_000 });
  const query = "规模向量检索基准";
  const queryVector = new Float32Array((await workerClient.embed([query], true, 15_000))[0]);
  const insertFts = db.prepare("INSERT INTO memory_search_fts VALUES (?, 'fact', ?, ?, '', ?, NULL, NULL, NULL)");
  const fixtureStarted = performance.now();
  db.transaction(() => {
    for (let index = 0; index < 35_000; index++) {
      const id = `fact-scale-${index}`;
      insertFts.run(id, `Scale memory object ${index}`, `Diverse synthetic vector ${index}`, "2026-07-28T00:00:00.000Z");
      embeddingRepo.upsertVector("fact", id, makeDiverseVector(index, queryVector), `scale-${index}`);
    }
  })();
  const fixtureMs = performance.now() - fixtureStarted;
  const beforeRss = process.memoryUsage().rss;
  await hybrid.search(query, 20, 0);
  const latencies = [];
  let lastResponse;
  for (let run = 0; run < 5; run++) {
    const started = performance.now();
    lastResponse = await hybrid.search(query, 20, 0);
    latencies.push(performance.now() - started);
  }
  const rssDeltaMb = (process.memoryUsage().rss - beforeRss) / 1024 / 1024;
  assert(lastResponse.results.some((item) => item.matchReasons.includes("semantic_similarity")), "35k benchmark must execute the production vector channel");
  console.log(`35k diverse-vector production search: fixture=${fixtureMs.toFixed(0)}ms, P50=${percentile(latencies, 0.5).toFixed(1)}ms, P95=${percentile(latencies, 0.95).toFixed(1)}ms, RSS delta=${rssDeltaMb.toFixed(1)}MB, runs=5`);
  db.close();
}

async function main() {
  const { records, cases } = fixture();
  const db = new Database(":memory:");
  const workerClient = new EmbeddingWorkerClient();
  try {
    migrate(db);
    db.transaction(() => records.forEach((record) => seedRecord(db, record)))();
    assert.equal(db.prepare("SELECT COUNT(*) count FROM memory_embedding_queue").get().count, records.length);

    const embeddingRepo = new MemoryEmbeddingRepository(db);
    const indexer = new EmbeddingIndexerService(db, embeddingRepo, workerClient);
    indexer.startBackgroundIndexing();
    await waitFor(
      () => db.prepare("SELECT COUNT(*) count FROM memory_embedding_queue").get().count === 0,
      "production embedding indexer queue drain",
    );
    await indexer.stopAndDrain();
    assert.equal(embeddingRepo.listVectors().length, records.length);

    const searchRepo = new MemorySearchRepository(db);
    const hybrid = new HybridSearchService(searchRepo, embeddingRepo, workerClient, { timeoutMs: 15_000 });
    const lexical = await measure(cases, (testCase) => searchRepo.search(testCase.query, 50, 0, testCase.filters ?? {}));
    const hybridMetrics = await measure(cases, (testCase) => hybrid.search(testCase.query, 50, 0, testCase.filters ?? {}));

    const zeroOverlapCount = cases.filter((item) => item.category === "semantic_zero_overlap").length;
    const hardNegativeCount = cases.filter((item) => item.category === "hard_negative").length;
    const exactIdFailures = lexical.resultsByCase.filter(({ testCase, rank }) => testCase.category === "exact_id" && rank !== 0);
    assert.equal(exactIdFailures.length, 0, "all exact object IDs must rank first through the independent lexical channel");
    assert.equal(hybridMetrics.semanticHits, zeroOverlapCount, "all zero-overlap semantic cases must be recalled in the top 10");
    assert(hybridMetrics.hit10 >= lexical.hit10, "hybrid Recall@10 must not regress below the lexical baseline");
    assert(hybridMetrics.hardNegativeErrors <= lexical.hardNegativeErrors, "hybrid hard-negative top-1 errors must not exceed lexical errors");

    console.log("Recall production-path retrieval evaluation");
    console.log(`Fixture: ${records.length} sanitized structured objects, ${cases.length} queries, ${zeroOverlapCount} zero-overlap semantic cases, ${hardNegativeCount} hard negatives`);
    printMetrics("Lexical production repository", lexical, cases.length);
    printMetrics("Hybrid production service", hybridMetrics, cases.length);
    console.log(`Semantic zero-overlap Recall@10: lexical=${lexical.semanticHits}/${zeroOverlapCount}, hybrid=${hybridMetrics.semanticHits}/${zeroOverlapCount}`);
    console.log(`Hard-negative top-1 errors: lexical=${lexical.hardNegativeErrors}/${hardNegativeCount}, hybrid=${hybridMetrics.hardNegativeErrors}/${hardNegativeCount}`);
    console.log("Acceptance assertions passed: exact IDs, semantic recall, no Recall@10 regression, no hard-negative regression.");

    await runScaleBenchmark(workerClient);
  } finally {
    workerClient.close();
    db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
