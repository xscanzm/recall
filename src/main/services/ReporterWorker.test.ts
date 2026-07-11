import { describe, expect, it } from "vitest";
import { filterReportableSources } from "./ReporterWorker";

describe("filterReportableSources", () => {
  it("excludes explicit non-reportable and high-private legacy sources", () => {
    const sources = [
      { id: "legacy" },
      { id: "safe", reportable: true, privateRisk: "medium" },
      { id: "not-reportable", reportable: false, privateRisk: "low" },
      { id: "private", reportable: true, privateRisk: "high" },
    ];

    expect(filterReportableSources(sources).map((source) => source.id)).toEqual([
      "legacy",
      "safe",
    ]);
  });
});
