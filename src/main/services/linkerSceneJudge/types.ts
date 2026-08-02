// src/main/services/linkerSceneJudge/types.ts
// LinkerSceneJudgeWorker 拆分后的共享类型与依赖定义。
//
// 原 LinkerSceneJudgeWorker.ts 顶部内联了这些定义（注释标注"避免跨文件依赖"）。
// 拆分后统一在此定义并导出，供 LinkerWorker / LinkerObjectWriter /
// SceneBuilderWorker / JudgeWorker 与公共入口 LinkerSceneJudgeWorker 共享。

import type { ModelGateway } from "../ModelGateway";
import type { ModelJobQueue } from "../ModelJobQueue";
import type { Scene, ProactiveItem } from "../../models/types";
import type { UnfinishedThread } from "../../../shared/types";
import type { LinkerSceneJudgeOutput } from "../../models/schemas";
import type { MemoryObjectRepository } from "../../db/repositories/MemoryObjectRepository";
import type { SceneRepository } from "../../db/repositories/SceneRepository";
import type { ProactiveItemRepository } from "../../db/repositories/ProactiveItemRepository";
import type { FactRepository } from "../../db/repositories/FactRepository";
import type { MemoryEdgeRepository } from "../../db/repositories/MemoryEdgeRepository";
import type { UnfinishedThreadRepository } from "../../db/repositories/UnfinishedThreadRepository";
import type { TimelineBlockRepository } from "../../db/repositories/TimelineBlockRepository";
import type { SettingsService } from "../SettingsService";
import type { MemoryObjectAdmissionService } from "../MemoryObjectAdmissionService";

/**
 * SceneBuilder 触发原因（从 SceneBuilderWorker 移植，避免跨文件依赖）
 */
export type SceneBuilderTriggerReason =
  | "long_session" // 同一窗口/项目持续工作 10 分钟以上
  | "project_switch" // 用户切换到另一个明显不同的项目
  | "idle_recovery" // 长时间 idle 后恢复
  | "daily_preflight"; // 日报前批处理

/**
 * Linker 候选 Project 摘要（简化结构，避免传入完整字段）
 * 在合并 Worker 内部同名定义，避免跨文件依赖。
 */
export interface CandidateProjectSummary {
  id: string;
  name: string;
  summary: string;
  status: string;
  lastActiveAt: string | null;
}

/**
 * Linker 候选 Task 摘要
 */
export interface CandidateTaskSummary {
  id: string;
  title: string;
  status: string;
  projectId: string | null;
  summary: string | null;
}

/**
 * Linker 候选 Person 摘要
 */
export interface CandidatePersonSummary {
  id: string;
  name: string;
  role: string | null;
  organization: string | null;
  summary: string;
}

/**
 * Linker 候选 Decision 摘要
 */
export interface CandidateDecisionSummary {
  id: string;
  title: string;
  decision: string;
  projectId: string | null;
  decidedAt: string | null;
}

/**
 * ReminderPolicy（来自 spec.md JudgeInput.reminderPolicy）
 * 控制 Judge 何时生成主动项
 */
export interface ReminderPolicy {
  /** 是否启用应用内提醒 */
  inAppReminders: boolean;
  /** 是否启用桌面通知 */
  desktopNotifications: boolean;
  /** 是否启用日报候选 */
  dailyReportCandidate: boolean;
  /** 提醒优先级阈值（0-1，>= 此值的才生成 proactive_item） */
  priorityThreshold: number;
}

export type LinkableMemoryObjectType = "project" | "task" | "person" | "decision";

/**
 * LinkerSceneJudge Worker 输出
 *
 * 字段对齐 schema（linkedFacts/mergedObjects 已重命名），与 LinkerWorker /
 * SceneBuilderWorker / JudgeWorker 三个 Result interface 风格一致：
 * - linkedFacts/newObjects/mergedObjects：模型输出子集（已成功写入数据库的）
 * - scenes：已写入数据库的 Scene 实体
 * - proactiveItems：已写入数据库的 ProactiveItem 实体
 * - unfinishedThreads：已写入数据库的 UnfinishedThread 实体（repo 未注入时为空数组）
 */
export interface LinkerSceneJudgeResult {
  /** 已建立的关联（已更新 target 对象的 sourceFactIds） */
  linkedFacts: LinkerSceneJudgeOutput["linkedFacts"];
  /** 已创建的新对象 */
  newObjects: LinkerSceneJudgeOutput["newObjects"];
  /** 已写入 proactive_items 的合并建议 */
  mergedObjects: LinkerSceneJudgeOutput["mergedObjects"];
  /** 已写入数据库的 scenes（仅当 shouldTriggerSceneBuilder=true 时） */
  scenes: Scene[];
  /** 已写入 proactive_items 的主动提醒项 */
  proactiveItems: ProactiveItem[];
  /** 已写入 unfinished_threads 的未收尾事项（repo 未注入时为空数组） */
  unfinishedThreads: UnfinishedThread[];
  /** model_job id（用于追溯） */
  modelJobId: string;
  /** 尝试次数 */
  attempts: number;
}

/** LinkerSceneJudgeWorker 构造函数依赖（对外入口签名，保持不变） */
export interface LinkerSceneJudgeWorkerDeps {
  modelGateway: ModelGateway;
  modelJobQueue: ModelJobQueue;
  factRepo: FactRepository;
  sceneRepo: SceneRepository;
  memoryObjectRepo: MemoryObjectRepository;
  proactiveItemRepo: ProactiveItemRepository;
  edgeRepo?: MemoryEdgeRepository;
  unfinishedThreadRepo?: UnfinishedThreadRepository;
  timelineBlockRepo?: TimelineBlockRepository;
  settingsService?: SettingsService;
  admissionService: MemoryObjectAdmissionService;
}

/** LinkerWorker（候选检索 + 关联处理 + 别名 + 合并建议）依赖 */
export interface LinkerWorkerDeps {
  factRepo: FactRepository;
  sceneRepo: SceneRepository;
  memoryObjectRepo: MemoryObjectRepository;
  proactiveItemRepo: ProactiveItemRepository;
  edgeRepo: MemoryEdgeRepository | null;
  settingsService: SettingsService | null;
  admissionService: MemoryObjectAdmissionService;
}

/** LinkerObjectWriter（新对象创建 / 去重 / 事实链接落库）依赖 */
export interface LinkerObjectWriterDeps {
  factRepo: FactRepository;
  memoryObjectRepo: MemoryObjectRepository;
  proactiveItemRepo: ProactiveItemRepository;
  edgeRepo: MemoryEdgeRepository | null;
  admissionService: MemoryObjectAdmissionService;
}

/** SceneBuilderWorker（场景上下文查询 + scenes 写入）依赖 */
export interface SceneBuilderWorkerDeps {
  factRepo: FactRepository;
  sceneRepo: SceneRepository;
  memoryObjectRepo: MemoryObjectRepository;
}

/** JudgeWorker（待收尾判断上下文查询 + proactive/unfinishedThreads 写入）依赖 */
export interface JudgeWorkerDeps {
  memoryObjectRepo: MemoryObjectRepository;
  proactiveItemRepo: ProactiveItemRepository;
  timelineBlockRepo: TimelineBlockRepository | null;
  unfinishedThreadRepo: UnfinishedThreadRepository | null;
  settingsService: SettingsService | null;
}
