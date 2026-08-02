// src/renderer/pages/DebugPage.tsx
// 调试页：展示模型调用记录、丢弃事件、落库对比
//
// 仅当 settings.debug.enabled=true 时可访问（AppShell 条件渲染导航入口）
// 数据源：model_jobs 表（通过 debug:* IPC 查询，手动刷新）

import { useEffect, useState, useMemo, useRef } from "react";
import { useAppStore, type DebugEventItem } from "../state/store";
import { useFocusTrap } from "../hooks/useFocusTrap";

function parseDebugEvents(json: string | null): DebugEventItem[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as DebugEventItem[]) : [];
  } catch {
    return [];
  }
}

function formatJsonString(json: string | null): string {
  if (!json) return "(空)";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

function summarizeError(message: string): string {
  return message.length > 80 ? `${message.slice(0, 80)}…` : message;
}

function formatDateTimeLocalValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 16);
}

function parseDateTimeLocalValue(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

// ============================================================================
// OCR / 图片数解析辅助
// ============================================================================

/** observer_* 类型的 job type（这些任务会提交图片给多模态模型） */
const L0_JOB_TYPES = new Set([
  "observer_extractor",
  "observer_extractor_batch",
  "observer_batch",
]);

/** 是否为 L0（观察类）任务 */
function isL0JobType(type: string): boolean {
  return L0_JOB_TYPES.has(type);
}

/**
 * 从 inputJson（脱敏输入摘要）解析该任务提交的图片数。
 * - observer_extractor（单帧）：imageCount
 * - observer_batch / observer_extractor_batch（批次）：frameCount
 * - 其他类型：0
 */
function parseImageCountFromInput(inputJson: string, type: string): number {
  if (!inputJson || !isL0JobType(type)) return 0;
  try {
    const parsed = JSON.parse(inputJson) as Record<string, unknown>;
    const frameCount = typeof parsed.frameCount === "number" ? parsed.frameCount : 0;
    if (frameCount > 0) return frameCount;
    const imageCount = typeof parsed.imageCount === "number" ? parsed.imageCount : 0;
    return imageCount;
  } catch {
    return 0;
  }
}

interface OcrFrameEvidence {
  frameIndex: number;
  available: boolean;
  language?: string;
  text: string;
}

/**
 * 从 rawInputJson（完整 prompt 上下文）中解析 OCR 帧证据数组。
 *
 * rawInputJson 结构（来自 ModelGateway.buildRawInputJsonForDebug）：
 *   [{ role: "user", content: "...prompt 文本含 frames_ocr_json 块..." }, ...]
 *
 * OCR 证据块格式（来自 BatchOcrEvidence.buildBatchOcrEvidenceJson）：
 *   [
 *     { "frameIndex": 1, "source": "rapidocr_original_image", "available": true, "engine": "rapidocr", "model": "PP-OCRv6-small", "text": "..." },
 *     ...
 *   ]
 *
 * 解析策略：
 * 1. JSON.parse(rawInputJson)，遍历 messages 找到 user 的 content 字符串
 * 2. 在 content 中定位 "[\n  {\n    \"frameIndex\"" 开头的 JSON 数组片段
 * 3. 截取并 JSON.parse 该片段
 *
 * 失败时返回空数组（不阻断 UI）。
 */
function parseOcrFramesFromRawInput(rawInputJson: string | null): OcrFrameEvidence[] {
  if (!rawInputJson) return [];
  try {
    const messages = JSON.parse(rawInputJson);
    if (!Array.isArray(messages)) return [];
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;
      const role = (msg as Record<string, unknown>).role;
      if (role !== "user") continue;
      const content = (msg as Record<string, unknown>).content;
      if (typeof content !== "string") continue;
      const frames = extractOcrFramesFromPrompt(content);
      if (frames.length > 0) return frames;
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * 从 prompt 文本中提取 OCR 帧 JSON 数组。
 * 定位策略：找第一个 `"frameIndex"` 出现的位置，向前回溯找最近的 `[`，
 * 然后用括号配平找到匹配的 `]`。
 */
function extractOcrFramesFromPrompt(promptText: string): OcrFrameEvidence[] {
  const keyIndex = promptText.indexOf('"frameIndex"');
  if (keyIndex < 0) return [];
  const arrayStart = promptText.lastIndexOf("[", keyIndex);
  if (arrayStart < 0) return [];

  let depth = 0;
  let inString = false;
  let escape = false;
  let arrayEnd = -1;
  for (let i = arrayStart; i < promptText.length; i++) {
    const ch = promptText[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) { arrayEnd = i; break; }
    }
  }
  if (arrayEnd < 0) return [];

  const jsonText = promptText.slice(arrayStart, arrayEnd + 1);
  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => ({
        frameIndex: typeof item.frameIndex === "number" ? item.frameIndex : 0,
        available: item.available === true,
        language: typeof item.language === "string" ? item.language : undefined,
        text: typeof item.text === "string" ? item.text : "",
      }));
  } catch {
    return [];
  }
}

