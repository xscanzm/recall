// src/renderer/pages/today/WorkReportPreviewModal.tsx
// 工作日报生成前预览弹层（spec 行 1665-1667）
//
// - 显示将发送给 WorkReportWriter 的 TimelineBlock 标题列表
// - 不显示截图
// - 显示隐私提示："以下内容将用于生成工作日报。未列出的片段不会进入本次生成。"
// - 按钮：返回修改 / 确认生成

import type { TodayPageData } from "../../../shared/types";
import { useAppStore } from "../../state/store";
import { Button } from "../../components/Button";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useRef } from "react";

interface WorkReportPreviewModalProps {
  data: TodayPageData;
}

export function WorkReportPreviewModal({ data }: WorkReportPreviewModalProps) {
  const selectedBlockIds = useAppStore((s) => s.selectedBlockIds);
  const setPreviewModalOpen = useAppStore((s) => s.setPreviewModalOpen);
  const generateWorkReport = useAppStore((s) => s.generateWorkReport);
  const workReportGenerating = useAppStore((s) => s.workReportGenerating);
  const workReportError = useAppStore((s) => s.workReportError);
  const workReportStyle = useAppStore((s) => s.workReportStyle);
  const todayPageDateKey = useAppStore((s) => s.todayPageDateKey);
  const workReportGenerationRequirement = useAppStore(
    (s) => s.workReportGenerationRequirement
  );

  const selectedBlocks = data.timelineBlocks.filter((b) =>
    selectedBlockIds.includes(b.id)
  );

  const handleConfirm = () => {
    if (selectedBlockIds.length === 0) return;
    void generateWorkReport({
      dateKey: todayPageDateKey,
      selectedBlockIds,
      style: workReportStyle,
      generationRequirement: workReportGenerationRequirement || undefined,
    });
  };

  const handleBack = () => setPreviewModalOpen(false);

  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, {
    enabled: true,
    onEscape: handleBack,
  });

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-modal-title"
      onClick={handleBack}
    >
      <div
        className="modal-box modal-box--preview"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-box__head">
          <h2 id="preview-modal-title" className="modal-box__title">
            预览日报内容
          </h2>
          <button
            type="button"
            className="modal-box__close"
            onClick={handleBack}
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div className="modal-box__body">
          <p className="modal-box__notice">
            以下内容将用于生成工作日报。未列出的片段不会进入本次生成。
          </p>

          <p className="modal-box__count">
            将使用 <strong>{selectedBlocks.length}</strong> 个工作片段：
          </p>

          {workReportGenerationRequirement && (
            <div className="preview-generation-requirement">
              <strong>本次补充要求</strong>
              <p>{workReportGenerationRequirement}</p>
            </div>
          )}

          {selectedBlocks.length === 0 ? (
            <p className="modal-box__empty">
              今天还没有适合写进工作日报的片段。你也可以手动选择时间轴中的工作内容。
            </p>
          ) : (
            <ul className="preview-list">
              {selectedBlocks.map((b) => (
                <li key={b.id} className="preview-item">
                  <span className="preview-item__title">{b.title}</span>
                  {b.projectNames.length > 0 && (
                    <span className="preview-item__project">
                      {b.projectNames[0]}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {workReportError && (
            <div className="modal-box__error">
              <p>日报生成失败。你选择的片段还在，可以稍后重试。</p>
            </div>
          )}
        </div>

        <div className="modal-box__foot">
          {workReportError ? (
            <>
              <Button variant="secondary" onClick={handleBack} disabled={workReportGenerating}>
                返回选择
              </Button>
              <Button
                variant="primary"
                onClick={handleConfirm}
                disabled={selectedBlocks.length === 0 || workReportGenerating}
              >
                {workReportGenerating ? "正在生成..." : "重试"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={handleBack} disabled={workReportGenerating}>
                返回修改
              </Button>
              <Button
                variant="primary"
                onClick={handleConfirm}
                disabled={selectedBlocks.length === 0 || workReportGenerating}
              >
                {workReportGenerating ? "正在生成..." : "确认生成"}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
