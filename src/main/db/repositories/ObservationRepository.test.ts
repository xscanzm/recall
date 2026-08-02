import { describe, expect, it, vi } from "vitest";
import { ObservationRepository } from "./ObservationRepository";

// 250 条模拟行：验证 limit 参数（默认 200 / 显式 2000 / 钳制 1）
// 真实 SQL LIMIT 语义由 SQLite 保证；此处断言 SQL 含 `LIMIT ?` 且绑定参数正确。
function createRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `obs-${index}`,
    capture_id: `capture-${index}`,
    captured_at: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 60_000).toISOString(),
    app_name: "test-app",
    window_title: "Test Window",
    url_or_domain: null,
    capture_reason: "window_focus",
    scene_summary: `summary ${index}`,
    visible_content_json: "[]",
    detected_entities_json: "[]",
    possible_intent: null,
    possible_tasks_json: "[]",
    possible_decisions_json: "[]",
    sensitivity: "normal",
    confidence: 0.9,
    uncertainties_json: "[]",
    screenshot_retention: "standard",
    screenshot_paths_json: "[]",
    created_at: "2026-01-01T00:00:00.000Z",
    user_facing_summary: null,
    likely_work_purpose: null,
    privacy_risk: null,
    reportable_signal: null,
  }));
}

function createRepo(rowCount: number) {
  const all = vi.fn((..._args: unknown[]) => createRows(rowCount));
  const prepare = vi.fn((sql: string) => {
    expect(sql).toContain("LIMIT ?");
    expect(sql).toContain("captured_at >= ?");
    expect(sql).toContain("ORDER BY captured_at DESC");
    return { all };
  });
  return { repository: new ObservationRepository({ prepare } as never), all, prepare };
}

const START = "2026-01-01T00:00:00.000Z";
const END = "2026-01-02T00:00:00.000Z";

describe("ObservationRepository.listByTimeRange", () => {
  it("binds default limit 200 when 250 rows are in range", () => {
    const { repository, all } = createRepo(250);

    const rows = repository.listByTimeRange(START, END);

    expect(all).toHaveBeenCalledWith(START, END, 200);
    expect(rows).toHaveLength(250);
  });

  it("binds explicit larger limit when passed", () => {
    const { repository, all } = createRepo(250);

    const rows = repository.listByTimeRange(START, END, 2000);

    expect(all).toHaveBeenCalledWith(START, END, 2000);
    expect(rows).toHaveLength(250);
  });

  it("clamps limit 0 and negative values to 1", () => {
    const { repository, all } = createRepo(5);

    repository.listByTimeRange(START, END, 0);
    repository.listByTimeRange(START, END, -5);

    expect(all.mock.calls[0]).toEqual([START, END, 1]);
    expect(all.mock.calls[1]).toEqual([START, END, 1]);
  });
});
