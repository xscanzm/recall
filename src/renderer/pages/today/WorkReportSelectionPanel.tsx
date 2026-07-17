// src/renderer/pages/today/WorkReportSelectionPanel.tsx
// 工作日报选择模式右侧面板（spec 行 1649-1663）
//
// 显示：
// - 将使用 N 个工作片段
// - 预计生成：标准工作日报
// - 已排除：N 个私人/敏感片段 / N 个休息片段
// - [预览内容] [生成工作日报]

import type { TodayPageData } from "../../../shared/types";
import { useAppStore } from "../../state/store";
import { Button } from "../../components/Button";
import { TEMPORARY_REPORT_REQUIREMENT_MAX_LENGTH } from "../../../shared/reportRequirements";
import "./WorkReportSelectionPanel.css";

interface WorkReportSelectionPanelProps {
  data: TodayPageData;
}

export function WorkReportSelectionPanel({ data }: WorkReportSelectionPanelProps) {
  const selectedBlockIds = useAppStore((s) => s.selectedBlockIds);
  const setPreviewModalOpen = useAppStore((s) => s.setPreviewModalOpen);
  const setWorkReportSelectionMode = useAppStore((s) => s.setWorkReportSelectionMode);
  const workReportGenerating = useAppStore((s) => s.workReportGenerating);
  const workReportStyle = useAppStore((s) => s.workReportStyle);
  const setWorkReportStyle = useAppStore((s) => s.setWorkReportStyle);
  const workReportGenerationRequirement = useAppStore(
    (s) => s.workReportGenerationRequirement
  );
  const setWorkReportGenerationRequirement = useAppStore(
    (s) => s.setWorkReportGenerationRequirement
  );

  const selectedCount = selectedBlockIds.length;

  // 已排除统计
  const excludedPrivate = data.timelineBlocks.filter(
    (b) => b.privateRisk === "high"
  ).length;
  const excludedBreak = data.timelineBlocks.filter(
    (b) => b.category === "break"
  ).length;
  // 未被选中的非高风险工作片段（用户手动取消的）
  const unselectedWork = data.timelineBlocks.filter(
    (b) =>
      b.reportable &&
      b.privateRisk !== "high" &&
      !selectedBlockIds.includes(b.id)
  ).length;

  const styleLabel =
    workReportStyle === "brief"
      ? "简版工作日报"
      : workReportStyle === "formal"
      ? "正式工作日报"
      : "标准工作日报";

  return (
    <aside className="today-side-panel today-side-panel--select" aria-label="日报选择面板">
      <section className="side-section">
        <h2 className="side-section__title">日报选择</h2>

        <div className="select-summary">
          <p className="select-summary__main">
            将使用 <strong>{selectedCount}</strong> 个工作片段
          </p>
          <p className="select-summary__sub">预计生成：{styleLabel}</p>

          <label className="select-style-row">
            <span>风格</span>
            <select
              value={workReportStyle}
              onChange={(e) =>
                setWorkReportStyle(e.target.value as "brief" | "standard" | "formal")
              }
            >
              <option value="brief">简版</option>
              <option value="standard">标准</option>
              <option value="formal">正式</option>
            </select>
          </label>

          <label className="work-report-requirement-field">
            <span>本次补充要求（可选）</span>
            <textarea
              value={workReportGenerationRequirement}
              maxLength={TEMPORARY_REPORT_REQUIREMENT_MAX_LENGTH}
              placeholder="例如：重点突出客户反馈，并把尚未解决的问题单独列出。"
              onChange={(event) =>
                setWorkReportGenerationRequirement(event.target.value)
              }
            />
            <small>
              只影响这一次生成，不会保存为长期报告要求。
            </small>
          </label>
        </div>
      </section>

      {(excludedPrivate > 0 || excludedBreak > 0 || unselectedWork > 0) && (
        <section className="side-section">
          <h2 className="side-section__title">已排除</h2>
          <ul className="exclude-list">
            {excludedPrivate > 0 && (
              <li className="exclude-item">
                <span className="exclude-item__dot exclude-item__dot--private" />
                {excludedPrivate} 个私人/敏感片段
              </li>
            )}
            {excludedBreak > 0 && (
              <li className="exclude-item">
                <span className="exclude-item__dot exclude-item__dot--break" />
                {excludedBreak} 个休息片段
              </li>
            )}
            {unselectedWork > 0 && (
              <li className="exclude-item">
                <span className="exclude-item__dot exclude-item__dot--manual" />
                {unselectedWork} 个未选工作片段
              </li>
            )}
          </ul>
        </section>
      )}

      <section className="side-section side-section--last">
        <div className="side-section__btn-stack">
          <Button
            variant="secondary"
            onClick={() => setPreviewModalOpen(true)}
            disabled={selectedCount === 0}
          >
            预览内容
          </Button>
          <Button
            variant="primary"
            onClick={() => setPreviewModalOpen(true)}
            disabled={selectedCount === 0 || workReportGenerating}
          >
            {workReportGenerating ? "正在生成..." : "生成工作日报"}
          </Button>
          <Button variant="ghost" onClick={() => setWorkReportSelectionMode(false)}>
            取消选择
          </Button>
        </div>
      </section>
    </aside>
  );
}
