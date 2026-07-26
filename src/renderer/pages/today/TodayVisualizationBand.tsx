import { useMemo } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import type {
  TimelineBlockCategory,
  TodayActivityOverview,
} from "../../../shared/types";
import {
  buildAttentionSegmentsFromStats,
  buildRhythmRoutePath,
  buildRhythmSegments,
  buildRhythmTimeMarkers,
  buildTodayWords,
  formatVisualizationDuration,
  getRhythmRoutePoint,
  getActivityAxisDomain,
  timeToRoutePercent,
  type RhythmAxisDomain,
} from "./todayVisualization";

interface TodayVisualizationBandProps {
  overview: TodayActivityOverview;
  historical: boolean;
  activeCategory: TimelineBlockCategory | null;
  onCategorySelect: (category: TimelineBlockCategory) => void;
  onKeywordSelect: (keyword: string) => void;
  onOpenWindow: (windowId: string) => void;
}

export function TodayVisualizationBand({
  overview,
  historical,
  activeCategory,
  onCategorySelect,
  onKeywordSelect,
  onOpenWindow,
}: TodayVisualizationBandProps) {
  const attention = useMemo(
    () => buildAttentionSegmentsFromStats(overview.stats),
    [overview.stats]
  );
  // getActivityAxisDomain 只读这两个字段，因此按字段依赖而不是整个 overview。
  const observedStartAt = overview.observedStartAt;
  const observedEndAt = overview.observedEndAt;
  const domain = useMemo(
    () => getActivityAxisDomain({ observedStartAt, observedEndAt }),
    [observedStartAt, observedEndAt]
  );
  const rhythm = useMemo(
    () => domain ? buildRhythmSegments(overview.windows, domain) : [],
    [overview.windows, domain]
  );
  const words = useMemo(() => buildTodayWords(overview.episodes), [overview.episodes]);
  const totalMinutes = attention.reduce((sum, item) => sum + item.minutes, 0);
  const hasData = overview.episodes.length > 0 || overview.stats.sampleCount > 0;

  return (
    <section className="today-visualization" aria-label={historical ? "当天数据概览" : "今日数据概览"}>
      <AttentionChart
        segments={attention}
        totalMinutes={totalMinutes}
        historical={historical}
        activeCategory={activeCategory}
        onCategorySelect={onCategorySelect}
      />
      <RhythmChart
        segments={rhythm}
        categories={attention.filter((segment) => segment.filterable)}
        domain={domain}
        historical={historical}
        onOpenWindow={onOpenWindow}
      />
      <WordCloud
        words={words}
        historical={historical}
        onKeywordSelect={onKeywordSelect}
      />
      {!hasData && <span className="sr-only">继续记录后，这里会出现当天的数据可视化。</span>}
    </section>
  );
}

type AttentionData = ReturnType<typeof buildAttentionSegmentsFromStats>;

