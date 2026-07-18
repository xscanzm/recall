// 报告信息图能力
//
// 统一图像服务只在主进程调用。桌面端只访问代理地址，不持有上游 API Key；
// 生成完成后把图片下载到 userData/report-images，渲染端只通过受控 IPC 读取 data URL。

import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Report } from "../models/types";
import type { ReportGenerationRequirementsSnapshot } from "../../shared/reportRequirements";
import { logger } from "./Logger";

export const DEFAULT_INFOGRAPHIC_PROXY_URL =
  "https://recall-update.ppclaw.online/api/infographic/generate";

const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_REQUEST_TIMEOUT_MS = 180_000;
// 上游 prompt 上限为 4096 tokens；视觉简报应留出足够空间给构图指令，
// 不把大段报告正文塞进图像模型。
const PROMPT_MAX_CHARS = 6_000;
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;
type ImageExtension = (typeof IMAGE_EXTENSIONS)[number];

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface InfographicImage {
  dataUrl: string;
  mimeType: string;
}

export interface InfographicGenerationResult {
  ok: boolean;
  imagePath?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface InfographicServiceDeps {
  /** 生产环境默认使用更新 Worker 的同域代理；测试可注入本地地址。 */
  proxyUrl?: string;
  /** 测试可注入临时目录；生产默认位于 app.getPath("userData")。 */
  storageDir?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  onImageReady?: (reportId: string) => void;
}

/**
 * 信息图生成器只负责报告信息图，不参与正文生成，也不会阻塞正文落库。
 */
export class InfographicService {
  private readonly proxyUrl: string;
  private readonly storageDir: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly onImageReady?: (reportId: string) => void;
  private readonly inFlight = new Set<string>();

  constructor(deps: InfographicServiceDeps = {}) {
    this.proxyUrl =
      deps.proxyUrl ??
      process.env.RECALL_INFOGRAPHIC_PROXY_URL?.trim() ??
      DEFAULT_INFOGRAPHIC_PROXY_URL;
    this.storageDir =
      deps.storageDir ?? path.join(app.getPath("userData"), "report-images");
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = deps.timeoutMs ?? IMAGE_REQUEST_TIMEOUT_MS;
    this.onImageReady = deps.onImageReady;
  }

  /**
   * 异步生成并保存一张报告信息图。调用方应 fire-and-forget，失败不影响正文报告。
   */
  async generateForReport(
    report: Report,
    reportRequirements?: ReportGenerationRequirementsSnapshot
  ): Promise<InfographicGenerationResult> {
    if (!this.proxyUrl || !isSafeReportId(report.id)) {
      return { ok: false, errorCode: "capability_unavailable" };
    }
    if (this.inFlight.has(report.id)) {
      return { ok: false, errorCode: "already_running" };
    }

    this.inFlight.add(report.id);
    logger.info({
      jobType: "report_infographic",
      status: "started",
      message: `report=${report.id}, type=${infographicReportType(report.type)}`,
    });
    try {
      // 重新生成时先移除旧图，避免正文与旧图短暂错配。
      await this.deleteImage(report.id);
      const prompt = buildInfographicPrompt(report, reportRequirements);
      const proxyResponse = await this.fetchWithTimeout(this.proxyUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Client-Version": safeClientVersion(),
        },
        body: JSON.stringify({
          reportType: infographicReportType(report.type),
          prompt,
        }),
      });

      if (!proxyResponse.ok) {
        const unavailable = proxyResponse.status === 404 || proxyResponse.status === 405 || proxyResponse.status === 503;
        logger.warn({
          jobType: "report_infographic",
          status: "failed",
          errorCode: unavailable ? "capability_unavailable" : "proxy_failed",
          message: `report=${report.id}, proxy_status=${proxyResponse.status}`,
        });
        return {
          ok: false,
          errorCode: unavailable ? "capability_unavailable" : "proxy_failed",
          errorMessage: `信息图代理返回 HTTP ${proxyResponse.status}`,
        };
      }

      const proxyBody = (await proxyResponse.json()) as { url?: unknown };
      const imageUrl = parseImageUrl(proxyBody.url);
      if (!imageUrl) {
        return { ok: false, errorCode: "invalid_image_url", errorMessage: "信息图服务未返回有效图片地址" };
      }

