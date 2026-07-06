// src/renderer/pages/ReportsPage.tsx
// 报告页（来自 08 文档 "报告页" 章节）
//
// 模块布局：
// 1. 顶部 Tab：今日日报 / 历史日报 / 周报
// 2. 今日日报 Tab：今日报告或空状态，包含"生成今日日报"按钮
// 3. 历史日报 Tab：日期倒序列表，点击查看详情
// 4. 周报 Tab：本周周报 + 历史周报
// 5. 选中报告后下方展示 ReportEditor
//
// 空状态文案：
// - 今日无报告："今天还没有足够记忆生成日报。继续工作一会儿，或手动添加一条记录。"
// - 历史无报告："还没有任何日报。开始观察一段时间后会自动生成。"
// - 周报无报告："本周还没有周报。点击下方按钮生成本周周报。"
// - 生成失败：显示 errorMessage，并提供"重试"按钮
//
// 重要约束（来自 spec.md）：
// - 报告不直接引用截图
// - 用户编辑保存后通过 reports:update IPC 写入 content_json
// - 重新生成通过 reports:generate IPC 触发
// - 复制时使用 formatReportAsText 转为纯文本（适合工作汇报）

import { useEffect, useState } from "react";
import { useAppStore } from "../state/store";
import { getIpc } from "../state/ipc";
import {
  ReportEditor,
  formatReportAsText,
} from "../components/ReportEditor";

// ============================================================================
// 报告类型（与 main/models/types.ts 结构一致，进程边界隔离）
// ============================================================================

interface ReportItem {
  id: string;
  type: string;
  dateKey: string;
  title: string;
  contentJson: string;
  sourceFactIds: string[];
  sourceSceneIds: string[];
  createdAt: string;
  updatedAt: string;
  /** 12.5/22.11：报告来源被 soft delete 后标记为 stale */
  isStale?: number;
  staleReason?: string | null;
  staleAt?: string | null;
}

type TabKey = "today" | "history" | "weekly";

const NO_TODAY_REPORT_HINT =
  "今天还没有足够记忆生成日报。继续工作一会儿，或手动添加一条记录。";
const NO_HISTORY_REPORT_HINT =
  "还没有任何日报。开始观察一段时间后会自动生成。";
const NO_WEEKLY_REPORT_HINT =
  "本周还没有周报。点击下方按钮生成本周周报。";

