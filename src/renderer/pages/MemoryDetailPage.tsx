import { useEffect, useState } from "react";
import { CorrectionDialog } from "../components/CorrectionDialog";
import { getIpc } from "../state/ipc";
import { useAppStore, type MemoryDetail, type SearchResultItem } from "../state/store";

const TYPE_LABELS: Record<SearchResultItem["type"], string> = {
  fact: "内容",
  scene: "工作片段",
  task: "任务",
  project: "项目",
  decision: "决策",
  report: "报告",
  person: "人物",
  record: "记录",
};

export type MemoryDetailRef = { id: string; type: SearchResultItem["type"] | "timeline" };

interface MemoryDetailPageProps {
  detailRef: MemoryDetailRef;
  onBack: () => void;
  onOpenRelation: (relation: { id: string; type: SearchResultItem["type"] }) => void;
  backLabel?: string;
}

export function MemoryDetailPage({ detailRef, onBack, onOpenRelation, backLabel = "返回搜索结果" }: MemoryDetailPageProps) {
  const setPage = useAppStore((state) => state.setPage);
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Record<string, string>>({});
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<Record<string, string>>({});
  const [correctionOpen, setCorrectionOpen] = useState(false);

  // 按字段依赖而非按对象依赖：父组件每次渲染都会新建 detailRef 字面量，
  // 直接依赖对象会导致每渲染一次就重新拉取详情。
  const detailId = detailRef.id;
  const detailType = detailRef.type;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    void getIpc().memory.getDetail({ id: detailId, type: detailType })
      .then((result) => {
        if (cancelled) return;
        setDetail(result as MemoryDetail | null);
        if (!result) setError("没有找到这条记忆，可能已被删除。");
      })
      .catch((reason) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [detailId, detailType]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !correctionOpen) {
        event.preventDefault();
        onBack();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [correctionOpen, onBack]);

  const loadPreview = async (sourceId: string, index: number) => {
    const key = `${sourceId}:${index}`;
    if (preview[key] || previewLoading === key) return;
    setPreviewLoading(key);
    setPreviewError((current) => ({ ...current, [key]: "" }));
    try {
      const result = await getIpc().memory.getSourcePreview({ observationId: sourceId, index });
      if (result.ok) setPreview((current) => ({ ...current, [key]: result.dataUrl }));
      else setPreviewError((current) => ({ ...current, [key]: result.message }));
    } catch (reason) {
      setPreviewError((current) => ({ ...current, [key]: reason instanceof Error ? reason.message : String(reason) }));
    } finally {
      setPreviewLoading(null);
    }
  };

  const openSourceUrl = async (url: string | null) => {
    if (!url || !/^https?:\/\//iu.test(url)) return;
    await getIpc().memory.openSourceUrl({ url });
  };

  const openFullPage = () => {
    if (!detail) return;
    if (detail.type === "project") setPage("projects");
    if (detail.type === "person") setPage("people");
    if (detail.type === "report") setPage("reports");
  };

  return (
    <div className="memory-detail-page">
      <div className="memory-detail-page__sticky-bar">
        <button type="button" className="memory-detail-page__back" onClick={onBack}>
          {backLabel}
        </button>
      </div>
      <header className="memory-detail-page__header">
        {detail && (
          <div className="memory-detail-page__heading">
            <span className="memory-detail-page__type">{detail.type === "timeline" ? "时间轴" : TYPE_LABELS[detail.type]}</span>
            <h2>{detail.title}</h2>
          </div>
        )}
      </header>

      {loading && <p className="state-loading">正在加载记忆详情...</p>}
      {error && <div className="memory-detail-page__error"><p>{error}</p><button type="button" onClick={onBack}>{backLabel}</button></div>}

      {detail && !loading && !error && (
        <>
          <section className="card memory-detail-card memory-detail-card--overview">
            <div className="memory-detail-card__topline">
              <span>{new Date(detail.createdAt).toLocaleString("zh-CN")}</span>
              {detail.projectName && <span>项目：{detail.projectName}</span>}
            </div>
            <p className="memory-detail-card__summary">{detail.summary || "暂无摘要。"}</p>
            {detail.fields.length > 0 && (
              <dl className="memory-detail-fields">
                {detail.fields.filter((field) => field.value).map((field) => (
                  <div key={`${field.label}-${field.value}`}><dt>{field.label}</dt><dd>{field.value}</dd></div>
                ))}
              </dl>
            )}
            {(detail.correctionType || ["project", "person", "report"].includes(detail.type)) && (
              <div className="memory-detail-card__actions">
                {detail.correctionType && <button type="button" onClick={() => setCorrectionOpen(true)}>纠错</button>}
                {["project", "person", "report"].includes(detail.type) && <button type="button" onClick={openFullPage}>打开完整页面</button>}
              </div>
            )}
          </section>

          {detail.contentSections.map((section) => (
            <section className="card memory-detail-card" key={section.title}>
              <h3 className="card__title">{section.title}</h3>
              <div className="card__body">
                {section.text && <p className="memory-detail-card__text">{section.text}</p>}
                {section.items.length > 0 && <ul className="memory-detail-card__items">{section.items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>}
              </div>
            </section>
          ))}

          <section className="card memory-detail-card">
            <h3 className="card__title">来源记录 <span className="memory-detail-card__count">{detail.sources.length}</span></h3>
            <div className="card__body memory-detail-sources">
              {detail.sources.length === 0 && <p className="memory-detail-card__empty">这条记忆没有可用的来源记录。</p>}
              {detail.sources.map((source) => (
                <article className="memory-detail-source" key={source.id}>
                  <div className="memory-detail-source__meta">
                    <strong>{new Date(source.capturedAt).toLocaleString("zh-CN")}</strong>
                    <span>{source.appName} · {source.windowTitle}</span>
                    {source.url && /^https?:\/\//iu.test(source.url) && <button type="button" onClick={() => void openSourceUrl(source.url)}>打开网页来源</button>}
                  </div>
                  <p>{source.summary || "暂无来源摘要。"}</p>
                  {source.visibleContent.map((content, index) => (
                    <div className="memory-detail-source__content" key={`${content.type}-${index}`}>
                      <span className="memory-detail-source__content-type">{content.type}</span>
                      <p>{content.summary}</p>
                      {content.fullText ? (
                        <div className="memory-detail-source__full-text">
                          <h4>完整识别文本</h4>
                          <pre>{content.fullText}</pre>
                        </div>
                      ) : content.keyTextSnippets.length > 0 ? (
                        <ul>{content.keyTextSnippets.map((snippet, snippetIndex) => <li key={`${snippet}-${snippetIndex}`}>{snippet}</li>)}</ul>
                      ) : null}
                    </div>
                  ))}
                  {source.screenshotState === "available" && (
                    <div className="memory-detail-source__screenshots">
                      {Array.from({ length: source.screenshotCount }, (_, index) => {
                        const key = `${source.id}:${index}`;
                        return (
                          <div key={key} className="memory-detail-source__screenshot">
                            {preview[key] ? <img src={preview[key]} alt="当时保留的屏幕截图" /> : <button type="button" onClick={() => void loadPreview(source.id, index)} disabled={previewLoading === key}>{previewLoading === key ? "加载截图..." : "查看截图"}</button>}
                            {previewError[key] && <small>{previewError[key]}</small>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {source.screenshotState === "expired" && <div className="memory-detail-source__notice">原始截图已按保留策略清理，仍保留识别文本。</div>}
                </article>
              ))}
            </div>
          </section>

          {detail.relations.length > 0 && (
            <section className="card memory-detail-card">
              <h3 className="card__title">关联记忆 <span className="memory-detail-card__count">{detail.relations.length}</span></h3>
              <div className="card__body memory-detail-relations">
                {detail.relations.map((relation) => <button type="button" key={`${relation.type}-${relation.id}`} onClick={() => onOpenRelation(relation)}><span>{TYPE_LABELS[relation.type]}</span><strong>{relation.title}</strong>{relation.summary && <small>{relation.summary}</small>}</button>)}
              </div>
            </section>
          )}

          {correctionOpen && detail.correctionType && <CorrectionDialog open={true} targetType={detail.correctionType} targetId={detail.id} onClose={() => setCorrectionOpen(false)} onSubmitted={() => setCorrectionOpen(false)} />}
        </>
      )}
    </div>
  );
}