function AttentionChart({
  segments,
  totalMinutes,
  historical,
  activeCategory,
  onCategorySelect,
}: {
  segments: AttentionData;
  totalMinutes: number;
  historical: boolean;
  activeCategory: TimelineBlockCategory | null;
  onCategorySelect: (category: TimelineBlockCategory) => void;
}) {
  const gradient = buildDonutGradient(segments);
  const chartStyle = { "--attention-gradient": gradient } as CSSProperties;

  return (
    <article className="today-viz-card today-viz-card--attention" aria-label="注意力分布">
      <VizCaption subtitle={historical ? "当天时间构成" : "今天时间构成"} />
      {segments.length === 0 ? (
        <VisualizationEmpty label="等待活动片段" />
      ) : (
        <div className="attention-chart">
          <div className="attention-chart__donut" style={chartStyle} aria-hidden="true">
            <div className="attention-chart__center">
              <strong>{formatVisualizationDuration(totalMinutes)}</strong>
              <span>已记录</span>
            </div>
          </div>
          <div className="attention-chart__legend" aria-label="按活动类型筛选时间轴">
            {segments.slice(0, 4).map((segment) => (
              <button
                type="button"
                key={segment.key}
                className={`attention-legend${segment.filterable && activeCategory === segment.category ? " is-active" : ""}`}
                onClick={() => segment.filterable && onCategorySelect(segment.category)}
                aria-pressed={segment.filterable && activeCategory === segment.category}
                disabled={!segment.filterable}
                title={`${segment.label} ${formatVisualizationDuration(segment.minutes)}`}
              >
                <span className="attention-legend__dot" style={{ backgroundColor: segment.color }} />
                <span className="attention-legend__label">{segment.label}</span>
                <span className="attention-legend__value">{Math.round(segment.percentage)}%</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

type RhythmData = ReturnType<typeof buildRhythmSegments>;
const RHYTHM_ROUTE_PATH = buildRhythmRoutePath(0, 100);

function RhythmChart({
  segments,
  categories,
  domain,
  historical,
  onOpenWindow,
}: {
  segments: RhythmData;
  categories: AttentionData;
  domain: RhythmAxisDomain | null;
  historical: boolean;
  onOpenWindow: (windowId: string) => void;
}) {
  const now = new Date();
  const markers = useMemo(
    () => domain ? buildRhythmTimeMarkers(domain) : [],
    [domain]
  );
  const currentTimePercent = domain
    ? timeToRoutePercent(now.getTime(), Date.parse(domain.startAt), Date.parse(domain.endAt))
    : null;
  const currentTimePoint = currentTimePercent === null
    ? null
    : getRhythmRoutePoint(currentTimePercent);

  return (
    <article className="today-viz-card today-viz-card--rhythm" aria-label={historical ? "当天节奏" : "今日节奏"}>
      <VizCaption subtitle="一天如何展开与切换" />
      {segments.length === 0 ? (
        <VisualizationEmpty label="活动片段形成后显示节奏" />
      ) : (
        <div className="rhythm-chart">
          <div className="rhythm-chart__legend" aria-label="时间带活动分类">
            {categories.slice(0, 4).map((category) => (
              <span className="rhythm-chart__legend-item" key={category.category}>
                <span style={{ backgroundColor: category.color }} aria-hidden="true" />
                {category.label}
              </span>
            ))}
          </div>
          <div className="rhythm-chart__route-wrap">
            <svg
              className="rhythm-chart__route"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              role="img"
              aria-label="实际记录时段中的活动路径"
            >
              <path
                d={RHYTHM_ROUTE_PATH}
                pathLength="100"
                className="rhythm-chart__route-base"
              />
              {markers.filter((marker) => marker.percent > 0 && marker.percent < 100).map((marker) => (
                <line
                  key={`guide-${marker.percent}`}
                  className="rhythm-chart__route-guide"
                  x1={marker.guide.x1}
                  y1={marker.guide.y1}
                  x2={marker.guide.x2}
                  y2={marker.guide.y2}
                  aria-hidden="true"
                />
              ))}
              {segments.map((segment) => {
                const handleKeyDown = (event: KeyboardEvent<SVGPathElement>) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpenWindow(segment.id);
                  }
                };
                return (
                  <path
                    key={segment.id}
                    d={buildRhythmRoutePath(segment.startPercent, segment.startPercent + segment.widthPercent)}
                    className="rhythm-chart__route-segment"
                    stroke={segment.color}
                    role="button"
                    tabIndex={0}
                    aria-label={`${segment.timeLabel}，${segment.title}`}
                    onClick={() => onOpenWindow(segment.id)}
                    onKeyDown={handleKeyDown}
                  >
                    <title>{`${segment.timeLabel} · ${segment.title}`}</title>
                  </path>
                );
              })}
              {!historical && currentTimePoint && (
                <circle
                  cx={currentTimePoint.x}
                  cy={currentTimePoint.y}
                  r="1.8"
                  className="rhythm-chart__route-now"
                  aria-hidden="true"
                />
              )}
            </svg>
            {markers.map((marker) => {
              const verticalOffset = marker.point.y < 50 ? -10 : 11;
              const isStart = marker.percent === 0;
              const isEnd = marker.percent === 100;
              return (
                <span
                  className={`rhythm-route-time${isStart ? " is-start" : ""}${isEnd ? " is-end" : ""}`}
                  key={`${marker.percent}-${marker.label}`}
                  style={{
                    left: `${marker.point.x}%`,
                    top: `${marker.point.y + verticalOffset}%`,
                  }}
                >
                  {marker.label}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </article>
  );
}

type WordData = ReturnType<typeof buildTodayWords>;

function WordCloud({
  words,
  historical,
  onKeywordSelect,
}: {
  words: WordData;
  historical: boolean;
  onKeywordSelect: (keyword: string) => void;
}) {
  return (
    <article className="today-viz-card today-viz-card--words" aria-label={historical ? "当天词云" : "今日词云"}>
      <VizCaption subtitle="反复出现的项目与主题" />
      {words.length === 0 ? (
        <VisualizationEmpty label="积累主题后生成词云" />
      ) : (
        <div className="today-word-cloud" aria-label="点击关键词筛选时间轴">
          {words.map((word) => (
            <button
              type="button"
              key={word.text}
              className={`today-word today-word--size-${word.sizeLevel} today-word--tone-${word.tone}`}
              style={{ transform: `translateY(${word.offset}px) rotate(${word.rotation}deg)` }}
              onClick={() => onKeywordSelect(word.text)}
              title={`筛选“${word.text}”`}
            >
              {word.text}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

function VizCaption({ subtitle }: { subtitle: string }) {
  return (
    <header className="today-viz-card__header">
      <span>{subtitle}</span>
    </header>
  );
}

function VisualizationEmpty({ label }: { label: string }) {
  return (
    <div className="today-viz-empty">
      <span className="today-viz-empty__mark" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function buildDonutGradient(segments: AttentionData): string {
  if (segments.length === 0) return "var(--recall-surface-muted) 0 100%";
  let cursor = 0;
  return segments
    .map((segment) => {
      const start = cursor;
      cursor += segment.percentage;
      return `${segment.color} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
    })
    .join(", ");
}