      const imagePath = await this.downloadImage(report.id, imageUrl);
      try {
        this.onImageReady?.(report.id);
      } catch {
        // 推送失败不影响已保存图片。
      }
      logger.info({
        jobType: "report_infographic",
        status: "succeeded",
        message: `report=${report.id}`,
      });
      return { ok: true, imagePath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({
        jobType: "report_infographic",
        status: "failed",
        errorCode: "generation_failed",
        message: `report=${report.id}, ${message.slice(0, 160)}`,
      });
      return { ok: false, errorCode: "generation_failed", errorMessage: message };
    } finally {
      this.inFlight.delete(report.id);
    }
  }

  /** 读取已保存图片，供 renderer 通过 IPC 展示。 */
  async getImage(reportId: string): Promise<InfographicImage | null> {
    if (!isSafeReportId(reportId)) return null;
    const imagePath = await this.findImagePath(reportId);
    if (!imagePath) return null;
    try {
      const bytes = await fs.promises.readFile(imagePath);
      const extension = path.extname(imagePath).slice(1) as ImageExtension;
      const mimeType = mimeTypeForExtension(extension);
      return {
        mimeType,
        dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
      };
    } catch {
      return null;
    }
  }

  /** 删除报告对应的信息图，编辑或物理删除报告时调用。 */
  async deleteImage(reportId: string): Promise<void> {
    if (!isSafeReportId(reportId)) return;
    await Promise.all(
      IMAGE_EXTENSIONS.map(async (extension) => {
        try {
          await fs.promises.unlink(this.imagePath(reportId, extension));
        } catch {
          // 文件不存在是正常情况。
        }
      })
    );
  }

  /** 清空所有已落盘的信息图，随数据清空一起执行。 */
  async clearAllImages(): Promise<void> {
    try {
      const entries = await fs.promises.readdir(this.storageDir, { withFileTypes: true });
      await Promise.all(
        entries
          .filter(
            (entry) =>
              entry.isFile() &&
              IMAGE_EXTENSIONS.some((extension) => entry.name.endsWith(`.${extension}`))
          )
          .map((entry) =>
            fs.promises.unlink(path.join(this.storageDir, entry.name)).catch(() => undefined)
          )
      );
    } catch {
      // 目录不存在时视为已经清空。
    }
  }