export function ReportsPage() {
  const isReady = useAppStore((s) => s.isReady);
  const [activeTab, setActiveTab] = useState<TabKey>("today");
  const [todayReport, setTodayReport] = useState<ReportItem | null>(null);
  const [historyReports, setHistoryReports] = useState<ReportItem[]>([]);
  const [weeklyReports, setWeeklyReports] = useState<ReportItem[]>([]);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<ReportItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copyHint, setCopyHint] = useState<string | null>(null);

  // 今日日期 key（本地时区）
  const todayKey = getTodayKey();

  // 加载今日日报
  const loadTodayReport = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await getIpc().reports.list<ReportItem>({
        type: "daily",
        dateFrom: todayKey,
        dateTo: todayKey,
      });
      setTodayReport(list && list.length > 0 ? list[0] : null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  // 加载历史日报（不含今日）
  const loadHistoryReports = async () => {
    setLoading(true);
    setError(null);
    try {
      // 取最近 30 条日报，前端过滤今日
      const list = await getIpc().reports.list<ReportItem>({
        type: "daily",
        limit: 30,
      });
      const filtered = (list ?? []).filter((r) => r.dateKey !== todayKey);
      setHistoryReports(filtered);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  // 加载周报
  const loadWeeklyReports = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await getIpc().reports.list<ReportItem>({
        type: "weekly",
        limit: 20,
      });
      setWeeklyReports(list ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  // 切换 tab 时加载数据
  useEffect(() => {
    if (!isReady) return;
    if (activeTab === "today") {
      void loadTodayReport();
    } else if (activeTab === "history") {
      void loadHistoryReports();
    } else if (activeTab === "weekly") {
      void loadWeeklyReports();
    }
    // 切换 tab 时清除选中状态
    setSelectedReportId(null);
    setSelectedReport(null);
  }, [isReady, activeTab, todayKey]);

  // 选中历史/周报后加载详情
  useEffect(() => {
    if (!selectedReportId) {
      setSelectedReport(null);
      return;
    }
    void (async () => {
      try {
        const detail = await getIpc().reports.get<ReportItem>({
          id: selectedReportId,
        });
        setSelectedReport(detail);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      }
    })();
  }, [selectedReportId]);

  // 生成今日日报
  const handleGenerateToday = async () => {
    setGenerating(true);
    setError(null);
    try {
      const result = await getIpc().reports.generate({
        type: "daily",
        dateKey: todayKey,
      });
      if (!result.ok) {
        setError(result.message ?? "生成失败");
      } else {
        // 重新加载今日报告
        await loadTodayReport();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setGenerating(false);
    }
  };

  // 生成周报
  const handleGenerateWeekly = async () => {
    setGenerating(true);
    setError(null);
    try {
      const weekStart = getCurrentWeekStart();
      const result = await getIpc().reports.generate({
        type: "weekly",
        dateKey: weekStart,
      });
      if (!result.ok) {
        setError(result.message ?? "生成失败");
      } else {
        await loadWeeklyReports();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setGenerating(false);
    }
  };

  // 重新生成当前选中的报告
  const handleRegenerate = async () => {
    if (!selectedReport) return;
    setGenerating(true);
    setError(null);
    try {
      const result = await getIpc().reports.generate({
        type: selectedReport.type as "daily" | "weekly",
        dateKey: selectedReport.dateKey,
      });
      if (!result.ok) {
        setError(result.message ?? "重新生成失败");
      } else {
        // 重新加载列表和详情
        if (activeTab === "today") await loadTodayReport();
        else if (activeTab === "history") await loadHistoryReports();
        else if (activeTab === "weekly") await loadWeeklyReports();
        if (result.reportId) {
          const detail = await getIpc().reports.get<ReportItem>({
            id: result.reportId,
          });
          setSelectedReport(detail);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setGenerating(false);
    }
  };

  // 编辑保存
  const handleSave = async (contentJson: string) => {
    if (!selectedReport) return;
    await getIpc().reports.update({
      id: selectedReport.id,
      contentJson,
    });
    // 更新本地状态
    setSelectedReport({
      ...selectedReport,
      contentJson,
      updatedAt: new Date().toISOString(),
    });
    // 同步更新列表中的对应项
    if (activeTab === "today" && todayReport?.id === selectedReport.id) {
      setTodayReport({
        ...todayReport,
        contentJson,
        updatedAt: new Date().toISOString(),
      });
    } else if (activeTab === "history") {
      setHistoryReports((prev) =>
        prev.map((r) =>
          r.id === selectedReport.id
            ? { ...r, contentJson, updatedAt: new Date().toISOString() }
            : r
        )
      );
    } else if (activeTab === "weekly") {
      setWeeklyReports((prev) =>
        prev.map((r) =>
          r.id === selectedReport.id
            ? { ...r, contentJson, updatedAt: new Date().toISOString() }
            : r
        )
      );
    }
  };

  // 删除单条目（标记不准确）
  // 通过修改 content_json 实现：删除指定 section 的指定 index
  const handleDeleteEntry = async (section: string, index: number) => {
    if (!selectedReport) return;
    try {
      const content = JSON.parse(selectedReport.contentJson) as Record<
        string,
        unknown
      >;
      const sectionData = content[section];
      if (Array.isArray(sectionData)) {
        const updated = [...sectionData];
        updated.splice(index, 1);
        content[section] = updated;
        const newContentJson = JSON.stringify(content, null, 2);
        await handleSave(newContentJson);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    }
  };

  // 复制到剪贴板
  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyHint("已复制到剪贴板");
      setTimeout(() => setCopyHint(null), 2000);
    } catch {
      // clipboard API 不可用时降级
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
        setCopyHint("已复制到剪贴板");
        setTimeout(() => setCopyHint(null), 2000);
      } catch {
        setError("复制失败：剪贴板不可用");
      }
      document.body.removeChild(textarea);
    }
  };

  if (!isReady) {
    return (
      <div className="reports-page">
        <header className="page-header">
          <h2>报告</h2>
          <p className="page-header__sub">正在加载...</p>
        </header>
      </div>
    );
  }

  return (
    <div className="reports-page">
      <header className="page-header">
        <h2>报告</h2>
        <p className="page-header__sub">
          日报和周报基于结构化记忆生成，不直接引用截图。
        </p>
      </header>

      {/* Tab 切换 */}
      <nav className="reports-tabs">
        <button
          className={activeTab === "today" ? "active" : ""}
          onClick={() => setActiveTab("today")}
        >
          今日日报
        </button>
        <button
          className={activeTab === "history" ? "active" : ""}
          onClick={() => setActiveTab("history")}
        >
          历史日报
        </button>
        <button
          className={activeTab === "weekly" ? "active" : ""}
          onClick={() => setActiveTab("weekly")}
        >
          周报
        </button>
      </nav>

      {error && (
        <div className="reports-page__error">
          <p>{error}</p>
          <button onClick={() => setError(null)}>关闭</button>
        </div>
      )}

      {copyHint && (
        <div className="reports-page__copy-hint">
          <p>{copyHint}</p>
        </div>
      )}

      {/* 今日日报 Tab */}
      {activeTab === "today" && (
        <section className="reports-tab">
          <div className="reports-tab__toolbar">
            <p className="reports-tab__hint">
              {todayKey}
            </p>
            <button
              className="primary"
              onClick={handleGenerateToday}
              disabled={generating}
            >
              {generating ? "生成中..." : "生成今日日报"}
            </button>
          </div>

          {loading ? (
            <p className="state-loading">正在加载今日日报...</p>
          ) : todayReport ? (
            <ReportEditor
              reportId={todayReport.id}
              type="daily"
              dateKey={todayReport.dateKey}
              title={todayReport.title}
              contentJson={todayReport.contentJson}
              sourceFactIds={todayReport.sourceFactIds}
              sourceSceneIds={todayReport.sourceSceneIds}
              isStale={todayReport.isStale}
              staleReason={todayReport.staleReason}
              staleAt={todayReport.staleAt}
              onCopy={handleCopy}
              onRegenerate={handleRegenerate}
              onSave={handleSave}
              onDeleteEntry={handleDeleteEntry}
            />
          ) : (
            <div className="empty-state">
              <p>{NO_TODAY_REPORT_HINT}</p>
            </div>
          )}
        </section>
      )}

      {/* 历史日报 Tab */}
      {activeTab === "history" && (
        <section className="reports-tab">
          {loading ? (
            <p className="state-loading">正在加载历史日报...</p>
          ) : historyReports.length === 0 ? (
            <div className="empty-state">
              <p>{NO_HISTORY_REPORT_HINT}</p>
            </div>
          ) : (
            <div className="reports-tab__layout">
              <ul className="reports-list">
                {historyReports.map((r) => (
                  <li
                    key={r.id}
                    className={`reports-list__item ${
                      selectedReportId === r.id ? "selected" : ""
                    }`}
                  >
                    <button onClick={() => setSelectedReportId(r.id)}>
                      <span className="reports-list__date">{r.dateKey}</span>
                      <span className="reports-list__title">{r.title}</span>
                      <span className="reports-list__evidence">
                        来源 {r.sourceFactIds.length + r.sourceSceneIds.length} 条
                      </span>
                      {r.isStale === 1 && (
                        <span className="reports-list__stale-chip">需重新生成</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="reports-tab__detail">
                {selectedReport ? (
                  <ReportEditor
                    reportId={selectedReport.id}
                    type="daily"
                    dateKey={selectedReport.dateKey}
                    title={selectedReport.title}
                    contentJson={selectedReport.contentJson}
                    sourceFactIds={selectedReport.sourceFactIds}
                    sourceSceneIds={selectedReport.sourceSceneIds}
                    isStale={selectedReport.isStale}
                    staleReason={selectedReport.staleReason}
                    staleAt={selectedReport.staleAt}
                    onCopy={handleCopy}
                    onRegenerate={handleRegenerate}
                    onSave={handleSave}
                    onDeleteEntry={handleDeleteEntry}
                  />
                ) : (
                  <div className="empty-state">
                    <p>选择左侧任一日报查看详情。</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {/* 周报 Tab */}
      {activeTab === "weekly" && (
        <section className="reports-tab">
          <div className="reports-tab__toolbar">
            <p className="reports-tab__hint">
              本周起始：{getCurrentWeekStart()}
            </p>
            <button
              className="primary"
              onClick={handleGenerateWeekly}
              disabled={generating}
            >
              {generating ? "生成中..." : "生成本周周报"}
            </button>
          </div>

          {loading ? (
            <p className="state-loading">正在加载周报...</p>
          ) : weeklyReports.length === 0 ? (
            <div className="empty-state">
              <p>{NO_WEEKLY_REPORT_HINT}</p>
            </div>
          ) : (
            <div className="reports-tab__layout">
              <ul className="reports-list">
                {weeklyReports.map((r) => (
                  <li
                    key={r.id}
                    className={`reports-list__item ${
                      selectedReportId === r.id ? "selected" : ""
                    }`}
                  >
                    <button onClick={() => setSelectedReportId(r.id)}>
                      <span className="reports-list__date">{r.dateKey}</span>
                      <span className="reports-list__title">{r.title}</span>
                      <span className="reports-list__evidence">
                        来源 {r.sourceFactIds.length + r.sourceSceneIds.length} 条
                      </span>
                      {r.isStale === 1 && (
                        <span className="reports-list__stale-chip">需重新生成</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="reports-tab__detail">
                {selectedReport ? (
                  <ReportEditor
                    reportId={selectedReport.id}
                    type="weekly"
                    dateKey={selectedReport.dateKey}
                    title={selectedReport.title}
                    contentJson={selectedReport.contentJson}
                    sourceFactIds={selectedReport.sourceFactIds}
                    sourceSceneIds={selectedReport.sourceSceneIds}
                    isStale={selectedReport.isStale}
                    staleReason={selectedReport.staleReason}
                    staleAt={selectedReport.staleAt}
                    onCopy={handleCopy}
                    onRegenerate={handleRegenerate}
                    onSave={handleSave}
                    onDeleteEntry={handleDeleteEntry}
                  />
                ) : (
                  <div className="empty-state">
                    <p>选择左侧任一周报查看详情。</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      <style>{`
        .reports-page {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .reports-tabs {
          display: flex;
          gap: 4px;
          border-bottom: 1px solid var(--border);
        }
        .reports-tabs button {
          padding: 8px 16px;
          background: none;
          border: none;
          border-bottom: 2px solid transparent;
          color: var(--text-secondary);
          font-size: 13px;
          cursor: pointer;
        }
        .reports-tabs button:hover {
          color: var(--text-primary);
        }
        .reports-tabs button.active {
          color: var(--accent-green);
          border-bottom-color: var(--accent-green);
          font-weight: 500;
        }

        .reports-tab {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .reports-tab__toolbar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
        }
        .reports-tab__hint {
          margin: 0;
          font-size: 12px;
          color: var(--text-secondary);
        }
        .reports-tab__layout {
          display: grid;
          grid-template-columns: 240px 1fr;
          gap: 16px;
        }
        @media (max-width: 960px) {
          .reports-tab__layout {
            grid-template-columns: 1fr;
          }
        }

        .reports-list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
          background-color: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-card);
          padding: 8px;
          align-self: start;
        }
        .reports-list__item {
          border-radius: var(--radius-card);
        }
        .reports-list__item button {
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 8px;
          background: none;
          border: none;
          border-radius: var(--radius-card);
          cursor: pointer;
          text-align: left;
        }
        .reports-list__item button:hover {
          background-color: var(--bg);
        }
        .reports-list__item.selected button {
          background-color: var(--bg);
          border: 1px solid var(--accent-green);
        }
        .reports-list__date {
          font-size: 12px;
          color: var(--text-secondary);
        }
        .reports-list__title {
          font-size: 13px;
          color: var(--text-primary);
          font-weight: 500;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .reports-list__evidence {
          font-size: 11px;
          color: var(--text-secondary);
        }
        .reports-list__stale-chip {
          display: inline-block;
          align-self: flex-start;
          padding: 2px 8px;
          background-color: rgba(217, 145, 43, 0.12);
          border: 1px solid #D9912B;
          border-radius: var(--radius-pill);
          font-size: 11px;
          color: #D9912B;
          font-weight: 500;
        }

        .reports-tab__detail {
          min-height: 320px;
        }

        .reports-page__error {
          background-color: #fbeeeb;
          border: 1px solid var(--danger);
          border-radius: var(--radius-card);
          padding: 12px 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          color: var(--danger);
          font-size: 13px;
        }
        .reports-page__error button {
          background: none;
          border: none;
          color: var(--danger);
          cursor: pointer;
          font-size: 12px;
        }
        .reports-page__copy-hint {
          background-color: rgba(47, 143, 131, 0.1);
          border: 1px solid var(--accent-green);
          border-radius: var(--radius-card);
          padding: 8px 16px;
          color: var(--accent-green);
          font-size: 13px;
        }

        .empty-state {
          background-color: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-card);
          padding: 32px 16px;
          text-align: center;
          color: var(--text-secondary);
          font-size: 13px;
        }
        .empty-state p {
          margin: 0;
        }
      `}</style>
    </div>
  );
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 获取今日日期 key（YYYY-MM-DD，本地时区）
 */
function getTodayKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const day = now.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 获取本周一日期 key（YYYY-MM-DD）
 */
function getCurrentWeekStart(): string {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - daysFromMonday);
  monday.setHours(0, 0, 0, 0);
  const year = monday.getFullYear();
  const month = (monday.getMonth() + 1).toString().padStart(2, "0");
  const day = monday.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}
