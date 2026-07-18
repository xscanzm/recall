import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  InfographicService,
  buildInfographicPrompt,
  buildInfographicVisualBrief,
} from "./InfographicService";
import type { Report } from "../models/types";

const report: Report = {
  id: "report_test_1",
  type: "weekly",
  dateKey: "2026-07-13",
  title: "本周工作总结",
  contentJson: JSON.stringify({
    id: "report_test_1",
    dateKey: "2026-07-13",
    overview: "完成了三个里程碑",
    sourceFactIds: ["fact_secret_should_not_be_sent"],
    reportRequirements: {
      reportType: "weekly",
      longTerm: { focus: "重点看里程碑", presentation: "用表格", reminders: "标出风险" },
      temporary: "本次单列客户反馈",
    },
  }),
  sourceFactIds: [],
  sourceSceneIds: [],
  createdAt: "2026-07-17T12:00:00.000Z",
  updatedAt: "2026-07-17T12:00:00.000Z",
};

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("InfographicService", () => {
  it("calls the proxy, downloads the image, and notifies after saving", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "recall-infographic-"));
    const onImageReady = vi.fn();
    const calls: string[] = [];
    const service = new InfographicService({
      storageDir: tempDir,
      proxyUrl: "https://proxy.test/api/infographic/generate",
      onImageReady,
      fetch: vi.fn(async (url) => {
        calls.push(url);
        if (url.includes("proxy.test")) {
          return new Response(JSON.stringify({ url: "https://cdn.test/report.png" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }),
    });

    const result = await service.generateForReport(report);

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      "https://proxy.test/api/infographic/generate",
      "https://cdn.test/report.png",
    ]);
    expect(onImageReady).toHaveBeenCalledWith(report.id);
    const image = await service.getImage(report.id);
    expect(image?.mimeType).toBe("image/png");
    expect(image?.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("includes both requirement layers and omits source metadata from the prompt", () => {
    const prompt = buildInfographicPrompt(report);
    expect(prompt).toContain("重点看里程碑");
    expect(prompt).toContain("本次单列客户反馈");
    expect(prompt).toContain("完成了三个里程碑");
    expect(prompt).not.toContain("fact_secret_should_not_be_sent");
    expect(prompt).toContain("不是文字报告截图");
    expect(prompt).toContain("16:9 横版");
    expect(prompt).not.toContain("overview:");
  });

  it("builds a short, content-driven visual brief for personal review", () => {
    const personalReport: Report = {
      ...report,
      type: "personal_daily_review",
      title: "我的复盘",
      contentJson: JSON.stringify({
        overview: "今天完成了客户方案，明确了下次评审的入口。",
        mainThreads: ["推进客户方案", "确认评审入口"],
        meaningfulProgress: ["完成方案初稿", "收敛页面结构"],
        unfinished: [
          {
            text: "补齐移动端检查",
            suggestedNextAction: "明天先走一遍移动端流程",
            sourceFactIds: ["secret-id"],
          },
        ],
        tomorrowStartHere: ["先做移动端检查"],
        worthRemembering: [{ text: "先把结构定下来，再补视觉细节" }],
      }),
    };
    const brief = buildInfographicVisualBrief(personalReport);
    expect(brief).toContain("今天的主线");
    expect(brief).toContain("明日入口");
    expect(brief).toContain("值得保留");
    expect(brief).toContain("补齐移动端检查");
    expect(brief).not.toContain("sourceFactIds");
    expect(brief).not.toContain("secret-id");

    const prompt = buildInfographicPrompt(personalReport);
    expect(prompt).toContain("我的复盘");
    expect(prompt).toContain("日常观察地图");
    expect(prompt).toContain("主视觉隐喻");
    expect(prompt).toContain("产品提案工作室");
    expect(prompt).not.toContain("mainThreads:");
  });

  it("changes the visual treatment when the report topic is technical", () => {
    const technicalReport: Report = {
      ...report,
      type: "daily",
      title: "API 部署进展",
      contentJson: JSON.stringify({
        overview: "完成 API 接口部署和测试",
        projectUpdates: ["Worker 服务已上线"],
        completed: ["通过接口测试"],
        tomorrowSuggestions: ["观察线上稳定性"],
      }),
    };
    expect(buildInfographicPrompt(technicalReport)).toContain("创意技术控制室");
  });

  it("uses different visual directions for the four report purposes", () => {
    const cases: Array<[Report["type"], string]> = [
      ["personal_daily_review", "日常观察地图"],
      ["work_daily_report", "行动控制台"],
      ["daily", "今日进展叙事"],
      ["weekly", "项目航线与里程碑"],
      ["monthly", "阶段全景与趋势"],
    ];
    for (const [type, direction] of cases) {
      expect(buildInfographicPrompt({ ...report, type })).toContain(direction);
    }
  });

  it("uses the month-specific next-stage suggestions for monthly visuals", () => {
    const monthlyReport: Report = {
      ...report,
      type: "monthly",
      title: "七月月报",
      contentJson: JSON.stringify({
        overview: "本月完成主要交付。",
        projectUpdates: [],
        completed: ["完成交付"],
        risks: [],
        nextMonthSuggestions: ["下月继续推进验证"],
      }),
    };

    const brief = buildInfographicVisualBrief(monthlyReport);

    expect(brief).toContain("下一阶段");
    expect(brief).toContain("下月继续推进验证");
  });

  it("does not send malformed raw content to the image model", () => {
    const malformed: Report = {
      ...report,
      contentJson: '{"overview":"should not leak", "sourceFactIds":["secret"]',
    };
    const brief = buildInfographicVisualBrief(malformed);
    expect(brief).toContain("主题：本周工作总结");
    expect(brief).not.toContain("should not leak");
    expect(brief).not.toContain("sourceFactIds");
    expect(brief).not.toContain("secret");
  });

  it("does not accept a non-HTTPS image URL", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "recall-infographic-"));
    const service = new InfographicService({
      storageDir: tempDir,
      proxyUrl: "https://proxy.test/api/infographic/generate",
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ url: "http://unsafe.test/report.png" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      ),
    });

    const result = await service.generateForReport(report);

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid_image_url");
    expect(await service.getImage(report.id)).toBeNull();
  });

  it("treats an unavailable proxy as a non-fatal capability failure", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "recall-infographic-"));
    const service = new InfographicService({
      storageDir: tempDir,
      proxyUrl: "https://proxy.test/api/infographic/generate",
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
    });

    await expect(service.generateForReport(report)).resolves.toMatchObject({
      ok: false,
      errorCode: "capability_unavailable",
    });
  });
});