  private async downloadImage(reportId: string, imageUrl: string): Promise<string> {
    const response = await this.fetchWithTimeout(imageUrl, {
      headers: { Accept: "image/*" },
    });
    if (!response.ok) {
      throw new Error(`图片下载失败 HTTP ${response.status}`);
    }

    const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declaredLength) && declaredLength > IMAGE_MAX_BYTES) {
      throw new Error("图片文件超过本地保存大小限制");
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_MAX_BYTES) {
      throw new Error("图片文件为空或超过本地保存大小限制");
    }

    const extension = chooseImageExtension(
      response.headers.get("content-type"),
      imageUrl
    );
    if (!extension) {
      throw new Error("图片服务返回了不支持的文件类型");
    }

    await fs.promises.mkdir(this.storageDir, { recursive: true });
    await this.deleteImage(reportId);
    const destination = this.imagePath(reportId, extension);
    const temporary = `${destination}.${Date.now().toString(36)}.tmp`;
    try {
      await fs.promises.writeFile(temporary, bytes);
      await fs.promises.rename(temporary, destination);
    } finally {
      try {
        await fs.promises.unlink(temporary);
      } catch {
        // rename 成功后临时文件已不存在。
      }
    }
    return destination;
  }

  private async findImagePath(reportId: string): Promise<string | null> {
    for (const extension of IMAGE_EXTENSIONS) {
      const candidate = this.imagePath(reportId, extension);
      try {
        await fs.promises.access(candidate, fs.constants.R_OK);
        return candidate;
      } catch {
        // 尝试下一个扩展名。
      }
    }
    return null;
  }

  private imagePath(reportId: string, extension: ImageExtension): string {
    return path.join(this.storageDir, `${reportId}.${extension}`);
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

export function buildInfographicPrompt(
  report: Report,
  reportRequirements?: ReportGenerationRequirementsSnapshot
): string {
  const snapshot = reportRequirements ?? readRequirements(report.contentJson);
  const brief = buildVisualBrief(report);
  const reportType = infographicReportType(report.type);
  const direction = visualDirectionFor(reportType);
  const visualConcept = chooseVisualConcept(reportType, brief);
  const contentStyle = chooseContentVisualStyle(reportType, brief);
  const requirementLines = formatVisualRequirements(snapshot);
  const sceneDescription = buildInfographicSceneDescription(brief, direction, visualConcept);
  const prompt = [
    `生成一张 16:9 横版中文信息图，放在 Recall 的文字报告上方。画面主标题必须是“${brief.title}”。`,
    `这是一张${reportTypeLabel(reportType)}的视觉叙事图，不是文字报告截图。副标题使用“${brief.lead || "把今天的变化组织成一条清晰的路径"}”。`,
    sceneDescription,
    `整体采用${direction.name}的视觉语言：${trimSentencePunctuation(direction.palette)}。构图参考：${direction.composition}`,
    `版式安排：${visualLayoutFor(reportType)}`,
    `主视觉隐喻：${visualConcept}`,
    `根据这份报告的内容采用${contentStyle.name}：${contentStyle.elements}。整体气质${contentStyle.mood}。不要把这条风格说明画成文字。`,
    "画面要有明确主视觉、3-5 个有关系的区块、至少两种图形表达（路线/节点、进度环、关系图、风险标记等）；没有真实数字时只用关系和路径，不画虚构图表。",
    "只把场景描述中用引号标出的短句作为画面文字；不要把本段说明、字段名、标签冒号、项目符号、JSON、API、Worker、模型名、来源 ID、密钥、空值或整段正文画出来。所有其余信息用图形关系表达。",
    "每个短标题和短句最多出现一次，不要重复副标题；风格要有趣、好看、有内容价值，不要默认猫咪、粉色或通用商务卡片模板。",
    requirementLines,
  ].join("\n");
  return truncatePrompt(prompt, PROMPT_MAX_CHARS);
}

interface VisualBriefSection {
  label: string;
  kind: "progress" | "open" | "risk" | "project" | "decision" | "next" | "memory";
  items: string[];
}

interface VisualBrief {
  title: string;
  lead: string;
  sections: VisualBriefSection[];
  signals: {
    projects: number;
    progress: number;
    open: number;
    risks: number;
    decisions: number;
  };
}

interface VisualDirection {
  name: string;
  composition: string;
  palette: string;
  defaultConcept: string;
}

const VISUAL_DIRECTIONS: Record<string, VisualDirection> = {
  personal: {
    name: "个人复盘的日常观察地图",
    composition: "以一条有起伏的日程路径或一天的光线变化做主轴，沿途放置 2-4 个关键节点；末端自然连接到明日入口。",
    palette: "根据当天内容选择一组有情绪但克制的双色或三色配色，例如雾蓝与暖橙、森林绿与米白；避免固定粉色模板。",
    defaultConcept: "从今天的起点经过几个关键节点，最后抵达一个清晰的明日入口。",
  },
  work: {
    name: "工作日报的行动控制台",
    composition: "以四种状态形成一条可读的行动流；用进度轨道、旗帜、警示符号或小型流程图表达状态，不要堆四个文字卡片。",
    palette: "以深色文字和明亮强调色建立层级，颜色随风险和进展调整，保持专业但有一点节奏感。",
    defaultConcept: "一条从已完成事项通往下一步的行动路线，中间标出项目推进和需要注意的岔路。",
  },
  daily: {
    name: "日报的今日进展叙事",
    composition: "突出今天的一条主线，用主视觉串联几个有因果关系的节点；把零散事项合并为 3-5 个有层次的视觉节点。",
    palette: "使用清爽、明快但不幼稚的配色，让完成、风险和下一步有不同的视觉信号。",
    defaultConcept: "把今天的工作看成一段有起点、转折和下一站的短旅程。",
  },
  weekly: {
    name: "周报的项目航线与里程碑",
    composition: "用项目航线、地铁图、登山路线或棋盘式进度图表达一周的推进关系；重点突出关键站点、交汇关系和需要绕行的节点。",
    palette: "用 1 个主色搭配 2 个语义强调色，颜色区分项目状态而不是装饰；保留足够留白。",
    defaultConcept: "一周是一条有几个站点的项目航线，已完成的站点、当前站点和下一站一眼可见。",
  },
  monthly: {
    name: "月报的阶段全景与趋势",
    composition: "用一个全景隐喻（地图、星图、季节轮盘、城市建设或生态系统）承载这段时间的变化；支持一眼看全局、再看局部。",
    palette: "选择更有章节感的配色和材质，体现阶段变化；避免复制周报的横向卡片布局。",
    defaultConcept: "把一个月看成一段阶段旅程，用全景结构显示已经形成的成果和下一阶段的方向。",
  },
};

const VISUAL_TEXT_MAX_CHARS = 42;
const VISUAL_TITLE_MAX_CHARS = 18;
const VISUAL_SECTION_MAX_ITEMS = 3;
const VISUAL_TOTAL_MAX_ITEMS = 10;

/** 将报告 JSON 提炼为图像模型可以重构的短事实卡片，不把技术字段传给模型。 */
export function buildInfographicVisualBrief(report: Report): string {
  const brief = buildVisualBrief(report);
  const lines = [
    `主题：${brief.title}`,
    `核心叙事：${brief.lead || "围绕报告中的主要变化组织画面"}`,
    `内容信号：${formatSignalCounts(brief.signals)}`,
  ];
  for (const section of brief.sections) {
    lines.push(`${section.label}：`);
    for (const item of section.items) lines.push(`- ${item}`);
  }
  return lines.join("\n");
}

function buildVisualBrief(report: Report): VisualBrief {
  const content = parseReportContent(report.contentJson);
  const reportType = infographicReportType(report.type);
  const sections: VisualBriefSection[] = [];
  const addSection = (
    label: string,
    kind: VisualBriefSection["kind"],
    values: unknown
  ): void => {
    const items = extractVisualItems(values);
    if (items.length > 0) sections.push({ label, kind, items });
  };

  if (reportType === "personal") {
    addSection("今天的主线", "progress", content.mainThreads);
    addSection("关键进展", "progress", content.meaningfulProgress);
    addSection("还未收尾", "open", content.unfinished);
    addSection("明日入口", "next", content.tomorrowStartHere);
    addSection("值得保留", "memory", content.worthRemembering);
  } else if (reportType === "work") {
    const sectionsValue = asRecord(content.sections);
    addSection("今日完成", "progress", sectionsValue?.completed);
    addSection("项目推进", "project", sectionsValue?.projectProgress);
    addSection("风险提醒", "risk", sectionsValue?.risks ?? content.warnings);
    addSection("下一步", "next", sectionsValue?.tomorrowPlan);
  } else {
    addSection("项目进展", "project", content.projectUpdates);
    addSection("已完成", "progress", content.completed);
    addSection("风险与阻塞", "risk", content.risks);
    addSection(
      reportType === "monthly" ? "下一阶段" : "下一步",
      "next",
      reportType === "daily"
        ? content.tomorrowSuggestions
        : reportType === "monthly"
        ? content.nextMonthSuggestions ?? content.nextWeekSuggestions
        : content.nextWeekSuggestions
    );
    addSection("关键决策", "decision", content.decisions);
    addSection(
      "待确认",
      "open",
      hasItems(content.openTasks) ? content.openTasks : content.needsReview
    );
  }

  if (sections.length === 0) {
    addSection("报告摘要", "progress", content.plainText ?? content.overview);
  }

  const signals = {
    projects: countSectionItems(sections, "project"),
    progress: countSectionItems(sections, "progress"),
    open: countSectionItems(sections, "open"),
    risks: countSectionItems(sections, "risk"),
    decisions: countSectionItems(sections, "decision"),
  };
  return {
    title: (cleanVisualText(report.title) || reportTypeLabel(reportType)).slice(0, VISUAL_TITLE_MAX_CHARS),
    lead: cleanVisualText(firstText(content, ["headline", "overview", "plainText"])) || "",
    sections: limitVisualSections(sections, reportType),
    signals,
  };
}

function parseReportContent(contentJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(contentJson) as unknown;
    return asRecord(parsed) ?? {};
  } catch {
    // 报告 contentJson 按合约应为 JSON。解析失败时只保留标题和类型，
    // 不把未知原文直接发送到第三方图像服务。
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstText(content: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (typeof content[key] === "string" && content[key].trim()) return content[key] as string;
  }
  return "";
}

function extractVisualItems(value: unknown): string[] {
  const rawItems = Array.isArray(value) ? value : [value];
  const items: string[] = [];
  for (const raw of rawItems) {
    const object = asRecord(raw);
    const text = object ? visualItemText(object) : typeof raw === "string" ? raw : "";
    if (!text) continue;
    const cleaned = cleanVisualText(text);
    if (cleaned && !items.includes(cleaned)) items.push(cleaned);
    if (items.length >= VISUAL_SECTION_MAX_ITEMS) break;
  }
  return items;
}

function hasItems(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function visualItemText(object: Record<string, unknown>): string {
  const projectName = textOf(object.projectName);
  const primary = [
    object.text,
    object.summary,
    object.progress,
    object.title,
    projectName,
    object.reason,
    object.body,
  ].find((candidate): candidate is string =>
    typeof candidate === "string" && candidate.trim().length > 0
  );
  if (!primary) return "";
  const detail = typeof primary === "string" ? primary : "";
  const action = textOf(object.suggestedNextAction);
  const prefix = projectName && primary !== projectName ? `${projectName}：` : "";
  const suffix = action && object.text ? `；下一步：${action}` : "";
  return `${prefix}${detail}${suffix}`;
}

function cleanVisualText(value: string): string {
  const cleaned = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\b(?:overview|mainThreads|meaningfulProgress|projectUpdates|sourceFactIds|sourceSceneIds)\b/gi, "")
    .replace(/(?:https?:\/\/|Bearer\s+|sk-[A-Za-z0-9]|token\s*[=:]|secret\s*[=:])[^\s，。；;]+/gi, "[敏感内容]")
    .replace(/^[-*•：:]+/, "")
    .trim()
    .slice(0, VISUAL_TEXT_MAX_CHARS);
  return cleaned.includes("[敏感内容]") ? "" : cleaned;
}

function buildInfographicSceneDescription(
  brief: VisualBrief,
  direction: VisualDirection,
  visualConcept: string
): string {
  const sectionSentences = brief.sections.map((section) => {
    const items = section.items.map((item) => `“${item}”`).join("、");
    if (section.kind === "memory") {
      return `角落便签标题“${section.label}”，短句 ${items}`;
    }
    return `区块标题“${section.label}”，对应短句 ${items}`;
  });
  return [
    `主视觉使用${visualConcept}，让内容从起点自然走向下一步。`,
    `画面中的可见文字清单：${sectionSentences.join("；")}。`,
  ].join(" ");
}

function countSectionItems(
  sections: VisualBriefSection[],
  kind: VisualBriefSection["kind"]
): number {
  return sections
    .filter((section) => section.kind === kind)
    .reduce((count, section) => count + section.items.length, 0);
}

function limitVisualSections(
  sections: VisualBriefSection[],
  reportType: string
): VisualBriefSection[] {
  const maxItems = reportType === "personal" ? 8 : VISUAL_TOTAL_MAX_ITEMS;
  const maxSections = reportType === "personal" ? 5 : 4;
  const limited: VisualBriefSection[] = [];
  let remaining = maxItems;
  for (const section of sections) {
    if (remaining <= 0 || limited.length >= maxSections) break;
    const items = section.items.slice(0, remaining);
    if (items.length === 0) continue;
    limited.push({ ...section, items });
    remaining -= items.length;
  }
  return limited;
}

function formatSignalCounts(signals: VisualBrief["signals"]): string {
  return `项目 ${signals.projects}，进展 ${signals.progress}，未完 ${signals.open}，风险 ${signals.risks}，决策 ${signals.decisions}`;
}

function visualDirectionFor(reportType: string): VisualDirection {
  return VISUAL_DIRECTIONS[reportType] ?? VISUAL_DIRECTIONS.work;
}

function visualLayoutFor(reportType: string): string {
  switch (reportType) {
    case "personal":
      return "单行四列，从左到右放置四个不同区块；右下角补一张小便签；不要复制标题或内容。";
    case "work":
      return "从左到右只有四段行动流，每段只出现一次，不要上下重复排版。";
    case "daily":
      return "从左到右是一条今日主线，内容沿一条路径推进；不要把同一内容放在上下两排。";
    case "weekly":
      return "横向是一条项目航线，站点各自不同；每个站点和标签只出现一次。";
    case "monthly":
      return "中心是阶段全景主视觉，周围安排四个不同方向，不使用重复卡片。";
    default:
      return "单一主视觉配合 3-4 个互不重复的内容区块。";
  }
}

function chooseVisualConcept(reportType: string, brief: VisualBrief): string {
  if (brief.signals.risks > 0 && brief.signals.progress > 0) {
    return "一条穿过晴区与风暴区的行动航线：绿色节点代表已完成，暖色警示点代表风险，终点连接下一步。";
  }
  if (brief.signals.projects >= 2) {
    return "一张有交汇站点的项目地铁图：不同项目是不同线路，关键成果是已到达站点，交汇处表现协同关系。";
  }
  if (brief.signals.open > brief.signals.progress && brief.signals.open > 0) {
    return "一座正在搭建的桥或一条未闭合的环路：已经完成的部分坚实可见，未完事项形成少量明确的缺口。";
  }
  if (brief.signals.decisions > 0) {
    return "一张带有分岔和落点的决策地图：用清晰的方向箭头和少量路标表达选择及其后续路径。";
  }
  return visualDirectionFor(reportType).defaultConcept;
}

interface ContentVisualStyle {
  name: string;
  elements: string;
  mood: string;
}

const CONTENT_VISUAL_STYLES: Array<{
  keywords: RegExp;
  style: ContentVisualStyle;
}> = [
  {
    keywords: /客户|方案|评审|产品|页面|设计|界面|原型/,
    style: {
      name: "产品提案工作室",
      elements: "用方案稿、便签、评审标记、页面缩略图和一条收敛方向的箭头表现变化",
      mood: "像一张有温度的创意工作台，纸张、荧光标记和少量金属线条相互呼应",
    },
  },
  {
    keywords: /代码|API|接口|部署|Worker|服务|测试|开发|版本|配置/,
    style: {
      name: "创意技术控制室",
      elements: "用模块化线路、发光接口节点、构建轨道、状态灯和小型终端抽象表现系统如何前进",
      mood: "清晰、聪明、有一点未来感，但不显示真实代码、命令或技术字段",
    },
  },
  {
    keywords: /视频|剪辑|镜头|字幕|素材|分镜|音频|口播/,
    style: {
      name: "分镜时间线",
      elements: "用胶片格、分镜卡、播放头、音频波形和镜头转场表现从素材到成片的路径",
      mood: "有节奏、有动感，像一张可以沿着播放头继续前进的创作地图",
    },
  },
  {
    keywords: /研究|调研|资料|学习|论文|阅读|实验|数据分析/,
    style: {
      name: "探索手册",
      elements: "用地图折线、书页、放大镜、样本标签和证据节点表现问题、发现与结论的关系",
      mood: "像一本轻盈但可靠的探索笔记，强调证据连接而不是装饰性图表",
    },
  },
  {
    keywords: /会议|沟通|客户|销售|合同|合作|团队|反馈/,
    style: {
      name: "协作桌面",
      elements: "用对话气泡、人物关系线、共识印章、任务卡和交汇节点表现协作如何形成结果",
      mood: "亲切、清楚、有互动感，避免刻板的企业宣传海报",
    },
  },
];

function chooseContentVisualStyle(reportType: string, brief: VisualBrief): ContentVisualStyle {
  const corpus = [brief.title, brief.lead, ...brief.sections.flatMap((section) => section.items)].join(" ");
  const matched = CONTENT_VISUAL_STYLES.find(({ keywords }) => keywords.test(corpus));
  if (matched) return matched.style;
  switch (reportType) {
    case "personal":
      return {
        name: "日常观察手账",
        elements: "用生活化的小物件、时间节点、路径和一个通向明日的入口表达变化",
        mood: "有情绪但克制，像一页值得回看的个人手账",
      };
    case "weekly":
      return {
        name: "项目航线图",
        elements: "用站点、换乘关系、里程碑旗帜和风险岔路表现一周的推进",
        mood: "有方向感和节奏，不堆叠成表格",
      };
    case "monthly":
      return {
        name: "阶段全景图",
        elements: "用地形、星图或成长中的结构承载成果、转折和下一阶段",
        mood: "有章节感，能先看全局再看局部",
      };
    default:
      return {
        name: "清晰的行动叙事",
        elements: "用主线、节点、状态和下一步组成一张有方向的视觉地图",
        mood: "明快、实用、具有轻微的趣味感",
      };
  }
}

function reportTypeLabel(reportType: string): string {
  switch (reportType) {
    case "personal":
      return "我的复盘";
    case "work":
      return "工作日报";
    case "daily":
      return "日报";
    case "weekly":
      return "周报";
    case "monthly":
      return "月报";
    default:
      return "报告";
  }
}

function formatVisualRequirements(
  snapshot?: ReportGenerationRequirementsSnapshot
): string {
  if (!snapshot) return "";
  const values = [
    snapshot.longTerm.focus.trim() ? `重点关注：${cleanVisualText(snapshot.longTerm.focus)}` : "",
    snapshot.longTerm.presentation.trim() ? `呈现要求：${cleanVisualText(snapshot.longTerm.presentation)}` : "",
    snapshot.longTerm.reminders.trim() ? `注意提醒：${cleanVisualText(snapshot.longTerm.reminders)}` : "",
    snapshot.temporary.trim() ? `本次补充要求：${cleanVisualText(snapshot.temporary)}` : "",
  ].filter(Boolean);
  return values.length > 0
    ? `设计约束（只影响视觉重点，不是新增事实，也不要把这些说明原样画出来）：\n${values.map((value) => `- ${value}`).join("\n")}`
    : "";
}

function readRequirements(contentJson: string): ReportGenerationRequirementsSnapshot | undefined {
  try {
    const parsed = JSON.parse(contentJson) as { reportRequirements?: unknown };
    const requirements = parsed.reportRequirements;
    if (!requirements || typeof requirements !== "object") return undefined;
    const candidate = requirements as Partial<ReportGenerationRequirementsSnapshot>;
    if (!candidate.longTerm || typeof candidate.longTerm !== "object") return undefined;
    const longTerm = candidate.longTerm;
    return {
      reportType: candidate.reportType ?? "work",
      longTerm: {
        focus: textOf(longTerm.focus),
        presentation: textOf(longTerm.presentation),
        reminders: textOf(longTerm.reminders),
      },
      temporary: textOf(candidate.temporary),
    };
  } catch {
    return undefined;
  }
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function infographicReportType(type: string): string {
  switch (type) {
    case "personal_daily_review":
      return "personal";
    case "work_daily_report":
      return "work";
    case "daily":
      return "daily";
    case "weekly":
      return "weekly";
    case "monthly":
      return "monthly";
    default:
      return "work";
  }
}

function truncatePrompt(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const headLength = Math.floor(maxLength * 0.75);
  const tailLength = maxLength - headLength;
  return `${value.slice(0, headLength)}\n……（报告内容已截断）……\n${value.slice(-tailLength)}`;
}

function trimSentencePunctuation(value: string): string {
  return value.replace(/[。！？；;]+$/g, "");
}

function parseImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_000) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function chooseImageExtension(contentType: string | null, imageUrl: string): ImageExtension | null {
  const normalized = (contentType ?? "").split(";", 1)[0].trim().toLowerCase();
  if (normalized === "image/png") return "png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
  if (normalized === "image/webp") return "webp";
  try {
    const extension = new URL(imageUrl).pathname.split(".").pop()?.toLowerCase();
    return IMAGE_EXTENSIONS.includes(extension as ImageExtension)
      ? (extension as ImageExtension)
      : null;
  } catch {
    return null;
  }
}

function mimeTypeForExtension(extension: ImageExtension): string {
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  return "image/jpeg";
}

function isSafeReportId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

function safeClientVersion(): string {
  return process.env.npm_package_version?.trim() || "unknown";
}
