import { useEffect, useRef, useState } from "react";
import { getIpc } from "../../state/ipc";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import type { FactItem, SceneItem } from "../../state/store";
import type { TimelineBlock } from "../../../shared/types";

interface SourceEvidenceData {
  facts: FactItem[];
  scenes: SceneItem[];
  timelineBlocks: TimelineBlock[];
}

interface SourcePanelProps {
  title: string;
  factIds: string[];
  sceneIds: string[];
  blockIds: string[];
  onClose: () => void;
}

export function SourcePanel({
  title,
  factIds,
  sceneIds,
  blockIds,
  onClose,
}: SourcePanelProps) {
  const total = factIds.length + sceneIds.length + blockIds.length;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<SourceEvidenceData>({
    facts: [],
    scenes: [],
    timelineBlocks: [],
  });

  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, { enabled: true, onEscape: onClose });

  useEffect(() => {
    let cancelled = false;

    const loadEvidence = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const response = await getIpc().reports.getEvidenceByIds({
          factIds,
          sceneIds,
          blockIds,
        });
        if (cancelled) return;
        if (!response.ok) {
          setEvidence({ facts: [], scenes: [], timelineBlocks: [] });
          setLoadError(response.error);
          return;
        }
        const data = response.data;
        setEvidence({
          facts: Array.isArray(data.facts) ? (data.facts as FactItem[]) : [],
          scenes: Array.isArray(data.scenes) ? (data.scenes as SceneItem[]) : [],
          timelineBlocks: Array.isArray(data.timelineBlocks)
            ? (data.timelineBlocks as TimelineBlock[])
            : [],
        });
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setEvidence({ facts: [], scenes: [], timelineBlocks: [] });
        setLoadError(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void loadEvidence();
    return () => {
      cancelled = true;
    };
  }, [factIds, sceneIds, blockIds]);

  const blockMap = new Map(evidence.timelineBlocks.map((block) => [block.id, block]));
  const factMap = new Map(evidence.facts.map((fact) => [fact.id, fact]));
  const sceneMap = new Map(evidence.scenes.map((scene) => [scene.id, scene]));

  return (
    <div className="report-source-overlay" onClick={onClose}>
      <div
        className="report-source-panel"
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <header className="report-source-panel__header">
          <h4 className="report-source-panel__title">{title}</h4>
          <button
            className="report-source-panel__close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </header>
        <div className="report-source-panel__body">
          <p className="report-source-panel__hint">
            以下为报告关联的事实、场景与时间轴片段。不显示截图。
          </p>

          <div className="report-source-panel__stats">
            <div className="report-source-panel__stat">
              <span className="report-source-panel__stat-label">事实</span>
              <span className="report-source-panel__stat-value">{factIds.length}</span>
            </div>
            <div className="report-source-panel__stat">
              <span className="report-source-panel__stat-label">场景</span>
              <span className="report-source-panel__stat-value">{sceneIds.length}</span>
            </div>
            <div className="report-source-panel__stat">
              <span className="report-source-panel__stat-label">片段</span>
              <span className="report-source-panel__stat-value">{blockIds.length}</span>
            </div>
          </div>

          {loading && (
            <p className="report-source-panel__empty">正在加载来源证据...</p>
          )}

          {!loading && loadError && (
            <p className="report-source-panel__empty">来源加载失败：{loadError}</p>
          )}

          {!loading && blockIds.length > 0 && (
            <div className="report-source-panel__group">
              <h5 className="report-source-panel__group-title">时间轴片段</h5>
              <div className="report-source-panel__items">
                {blockIds.slice(0, 30).map((id) => {
                  const block = blockMap.get(id);
                  if (block) {
                    return (
                      <div key={id} className="source-panel__item">
                        <div className="source-panel__item-header">
                          <span className="tag tag-category">片段</span>
                          <span className="source-panel__item-title">{block.title}</span>
                        </div>
                        <p className="source-panel__item-meta">
                          时间范围：{block.startAt} ~ {block.endAt}
                        </p>
                        {block.summary && (
                          <p className="source-panel__item-summary">{block.summary}</p>
                        )}
                        {block.highlights.length > 0 && (
                          <div className="source-panel__item-highlights">
                            <span className="source-panel__item-highlights-label">
                              关键产出：
                            </span>
                            <ul>
                              {block.highlights.map((highlight, index) => (
                                <li key={index}>{highlight}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    );
                  }
                  return (
                    <div
                      key={id}
                      className="source-panel__item source-panel__item--missing"
                    >
                      <span className="tag tag-category">片段</span>
                      <span className="source-panel__item-hint">
                        该片段未找到，或已不再保留
                      </span>
                    </div>
                  );
                })}
                {blockIds.length > 30 && (
                  <p className="report-source-panel__id-more">
                    ...共 {blockIds.length} 个
                  </p>
                )}
              </div>
            </div>
          )}

          {!loading && factIds.length > 0 && (
            <div className="report-source-panel__group">
              <h5 className="report-source-panel__group-title">来源事实</h5>
              <div className="report-source-panel__items">
                {factIds.slice(0, 30).map((id) => {
                  const fact = factMap.get(id);
                  if (fact) {
                    return (
                      <div key={id} className="source-panel__item">
                        <div className="source-panel__item-header">
                          <span className="tag tag-category">事实</span>
                          <span className="source-panel__item-title">{fact.type}</span>
                        </div>
                        <p className="source-panel__item-summary">{fact.content}</p>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={id}
                      className="source-panel__item source-panel__item--missing"
                    >
                      <span className="tag tag-category">事实</span>
                      <span className="source-panel__item-hint">
                        该事实未找到，或已不再保留
                      </span>
                    </div>
                  );
                })}
                {factIds.length > 30 && (
                  <p className="report-source-panel__id-more">
                    ...共 {factIds.length} 条
                  </p>
                )}
              </div>
            </div>
          )}

          {!loading && sceneIds.length > 0 && (
            <div className="report-source-panel__group">
              <h5 className="report-source-panel__group-title">来源场景</h5>
              <div className="report-source-panel__items">
                {sceneIds.slice(0, 30).map((id) => {
                  const scene = sceneMap.get(id);
                  if (scene) {
                    return (
                      <div key={id} className="source-panel__item">
                        <div className="source-panel__item-header">
                          <span className="tag tag-category">场景</span>
                          <span className="source-panel__item-title">{scene.title}</span>
                        </div>
                        <p className="source-panel__item-meta">
                          时间范围：{scene.startAt} ~ {scene.endAt}
                        </p>
                        {scene.summary && (
                          <p className="source-panel__item-summary">{scene.summary}</p>
                        )}
                      </div>
                    );
                  }
                  return (
                    <div
                      key={id}
                      className="source-panel__item source-panel__item--missing"
                    >
                      <span className="tag tag-category">场景</span>
                      <span className="source-panel__item-hint">
                        该场景未找到，或已不再保留
                      </span>
                    </div>
                  );
                })}
                {sceneIds.length > 30 && (
                  <p className="report-source-panel__id-more">
                    ...共 {sceneIds.length} 个
                  </p>
                )}
              </div>
            </div>
          )}

          {!loading && total === 0 && (
            <p className="report-source-panel__empty">
              本报告未关联来源。重要条目通常会显示来源事实或场景。
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
