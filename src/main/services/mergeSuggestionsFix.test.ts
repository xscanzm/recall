import { describe, expect, it, vi } from "vitest";
import { MemoryObjectRepository } from "../db/repositories/MemoryObjectRepository";
import {
  ProactiveItemRepository,
  type ProactiveItemStatus,
} from "../db/repositories/ProactiveItemRepository";
import { MemoryObjectAdmissionService } from "./MemoryObjectAdmissionService";
import { mergeObjects } from "./cascadeMark";

interface TestProactiveItem {
  id: string;
  type: "merge_suggestion";
  status: ProactiveItemStatus;
  payload_json: string | null;
  title?: string;
  body?: string;
  reason?: string;
  priority?: number;
  surface?: string;
  requires_user_confirmation?: number;
  source_fact_ids_json?: string;
  source_scene_ids_json?: string;
  created_at?: string;
  updated_at?: string;
}

function createProactiveDb(
  items: TestProactiveItem[],
  options: { throwOnUpdateId?: string; hideAfterUpdateId?: string } = {}
) {
  return {
    prepare: vi.fn((sql: string) => {
      if (sql.includes("SELECT id, payload_json, status FROM proactive_items")) {
        return {
          all: () => items.map(({ id, payload_json, status }) => ({ id, payload_json, status })),
        };
      }
      if (sql.includes("UPDATE proactive_items SET")) {
        return {
          run: (...args: unknown[]) => {
            const status = args[0] as ProactiveItemStatus;
            const id = args[args.length - 1] as string;
            if (id === options.throwOnUpdateId) {
              throw new Error("SQLITE_WRITE_FAIL");
            }
            const item = items.find((candidate) => candidate.id === id);
            if (!item) return { changes: 0 };
            item.status = status;
            item.updated_at = args[1] as string;
            return { changes: 1 };
          },
        };
      }
      if (sql.includes("SELECT * FROM proactive_items WHERE id = ?")) {
        return {
          get: (id: string) => {
            if (id === options.hideAfterUpdateId) return undefined;
            const item = items.find((candidate) => candidate.id === id);
            if (!item) return undefined;
            return {
              title: "merge",
              body: "merge",
              reason: "test",
              priority: 0,
              surface: "memory",
              requires_user_confirmation: 1,
              source_fact_ids_json: "[]",
              source_scene_ids_json: "[]",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
              ...item,
            };
          },
        };
      }
      return { all: () => [], run: () => ({ changes: 0 }), get: () => undefined };
    }),
  };
}