const LAYER_LABELS: Record<string, string> = {
  L0: "L0 观察",
  L1: "L1 线索",
  L2: "L2 工作片段",
  L3: "L3 记忆对象",
  proactive: "提醒",
};

const JOB_TYPE_LABELS: Record<string, string> = {
  observer: "观察提取（旧）",
  observer_extractor: "观察提取（单帧）",
  observer_extractor_batch: "观察提取（批次 L0+L1）",
  observer_batch: "观察提取（批次 L0）",
  episode_fact_extractor: "Episode+Fact 提取",
  extractor: "事实提取（旧）",
  linker: "关联（旧）",
  scene_builder: "场景构建（旧）",
  judge: "判断（旧）",
  linker_scene_judge: "关联+场景+判断",
  timeline_builder: "时间轴构建",
  reporter: "报告生成",
  personal_review: "个人复盘",
  memory_ask: "轻量问答",
  memory_search_expand: "记忆搜索扩展",
  batch_pipeline: "批处理管道",
};

/**
 * 筛选下拉框的分组选项 id
 * - "all"：全部
 * - "observer_all"：所有 observer_* 开头的 L0 任务（含旧 observer）
 * - 其他具体 type：精确匹配
 */
function matchesJobTypeFilter(type: string, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "observer_all") {
    return type === "observer"
      || type === "observer_extractor"
      || type === "observer_extractor_batch"
      || type === "observer_batch";
  }
  return type === filter;
}

