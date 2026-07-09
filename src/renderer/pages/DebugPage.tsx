// src/renderer/pages/DebugPage.tsx
// 调试页：展示模型调用记录、丢弃事件、落库对比
//
// 仅当 settings.debug.enabled=true 时可访问（AppShell 条件渲染导航入口）
// 数据源：model_jobs 表（通过 debug:* IPC 查询，手动刷新）

import { useEffect, useState, useMemo } from "react";
import {
  useAppStore,
  type DebugJobSummary,
  type DebugJobDetails,
  type DebugEventItem,
} from "../state/store";

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

const LAYER_LABELS: Record<string, string> = {
  L0: "L0 观察",
  L1: "L1 线索",
  L2: "L2 工作片段",
  L3: "L3 记忆对象",
  proactive: "提醒",
};

const JOB_TYPE_LABELS: Record<string, string> = {
  observer: "观察提取（旧）",
  observer_extractor: "观察提取",
  observer_extractor_batch: "观察提取（批次）",
  extractor: "事实提取（旧）",
  linker: "关联（旧）",
  scene_builder: "场景构建（旧）",
  judge: "判断（旧）",
  linker_scene_judge: "关联+场景+判断",
  timeline_builder: "时间轴构建",
  reporter: "报告生成",
};

function matchesJobTypeFilter(type: string, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "observer_extractor_all") {
    return type === "observer_extractor" || type === "observer_extractor_batch";
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
  const [activeTab, setActiveTab] = useState<"output" | "input" | "records" | "events">("output");

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

  const stats = useMemo(() => {
    const total = filteredJobs.length;
    const succeeded = filteredJobs.filter((j) => j.status === "succeeded").length;
    const failed = filteredJobs.filter((j) => j.status === "failed").length;
    const running = filteredJobs.filter((j) => j.status === "running").length;
    const totalDiscardEvents = filteredJobs.reduce((sum, j) => sum + j.debugEventCount, 0);
    return { total, succeeded, failed, running, totalDiscardEvents };
  }, [filteredJobs]);

  const events = useMemo(() => {
    return debugJobDetails ? parseDebugEvents(debugJobDetails.debugEventsJson) : [];
  }, [debugJobDetails]);

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
            <option value="observer_extractor_all">观察提取</option>
            <option value="observer_extractor_batch">观察提取（批次）</option>
            <option value="observer_extractor">观察提取（单帧）</option>
            <option value="linker_scene_judge">关联+场景+判断</option>
            <option value="timeline_builder">时间轴构建</option>
            <option value="reporter">报告生成</option>
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
              <th>尝试</th>
              <th>丢弃事件</th>
              <th>错误</th>
            </tr>
          </thead>
          <tbody>
            {filteredJobs.length === 0 && !debugJobsLoading && (
              <tr>
                <td colSpan={6} className="debug-table__empty">暂无模型调用记录</td>
              </tr>
            )}
            {filteredJobs.map((job) => (
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
                <td>{job.attempts}</td>
                <td>{job.debugEventCount > 0 ? <span className="debug-badge">{job.debugEventCount}</span> : "—"}</td>
                <td className="debug-table__error">{job.errorCode ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 详情抽屉 */}
      {selectedJobId && (
        <div className="debug-drawer" role="dialog" aria-modal="true">
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
              </div>
              <div className="debug-drawer__tabs">
                <button className={activeTab === "output" ? "is-active" : ""} onClick={() => setActiveTab("output")}>原始输出</button>
                <button className={activeTab === "input" ? "is-active" : ""} onClick={() => setActiveTab("input")}>模型输入</button>
                <button className={activeTab === "records" ? "is-active" : ""} onClick={() => setActiveTab("records")}>落库记录</button>
                <button className={activeTab === "events" ? "is-active" : ""} onClick={() => setActiveTab("events")}>丢弃事件 ({events.length})</button>
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
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