describe("Phase 0: 对象身份归一化、Alias 匹配与合并建议状态修正", () => {
  it("人物 alias 使用 NFKC/大小写/空白归一，并保留强字段冲突保护", () => {
    const people = [
      {
        id: "person-canonical",
        name: "张三",
        role: "HR",
        organization: "Recall",
        summary: "HR",
        avatar_url: null,
        source_fact_ids_json: '["fact-1"]',
        related_project_ids_json: "[]",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        deleted_at: null,
        orphan_status: null,
        aliases_json: '["Recall（HR）", "老张"]',
      },
    ];
    const db = {
      prepare: vi.fn(() => ({ all: () => people })),
    };
    const repo = new MemoryObjectRepository(db as never);

    expect(repo.findPersonByExactIdentity(" recall(hr) ", "hr", "RECALL")?.id)
      .toBe("person-canonical");
    expect(repo.findPersonByExactIdentity("老张", "Dev", "Recall")).toBeNull();
    expect(repo.findPersonByExactIdentity("老张")).toBeNull();
  });

  it("项目名称归一化可命中，归档项目和软删除人物不会被身份查询命中", () => {
    const projects = [
      {
        id: "project-active",
        name: "Recall（v1）",
        summary: "active",
        status: "active",
        last_active_at: null,
        source_fact_ids_json: "[]",
        source_scene_ids_json: "[]",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        archived_at: null,
        orphan_status: null,
        aliases_json: null,
      },
      {
        id: "project-archived",
        name: "Archived",
        summary: "archived",
        status: "archived",
        last_active_at: null,
        source_fact_ids_json: "[]",
        source_scene_ids_json: "[]",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        archived_at: "2026-01-02T00:00:00.000Z",
        orphan_status: null,
        aliases_json: null,
      },
    ];
    const people = [
      {
        id: "person-deleted",
        name: "李四",
        role: "PM",
        organization: "Company A",
        summary: "deleted",
        source_fact_ids_json: "[]",
        related_project_ids_json: "[]",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        deleted_at: "2026-01-02T00:00:00.000Z",
        orphan_status: null,
        aliases_json: null,
      },
    ];
    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("FROM projects")) {
          return { all: () => projects.filter((project) => project.archived_at === null) };
        }
        if (sql.includes("FROM people")) {
          return { all: () => people.filter((person) => person.deleted_at === null) };
        }
        return { all: () => [] };
      }),
    };
    const repo = new MemoryObjectRepository(db as never);

    expect(repo.findProjectByExactIdentity(" recall(v1) ")?.id).toBe("project-active");
    expect(repo.findProjectByExactIdentity("Archived")).toBeNull();
    expect(repo.findPersonByExactIdentity("李四", "PM", "Company A")).toBeNull();
  });

  it("真实 Repository + AdmissionService 链路复用 alias，并隔离同名强字段冲突", () => {
    const peopleStore: Array<Record<string, unknown>> = [
      {
        id: "person-existing",
        name: "陈章",
        role: "PM",
        organization: "Company A",
        summary: "现有 PM",
        source_fact_ids_json: '["fact-old"]',
        related_project_ids_json: "[]",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        deleted_at: null,
        orphan_status: null,
        aliases_json: '["老陈"]',
        admission_status: "promoted",
        admission_decided_by: "user",
      },
    ];
    const createPerson = vi.fn((args: unknown[]) => {
      peopleStore.push({
        id: args[0],
        name: args[1],
        role: args[2],
        organization: args[3],
        summary: args[4],
        related_project_ids_json: args[5],
        source_fact_ids_json: args[6],
        created_at: args[7],
        updated_at: args[8],
        aliases_json: args[9],
        relationship: args[10],
        admission_status: args[11],
        admission_reason: args[12],
        admission_evidence_json: args[13],
        admission_decided_by: args[14],
        admission_rule_version: args[15],
        admission_reviewed_at: args[16],
        deleted_at: null,
        orphan_status: null,
      });
      return { changes: 1 };
    });
    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("SELECT * FROM people WHERE deleted_at IS NULL")) {
          return { all: () => peopleStore.filter((person) => person.deleted_at === null) };
        }
        if (sql.includes("UPDATE people SET")) {
          return {
            run: (...args: unknown[]) => {
              const person = peopleStore.find((candidate) => candidate.id === args[args.length - 1]);
              if (!person) return { changes: 0 };
              if (sql.includes("deleted_at = ?")) {
                person.deleted_at = args[0];
              } else if (sql.includes("source_fact_ids_json = ?")) {
                person.source_fact_ids_json = args[0];
              }
              return { changes: 1 };
            },
          };
        }
        if (sql.includes("INSERT INTO people")) {
          return { run: (...args: unknown[]) => createPerson(args) };
        }
        if (sql.includes("SELECT * FROM people WHERE id = ?")) {
          return { get: (id: string) => peopleStore.find((person) => person.id === id) };
        }
        return { all: () => [], run: () => ({ changes: 0 }), get: () => undefined };
      }),
    };
    const memoryObjectRepo = new MemoryObjectRepository(db as never);
    const facts = new Map([
      ["fact-alias", {
        id: "fact-alias",
        content: "老陈负责 PM 汇报",
        evidenceText: "老陈 PM",
        type: "person",
        peopleHints: ["老陈"],
        inferred: false,
        confidence: 0.9,
        sourceEpisodeIds: ["episode-alias"],
      }],
      ["fact-conflict", {
        id: "fact-conflict",
        content: "陈章在 Company B 担任 Dev",
        evidenceText: "陈章 Dev",
        type: "person",
        peopleHints: ["陈章"],
        inferred: false,
        confidence: 0.9,
        sourceEpisodeIds: ["episode-conflict"],
      }],
    ]);
    const admissionService = new MemoryObjectAdmissionService({
      memoryObjectRepo,
      factRepo: { listByIds: (ids: string[]) => ids.flatMap((id) => facts.get(id) ?? []) } as never,
    });

    const reused = admissionService.admitOrAccumulate({
      objectType: "person",
      title: "老陈",
      summary: "补充记录",
      sourceFactIds: ["fact-alias"],
      confidence: 0.9,
      role: "PM",
      organization: "Company A",
    });
    expect(reused.created).toBe(false);
    expect(reused.object.id).toBe("person-existing");
    expect(reused.object.sourceFactIds).toEqual(["fact-old", "fact-alias"]);

    const created = admissionService.admitOrAccumulate({
      objectType: "person",
      title: "陈章",
      summary: "独立 Dev 记录",
      sourceFactIds: ["fact-conflict"],
      confidence: 0.9,
      role: "Dev",
      organization: "Company B",
    });
    expect(created.created).toBe(true);
    expect(created.object.id).not.toBe("person-existing");
    expect(createPerson.mock.calls[0][0][6]).toBe('["fact-conflict"]');
    expect(peopleStore[1].source_fact_ids_json).toBe('["fact-conflict"]');
    expect(created.object.sourceFactIds).toEqual(["fact-conflict"]);
    expect(createPerson).toHaveBeenCalledTimes(1);
  });

  it("合并后正确终结相关建议，保护既有终态并保持幂等", () => {
    const items: TestProactiveItem[] = [
      { id: "direct", type: "merge_suggestion", status: "new", payload_json: JSON.stringify({ objectType: "project", fromId: "from", toId: "to" }) },
      { id: "reverse", type: "merge_suggestion", status: "snoozed", payload_json: JSON.stringify({ objectType: "project", fromId: "to", toId: "from" }) },
      { id: "other-from", type: "merge_suggestion", status: "new", payload_json: JSON.stringify({ objectType: "project", fromId: "from", toId: "other" }) },
      { id: "other-to", type: "merge_suggestion", status: "new", payload_json: JSON.stringify({ objectType: "project", fromId: "to", toId: "other" }) },
      { id: "ignored", type: "merge_suggestion", status: "ignored", payload_json: JSON.stringify({ objectType: "project", fromId: "from", toId: "to" }) },
      { id: "confirmed", type: "merge_suggestion", status: "confirmed", payload_json: JSON.stringify({ objectType: "project", fromId: "from", toId: "to" }) },
      { id: "done", type: "merge_suggestion", status: "done", payload_json: JSON.stringify({ objectType: "project", fromId: "from", toId: "other-2" }) },
      { id: "never", type: "merge_suggestion", status: "do_not_remind_again", payload_json: JSON.stringify({ objectType: "project", fromId: "from", toId: "other-3" }) },
      { id: "person", type: "merge_suggestion", status: "new", payload_json: JSON.stringify({ objectType: "person", fromId: "from", toId: "to" }) },
      { id: "malformed", type: "merge_suggestion", status: "new", payload_json: "{" },
    ];
    const repo = new ProactiveItemRepository(createProactiveDb(items) as never);

    repo.resolveMergeSuggestionsAfterMerge("project", "from", "to");
    repo.resolveMergeSuggestionsAfterMerge("project", "from", "to");

    expect(Object.fromEntries(items.map((item) => [item.id, item.status]))).toEqual({
      direct: "confirmed",
      reverse: "confirmed",
      "other-from": "done",
      "other-to": "new",
      ignored: "ignored",
      confirmed: "confirmed",
      done: "done",
      never: "do_not_remind_again",
      person: "new",
      malformed: "new",
    });
  });

  it("真实 ProactiveItemRepository 写异常会传播到 mergeObjects 事务边界", () => {
    const items: TestProactiveItem[] = [
      { id: "direct", type: "merge_suggestion", status: "new", payload_json: JSON.stringify({ objectType: "project", fromId: "from", toId: "to" }) },
    ];
    const db = {
      ...createProactiveDb(items, { throwOnUpdateId: "direct" }),
      transaction: (fn: () => void) => () => fn(),
    };
    const proactiveItemRepo = new ProactiveItemRepository(db as never);
    const memoryObjectRepo = {
      getProjectByIdActive: (id: string) => ({ id, name: id, sourceFactIds: [], sourceSceneIds: [], aliases: [] }),
      updateProject: vi.fn(),
      archiveProject: vi.fn(),
    };

    expect(() => mergeObjects(
      { db: db as never, memoryObjectRepo: memoryObjectRepo as never, proactiveItemRepo },
      "project",
      "from",
      "to"
    )).toThrow("SQLITE_WRITE_FAIL");
  });

  it("建议更新返回空结果时不会静默提交", () => {
    const items: TestProactiveItem[] = [
      { id: "missing", type: "merge_suggestion", status: "new", payload_json: JSON.stringify({ objectType: "project", fromId: "from", toId: "to" }) },
    ];
    const repo = new ProactiveItemRepository(createProactiveDb(items, { hideAfterUpdateId: "missing" }) as never);

    expect(() => repo.resolveMergeSuggestionsAfterMerge("project", "from", "to"))
      .toThrow("merge_suggestion missing 更新为 confirmed 失败");
  });

  it("stateful fake 在对象和建议部分写入后恢复全部合并状态", () => {
    const initialState = {
      fromProject: {
        id: "from",
        name: "Project A",
        archived: false,
        aliases: [] as string[],
        sourceFactIds: ["fact-from"],
        sourceSceneIds: ["scene-from"],
      },
      toProject: {
        id: "to",
        name: "Project B",
        archived: false,
        aliases: ["OldAlias"],
        sourceFactIds: ["fact-to"],
        sourceSceneIds: ["scene-to"],
      },
      suggestions: [{ id: "suggestion", status: "new" }],
    };
    let state = structuredClone(initialState);
    const db = {
      transaction: (fn: () => void) => () => {
        const snapshot = structuredClone(state);
        try {
          fn();
        } catch (error) {
          state = snapshot;
          throw error;
        }
      },
    };
    const memoryObjectRepo = {
      getProjectByIdActive: (id: string) => {
        if (id === "from" && !state.fromProject.archived) return state.fromProject;
        if (id === "to" && !state.toProject.archived) return state.toProject;
        return null;
      },
      updateProject: (_id: string, patch: Record<string, unknown>) => {
        if (patch.aliases) state.toProject.aliases = patch.aliases as string[];
        if (patch.sourceFactIds) state.toProject.sourceFactIds = patch.sourceFactIds as string[];
        if (patch.sourceSceneIds) state.toProject.sourceSceneIds = patch.sourceSceneIds as string[];
        return state.toProject;
      },
      archiveProject: () => {
        state.fromProject.archived = true;
        return true;
      },
    };
    const proactiveItemRepo = {
      resolveMergeSuggestionsAfterMerge: () => {
        state.suggestions[0].status = "confirmed";
        throw new Error("RESOLVER_FAIL_AFTER_PARTIAL_WRITE");
      },
    };

    expect(() => mergeObjects(
      { db: db as never, memoryObjectRepo: memoryObjectRepo as never, proactiveItemRepo: proactiveItemRepo as never },
      "project",
      "from",
      "to"
    )).toThrow("RESOLVER_FAIL_AFTER_PARTIAL_WRITE");

    expect(state).toEqual(initialState);
  });
});