export function DebugPage() {
  const debugJobs = useAppStore((s) => s.debugJobs);
  const debugJobsLoading = useAppStore((s) => s.debugJobsLoading);
  const debugJobsError = useAppStore((s) => s.debugJobsError);
  const debugJobDetails = useAppStore((s) => s.debugJobDetails);
  const debugJobDetailsLoading = useAppStore((s) => s.debugJobDetailsLoading);
  const debugRelatedRecords = useAppStore((s) => s.debugRelatedRecords);
  const debugRelatedRecordsLoading = useAppStore((s) => s.debugRelatedRecordsLoading);
  const debugFilters = useAppStore((s) => s.debugFilters);
  const loadDebugJobs = useAppStore((s) => s.loadDebugJobs);
  const loadDebugJobDetails = useAppStore((s) => s.loadDebugJobDetails);
  const loadDebugRelatedRecords = useAppStore((s) => s.loadDebugRelatedRecords);
  const setDebugFilters = useAppStore((s) => s.setDebugFilters);
  const clearDebugState = useAppStore((s) => s.clearDebugState);

  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"output" | "input" | "records" | "events" | "ocr">("output");

  useEffect(() => {
    void loadDebugJobs();
    return () => {
      clearDebugState();
    };
  }, [loadDebugJobs, clearDebugState]);

  useEffect(() => {
    if (selectedJobId) {
      void loadDebugJobDetails(selectedJobId);
    }
  }, [selectedJobId, loadDebugJobDetails]);

  useEffect(() => {
    if (debugJobDetails) {
      void loadDebugRelatedRecords(debugJobDetails.createdAt);
    }
  }, [debugJobDetails, loadDebugRelatedRecords]);

  const filteredJobs = useMemo(() => {
    if (!debugJobs) return [];
    return debugJobs.filter((j) => {
      if (!matchesJobTypeFilter(j.type, debugFilters.jobType)) return false;
      if (debugFilters.status !== "all" && j.status !== debugFilters.status) return false;
      return true;
    });
  }, [debugJobs, debugFilters.jobType, debugFilters.status]);

  // 为每个 job 预解析图片数（用于列表展示和统计）
  const jobImageCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const job of filteredJobs) {
      map.set(job.id, parseImageCountFromInput(job.inputJson, job.type));
    }
    return map;
  }, [filteredJobs]);

  const stats = useMemo(() => {
    const total = filteredJobs.length;
    const succeeded = filteredJobs.filter((j) => j.status === "succeeded").length;
    const failed = filteredJobs.filter((j) => j.status === "failed").length;
    const running = filteredJobs.filter((j) => j.status === "running").length;
    const totalDiscardEvents = filteredJobs.reduce((sum, j) => sum + j.debugEventCount, 0);
    // L0 / OCR 统计：只统计 observer_* 任务
    const l0Jobs = filteredJobs.filter((j) => isL0JobType(j.type));
    const l0CallCount = l0Jobs.length;
    const totalImages = l0Jobs.reduce(
      (sum, j) => sum + (jobImageCounts.get(j.id) ?? 0),
      0
    );
    return {
      total,
      succeeded,
      failed,
      running,
      totalDiscardEvents,
      l0CallCount,
      totalImages,
    };
  }, [filteredJobs, jobImageCounts]);

  const events = useMemo(() => {
    return debugJobDetails ? parseDebugEvents(debugJobDetails.debugEventsJson) : [];
  }, [debugJobDetails]);

  // 详情抽屉：解析当前选中 job 的 OCR 帧证据
  const ocrFrames = useMemo(() => {
    if (!debugJobDetails || !isL0JobType(debugJobDetails.type)) return [];
    return parseOcrFramesFromRawInput(debugJobDetails.rawInputJson);
  }, [debugJobDetails]);

  const ocrStats = useMemo(() => {
    const total = ocrFrames.length;
    const ok = ocrFrames.filter((f) => f.available).length;
    const failed = total - ok;
    return { total, ok, failed };
  }, [ocrFrames]);

  const handleRefresh = () => {
    void loadDebugJobs();
  };

  const handleTimeRangeChange = (key: "startAt" | "endAt", value: string) => {
    const iso = parseDateTimeLocalValue(value);
    if (!iso) return;
    setDebugFilters({ [key]: iso });
  };

  const handleJobClick = (jobId: string) => {
    setSelectedJobId(jobId);
    setActiveTab("output");
  };

  const handleCloseDrawer = () => {
    setSelectedJobId(null);
  };

  const drawerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(drawerRef, {
    enabled: selectedJobId !== null,
    onEscape: handleCloseDrawer,
  });

  return (
    <div className="debug-page">
      {/* 筛选器 */}
      <div className="debug-filters">
        <div className="debug-filters__group">
          <label className="debug-filters__label">时间范围</label>
          <input
            type="datetime-local"
            value={formatDateTimeLocalValue(debugFilters.startAt)}
            onChange={(e) => handleTimeRangeChange("startAt", e.target.value)}
          />
          <span>~</span>
          <input
            type="datetime-local"
            value={formatDateTimeLocalValue(debugFilters.endAt)}
            onChange={(e) => handleTimeRangeChange("endAt", e.target.value)}
          />
        </div>
        <div className="debug-filters__group">
          <label className="debug-filters__label">类型</label>
          <select
            value={debugFilters.jobType}
            onChange={(e) => setDebugFilters({ jobType: e.target.value })}
          >
            <option value="all">全部</option>
            <option value="observer_all">L0 观察（全部）</option>
            <option value="observer_extractor">观察提取（单帧）</option>
            <option value="observer_extractor_batch">观察提取（批次 L0+L1）</option>
            <option value="observer_batch">观察提取（批次 L0）</option>
            <option value="episode_fact_extractor">Episode+Fact 提取</option>
            <option value="linker_scene_judge">关联+场景+判断</option>
            <option value="timeline_builder">时间轴构建</option>
            <option value="reporter">报告生成</option>
            <option value="personal_review">个人复盘</option>
            <option value="memory_ask">轻量问答</option>
            <option value="memory_search_expand">记忆搜索扩展</option>
            <option value="batch_pipeline">批处理管道</option>
          </select>
        </div>
        <div className="debug-filters__group">
          <label className="debug-filters__label">状态</label>
          <select
            value={debugFilters.status}
            onChange={(e) => setDebugFilters({ status: e.target.value })}
          >
            <option value="all">全部</option>
            <option value="succeeded">成功</option>
            <option value="failed">失败</option>
            <option value="running">运行中</option>
          </select>
        </div>
        <button type="button" className="btn btn-primary" onClick={handleRefresh} disabled={debugJobsLoading}>
          {debugJobsLoading ? "加载中..." : "刷新"}
        </button>
      </div>

      {/* 统计面板 */}
      <div className="debug-stats">
        <div className="debug-stats__item">
          <span className="debug-stats__label">总调用</span>
          <span className="debug-stats__value">{stats.total}</span>
        </div>
        <div className="debug-stats__item debug-stats__item--ok">
          <span className="debug-stats__label">成功</span>
          <span className="debug-stats__value">{stats.succeeded}</span>
        </div>
        <div className="debug-stats__item debug-stats__item--err">
          <span className="debug-stats__label">失败</span>
          <span className="debug-stats__value">{stats.failed}</span>
        </div>
        <div className="debug-stats__item debug-stats__item--warn">
          <span className="debug-stats__label">运行中</span>
          <span className="debug-stats__value">{stats.running}</span>
        </div>
        <div className="debug-stats__item debug-stats__item--warn">
          <span className="debug-stats__label">丢弃事件</span>
          <span className="debug-stats__value">{stats.totalDiscardEvents}</span>
        </div>
        <div className="debug-stats__item debug-stats__item--info">
          <span className="debug-stats__label">L0 调用</span>
          <span className="debug-stats__value">{stats.l0CallCount}</span>
        </div>
        <div className="debug-stats__item debug-stats__item--info">
          <span className="debug-stats__label">提交图片</span>
          <span className="debug-stats__value">{stats.totalImages}</span>
        </div>
      </div>

      {debugJobsError && (
        <div className="debug-error">加载失败: {debugJobsError}</div>
      )}

      {/* 调用列表 */}
      <div className="debug-job-list">
        <table className="debug-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>类型</th>
              <th>状态</th>
              <th>图片</th>
              <th>尝试</th>
              <th>丢弃事件</th>
              <th>错误</th>
            </tr>
          </thead>
          <tbody>
            {filteredJobs.length === 0 && !debugJobsLoading && (
              <tr>
                <td colSpan={7} className="debug-table__empty">暂无模型调用记录</td>
              </tr>
            )}
            {filteredJobs.map((job) => {
              const imgCount = jobImageCounts.get(job.id) ?? 0;
              const isL0 = isL0JobType(job.type);
              return (
                <tr
                  key={job.id}
                  className={`debug-table__row ${selectedJobId === job.id ? "is-selected" : ""}`}
                  onClick={() => handleJobClick(job.id)}
                >
                  <td>{job.createdAt ? new Date(job.createdAt).toLocaleString("zh-CN") : "—"}</td>
                  <td>{JOB_TYPE_LABELS[job.type] ?? job.type}</td>
                  <td>
                    <span className={`debug-status debug-status--${job.status}`}>{job.status}</span>
                  </td>
                  <td>
                    {isL0
                      ? <span className="debug-img-count">{imgCount > 0 ? imgCount : "—"}</span>
                      : <span className="debug-table__muted">—</span>}
                  </td>
                  <td>{job.attempts}</td>
                  <td>{job.debugEventCount > 0 ? <span className="debug-badge">{job.debugEventCount}</span> : "—"}</td>
                  <td className="debug-table__error" title={job.errorMessage ?? undefined}>
                    {job.errorCode ?? ""}
                    {job.errorMessage && <span> · {summarizeError(job.errorMessage)}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 详情抽屉 */}
      {selectedJobId && (
        <div className="debug-drawer" ref={drawerRef} role="dialog" aria-modal="true">
          <div className="debug-drawer__header">
            <h3 className="debug-drawer__title">调用详情</h3>
            <button type="button" className="debug-drawer__close" onClick={handleCloseDrawer}>✕</button>
          </div>
          {debugJobDetailsLoading && <p className="debug-drawer__loading">加载中...</p>}
          {debugJobDetails && (
            <>
              <div className="debug-drawer__meta">
                <span>类型: {JOB_TYPE_LABELS[debugJobDetails.type] ?? debugJobDetails.type}</span>
                <span>状态: {debugJobDetails.status}</span>
                <span>时间: {new Date(debugJobDetails.createdAt).toLocaleString("zh-CN")}</span>
                <span>尝试: {debugJobDetails.attempts}</span>
                {debugJobDetails.errorCode && <span className="debug-drawer__error">错误: {debugJobDetails.errorCode}</span>}
                {debugJobDetails.errorMessage && (
                  <span className="debug-drawer__error">详情: {debugJobDetails.errorMessage}</span>
                )}
              </div>
              <div className="debug-drawer__tabs">
                <button className={activeTab === "output" ? "is-active" : ""} onClick={() => setActiveTab("output")}>原始输出</button>
                <button className={activeTab === "input" ? "is-active" : ""} onClick={() => setActiveTab("input")}>模型输入</button>
                <button className={activeTab === "records" ? "is-active" : ""} onClick={() => setActiveTab("records")}>落库记录</button>
                <button className={activeTab === "events" ? "is-active" : ""} onClick={() => setActiveTab("events")}>丢弃事件 ({events.length})</button>
                {isL0JobType(debugJobDetails.type) && (
                  <button className={activeTab === "ocr" ? "is-active" : ""} onClick={() => setActiveTab("ocr")}>
                    OCR 证据 ({ocrFrames.length})
                  </button>
                )}
              </div>
              <div className="debug-drawer__body">
                {activeTab === "output" && (
                  <pre className="debug-json">{formatJsonString(debugJobDetails.outputJson)}</pre>
                )}
                {activeTab === "input" && (
                  <pre className="debug-json">{formatJsonString(debugJobDetails.rawInputJson)}</pre>
                )}
                {activeTab === "records" && (
                  <div className="debug-records">
                    {debugRelatedRecordsLoading && <p>加载中...</p>}
                    {debugRelatedRecords && (
                      <>
                        <div className="debug-records__group">
                          <h4>观察 ({debugRelatedRecords.observations.length})</h4>
                          <pre className="debug-json">{JSON.stringify(debugRelatedRecords.observations, null, 2)}</pre>
                        </div>
                        <div className="debug-records__group">
                          <h4>线索 ({debugRelatedRecords.facts.length})</h4>
                          <pre className="debug-json">{JSON.stringify(debugRelatedRecords.facts, null, 2)}</pre>
                        </div>
                        <div className="debug-records__group">
                          <h4>工作片段 ({debugRelatedRecords.scenes.length})</h4>
                          <pre className="debug-json">{JSON.stringify(debugRelatedRecords.scenes, null, 2)}</pre>
                        </div>
                        <div className="debug-records__group">
                          <h4>提醒 ({debugRelatedRecords.proactiveItems.length})</h4>
                          <pre className="debug-json">{JSON.stringify(debugRelatedRecords.proactiveItems, null, 2)}</pre>
                        </div>
                      </>
                    )}
                  </div>
                )}
                {activeTab === "events" && (
                  <div className="debug-events">
                    {events.length === 0 ? (
                      <p className="debug-events__empty">无丢弃事件</p>
                    ) : (
                      <table className="debug-table debug-table--events">
                        <thead>
                          <tr>
                            <th>层级</th>
                            <th>动作</th>
                            <th>原因</th>
                            <th>目标类型</th>
                            <th>项 ID</th>
                            <th>帧序号</th>
                          </tr>
                        </thead>
                        <tbody>
                          {events.map((evt, i) => (
                            <tr key={i}>
                              <td><span className={`debug-layer debug-layer--${evt.layer}`}>{LAYER_LABELS[evt.layer] ?? evt.layer}</span></td>
                              <td>{evt.action}</td>
                              <td className="debug-events__reason">{evt.reason}</td>
                              <td>{evt.targetType ?? "—"}</td>
                              <td className="debug-events__id">{evt.itemId ?? "—"}</td>
                              <td>{evt.frameIndex ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
                {activeTab === "ocr" && (
                  <div className="debug-ocr">
                    {ocrFrames.length === 0 ? (
                      <div className="debug-ocr__empty">
                        <p>未检测到 OCR 证据。</p>
                        <p className="debug-ocr__hint">
                          可能原因：非批次 L0 任务（单帧 observer_extractor 不注入 OCR 块）；
                          或未开启 verboseModelIO（设置 → 调试 → 记录完整模型输入输出）；
                          或本次任务未触发本地 OCR。
                        </p>
                      </div>
                    ) : (
                      <>
                        <div className="debug-ocr__summary">
                          <div className="debug-stats__item debug-stats__item--info">
                            <span className="debug-stats__label">总帧数</span>
                            <span className="debug-stats__value">{ocrStats.total}</span>
                          </div>
                          <div className="debug-stats__item debug-stats__item--ok">
                            <span className="debug-stats__label">OCR 成功</span>
                            <span className="debug-stats__value">{ocrStats.ok}</span>
                          </div>
                          <div className="debug-stats__item debug-stats__item--err">
                            <span className="debug-stats__label">OCR 失败</span>
                            <span className="debug-stats__value">{ocrStats.failed}</span>
                          </div>
                        </div>
                        <table className="debug-table debug-table--ocr">
                          <thead>
                            <tr>
                              <th>帧序号</th>
                              <th>状态</th>
                              <th>语言</th>
                              <th>识别文字</th>
                            </tr>
                          </thead>
                          <tbody>
                            {ocrFrames.map((frame) => (
                              <tr key={frame.frameIndex}>
                                <td>#{frame.frameIndex}</td>
                                <td>
                                  <span className={`debug-ocr__status ${frame.available ? "debug-ocr__status--ok" : "debug-ocr__status--err"}`}>
                                    {frame.available ? "成功" : "失败"}
                                  </span>
                                </td>
                                <td>{frame.language ?? "—"}</td>
                                <td className="debug-ocr__text">
                                  {frame.text.trim() ? frame.text : <span className="debug-table__muted">(空)</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
