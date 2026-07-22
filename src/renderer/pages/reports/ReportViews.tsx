import { Download } from "lucide-react";
import type { ReportItem } from "../../state/store";
import {
  compileReportItemToText,
  formatUpdatedAt,
  REPORT_TYPE_LABELS,
  type ReportSection,
} from "./reportFormatting";

export function ReportInfographic(props: {
  dataUrl?: string | null;
  title: string;
  filename: string;
}) {
  const { dataUrl, title, filename } = props;
  if (!dataUrl) return null;

  const handleDownload = () => {
    const anchor = document.createElement("a");
    anchor.href = dataUrl;
    anchor.download = filename.replace(/[^A-Za-z0-9._-]/g, "_");
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  };

  return (
    <figure className="report-infographic">
      <div className="report-infographic__toolbar">
        <figcaption className="report-infographic__caption">信息图</figcaption>
        <button
          type="button"
          className="report-infographic__download"
          onClick={handleDownload}
          title="下载信息图"
        >
          <Download size={14} aria-hidden="true" />
          下载图片
        </button>
      </div>
      <img className="report-infographic__image" src={dataUrl} alt={`${title} 信息图`} />
    </figure>
  );
}

interface ReportListProps {
  reports: ReportItem[];
  onCopy: (text: string) => void;
  onViewSource: (item: ReportItem) => void;
  onExport: (text: string, id: string) => void;
}

export function ReportList({
  reports,
  onCopy,
  onViewSource,
  onExport,
}: ReportListProps) {
  if (reports.length === 0) return null;
  return (
    <div className="reports-history-list">
      {reports.map((report) => (
        <div key={report.id} className="reports-history-row">
          <span className="reports-history-col reports-history-col--date">
            {report.dateKey}
          </span>
          <span className="reports-history-col reports-history-col--type">
            <span className="tag">
              {REPORT_TYPE_LABELS[report.type] ?? report.type}
            </span>
          </span>
          <span
            className="reports-history-col reports-history-col--title"
            title={report.title}
          >
            {report.title}
          </span>
          <span className="reports-history-col reports-history-col--time">
            {formatUpdatedAt(report.updatedAt)}
          </span>
          <span className="reports-history-col reports-history-col--actions">
            <button
              className="report-entry__action"
              onClick={() => onCopy(compileReportItemToText(report))}
            >
              复制
            </button>
            <button
              className="report-entry__action"
              onClick={() =>
                onExport(compileReportItemToText(report), report.id)
              }
            >
              导出
            </button>
            <button
              className="report-entry__action"
              onClick={() => onViewSource(report)}
            >
              来源
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

export function ReportSectionsDisplay({
  sections,
  rawText,
}: {
  sections: ReportSection[];
  rawText: string;
}) {
  if (sections.length > 0) {
    return (
      <>
        {sections.map((section, index) => (
          <section key={`section-${index}`} className="report-section">
            <h4 className="report-section__title">{section.title}</h4>
            {section.items.length > 0 ? (
              <ul className="report-section__bullets">
                {section.items.map((item, itemIndex) => (
                  <li key={`item-${index}-${itemIndex}`}>{item}</li>
                ))}
              </ul>
            ) : (
              <p className="report-section__empty">暂无内容。</p>
            )}
          </section>
        ))}
      </>
    );
  }

  return (
    <section className="report-section">
      <pre className="report-section__pre">{rawText}</pre>
    </section>
  );
}
