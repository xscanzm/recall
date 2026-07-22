import { describe, expect, it, vi } from "vitest";
import { FactRepository } from "./FactRepository";

const rows = [
  factRow("fact-1", "first", ["obs-1"], null, "2026-01-01"),
  factRow("fact-2", "second", ["obs-501"], null, "2026-01-02"),
  factRow("fact-deleted", "deleted", ["obs-501"], "2026-01-04", "2026-01-03"),
];

describe("FactRepository source links", () => {
  it("queries observation-linked facts in chunks and deduplicates results", () => {
    const all = vi.fn((...ids: string[]) => rows.filter((row) =>
      row.deleted_at === null
      && JSON.parse(row.source_observation_ids_json).some((id: string) => ids.includes(id))
    ));
    const prepare = vi.fn((sql: string) => {
      expect(sql).toContain("json_each(facts.source_observation_ids_json)");
      expect(sql).toContain("deleted_at IS NULL");
      return { all };
    });
    const repository = new FactRepository({ prepare } as never);
    const observationIds = Array.from({ length: 502 }, (_, index) => `obs-${index}`);

    const facts = repository.listBySourceObservationIds(observationIds);

    expect(facts.map((fact) => fact.id)).toEqual(["fact-1", "fact-2"]);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(all.mock.calls[0]).toHaveLength(500);
    expect(all.mock.calls[1]).toHaveLength(2);
  });
});

function factRow(
  id: string,
  content: string,
  sourceObservationIds: string[],
  deletedAt: string | null,
  createdAt: string
) {
  return {
    id,
    type: "note",
    content,
    status: null,
    project_id: null,
    project_hint: null,
    importance: 0.5,
    confidence: 0.9,
    inferred: 0,
    evidence_text: null,
    source_observation_ids_json: JSON.stringify(sourceObservationIds),
    tags_json: "[]",
    created_at: createdAt,
    updated_at: createdAt,
    deleted_at: deletedAt,
    display_use: null,
    reportable: null,
    private_risk: null,
    user_value: null,
    people_hints_json: null,
    source_episode_ids_json: "[]",
    claim_status: "active",
    generation_path: null,
    generation_version: 1,
    derivation_key: null,
  };
}
