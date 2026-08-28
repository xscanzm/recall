import { describe, expect, it, vi } from "vitest";
import { ObservationRepository } from "./ObservationRepository";
import type { CreateObservationInput } from "../../models/types";

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

// ============================================================================
// generation_path（migration 031）：L0 观察溯源列读写
//
// 沿用本文件既有的 mock DB 模式（伪 prepare/statement 对象）：
// - 断言 INSERT 语句包含 generation_path 列、绑定参数含该值
// - 断言 mapRow 把 row.generation_path 映射为 generationPath
// ============================================================================

function gpRowFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "obs-gp-1",
    capture_id: "capture-gp-1",
    captured_at: "2026-08-28T10:00:00.000Z",
    app_name: "Google Chrome",
    window_title: "回声Recall",
    url_or_domain: null,
    capture_reason: "window_focus",
    scene_summary: "批次摘要",
    visible_content_json: "[]",
    detected_entities_json: "[]",
    possible_intent: null,
    possible_tasks_json: "[]",
    possible_decisions_json: "[]",
    sensitivity: "normal",
    confidence: 0.9,
    uncertainties_json: "[]",
    screenshot_retention: "today",
    screenshot_paths_json: "[]",
    created_at: "2026-08-28T10:00:01.000Z",
    user_facing_summary: null,
    likely_work_purpose: null,
    privacy_risk: null,
    reportable_signal: null,
    generation_path: null,
    ...overrides,
  };
}

function gpInput(overrides: Partial<CreateObservationInput> = {}): CreateObservationInput {
  return {
    captureId: "capture-gp-1",
    capturedAt: "2026-08-28T10:00:00.000Z",
    appName: "Google Chrome",
    windowTitle: "回声Recall",
    urlOrDomain: null,
    captureReason: "window_focus",
    sceneSummary: "批次摘要",
    visibleContent: [],
    detectedEntities: [],
    possibleIntent: null,
    possibleTasks: [],
    possibleDecisions: [],
    sensitivity: "normal",
    confidence: 0.9,
    uncertainties: [],
    screenshotRetention: "today",
    screenshotPaths: [],
    ...overrides,
  };
}

function createGpRepo(returnedRow: Record<string, unknown> | undefined) {
  const run = vi.fn();
  const prepare = vi.fn((sql: string) => ({
    run,
    // getByCaptureId 预检查（WHERE capture_id）返回 undefined 以继续插入；getById 返回伪造行
    get: vi.fn(() => (sql.includes("WHERE capture_id") ? undefined : returnedRow)),
  }));
  return { repository: new ObservationRepository({ prepare } as never), prepare, run };
}

function insertSqlOf(prepare: ReturnType<typeof vi.fn>): string {
  const call = prepare.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO observations"));
  if (!call) throw new Error("未捕获到 INSERT INTO observations 语句");
  return String(call[0]);
}

describe("ObservationRepository.generation_path (migration 031)", () => {
  it("create() 传 generationPath：INSERT 含 generation_path 列且绑定传入值", () => {
    const { repository, prepare, run } = createGpRepo(gpRowFixture({ generation_path: "ocr_fallback:v1" }));

    const created = repository.create(gpInput({ generationPath: "ocr_fallback:v1" }));

    expect(insertSqlOf(prepare)).toContain("generation_path");
    const insertArgs = run.mock.calls[0] as unknown[];
    expect(insertArgs).toHaveLength(24); // 23 既有占位符 + generation_path
    expect(insertArgs).toContain("ocr_fallback:v1");
    expect(created.generationPath).toBe("ocr_fallback:v1");
  });

  it("create() 传 generationPath：getById 读回 generationPath（mapRow 映射 row.generation_path）", () => {
    const { repository } = createGpRepo(gpRowFixture({ generation_path: "ocr_fallback:v1" }));

    const created = repository.create(gpInput({ generationPath: "ocr_fallback:v1" }));

    expect(repository.getById(created.id)?.generationPath).toBe("ocr_fallback:v1");
  });

  it("create() 不传 generationPath：绑定为 null，读回为 null", () => {
    const { repository, prepare, run } = createGpRepo(gpRowFixture({ generation_path: null }));

    const created = repository.create(gpInput());

    expect(insertSqlOf(prepare)).toContain("generation_path");
    const insertArgs = run.mock.calls[0] as unknown[];
    expect(insertArgs[insertArgs.length - 1]).toBeNull(); // input.generationPath ?? null
    expect(repository.getById(created.id)?.generationPath).toBeNull();
  });
});
