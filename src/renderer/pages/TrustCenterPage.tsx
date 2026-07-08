// src/renderer/pages/TrustCenterPage.tsx
// 信任中心（Phase 7 重构，spec 行 2402-2449）
//
// 5 卡片布局（用清楚的人话，不是法律条款）：
// 1. Recall 会看什么
// 2. Recall 会保存什么
// 3. 模型 API 如何调用（不出现"绝不经过云端 AI"）
// 4. 工作日报如何保护隐私
// 5. 你如何控制和删除
//
// 重要约束：
// - 卡片 3 不出现"绝不经过云端 AI"
// - 卡片 4 说明工作日报只用选中内容
// - 卡片 5 列出全部 6 个控制项

import { useAppStore } from "../state/store";

export function TrustCenterPage() {
  const setPage = useAppStore((s) => s.setPage);

  return (
    <div className="trust-page">
      <header className="page-header">
        <h2>信任中心</h2>
        <p className="page-header__sub">
          以下是 Recall 在本机看到、保存和保护数据的方式。用清楚的人话告诉你，不做营销承诺。
        </p>
      </header>

      {/* ============ 卡片 1：Recall 会看什么 ============ */}
      <section className="trust-card">
        <header className="trust-card__header">
          <span className="trust-card__index" aria-hidden>1</span>
          <h3 className="trust-card__title">Recall 会看什么</h3>
        </header>
        <div className="trust-card__body">
          <p>
            开启观察后，Recall 会理解你当前活动窗口的内容，用来整理时间轴、待收尾和报告。
          </p>
          <p className="trust-card__hint">
            Recall 只观察当前活动窗口，不采集全屏，也不会在你离开电脑时持续录制。
          </p>
        </div>
      </section>

      {/* ============ 卡片 2：Recall 会保存什么 ============ */}
      <section className="trust-card">
        <header className="trust-card__header">
          <span className="trust-card__index" aria-hidden>2</span>
          <h3 className="trust-card__title">Recall 会保存什么</h3>
        </header>
        <div className="trust-card__body">
          <p>
            Recall 会在本机保存结构化记忆，例如工作片段、任务、决策、项目和报告。截图只按你的设置短期保留。
          </p>
          <ul className="trust-card__list">
            <li>
              <strong>结构化记忆</strong>：观察、线索、工作片段、任务、项目、决策、人物、报告，存放在本机 SQLite 数据库。
            </li>
            <li>
              <strong>截图</strong>：仅本机短期保留，作为视觉模型输入。文件名使用随机 id，不含窗口标题、URL 或用户文本。过期硬删除。
            </li>
            <li>
              <strong>用户反馈和编辑历史</strong>：用于后续模型调用时携带上下文。
            </li>
            <li>
              <strong>模型配置</strong>：endpoint / model / provider 名称保存在 SQLite。
            </li>
            <li>
              <strong>隐私规则</strong>：黑名单应用、敏感词、域名关键词。
            </li>
          </ul>
        </div>
      </section>

      {/* ============ 卡片 3：模型 API 如何调用 ============ */}
      <section className="trust-card">
        <header className="trust-card__header">
          <span className="trust-card__index" aria-hidden>3</span>
          <h3 className="trust-card__title">模型 API 如何调用</h3>
        </header>
        <div className="trust-card__body">
          <p>
            Recall 使用你配置的视觉模型和语言模型 API。API Key 保存在系统安全存储中，不写入数据库。
          </p>
          <ul className="trust-card__list">
            <li>API Key 通过系统安全存储（Electron safeStorage / keytar）保存</li>
            <li>不会进入 SQLite 数据库</li>
            <li>不会出现在 renderer 进程内存或日志中</li>
            <li>测试失败时不显示完整 key（main 进程已 sanitize）</li>
            <li>输入框使用 type=password，不显示明文</li>
            <li>删除模型配置时同时删除 SecretService 中的 key</li>
          </ul>
          <p className="trust-card__hint">
            模型调用直接从本机发往你配置的模型 endpoint。Recall 不会替你托管或转发 API Key。
          </p>
        </div>
      </section>

      {/* ============ 卡片 4：工作日报如何保护隐私 ============ */}
      <section className="trust-card">
        <header className="trust-card__header">
          <span className="trust-card__index" aria-hidden>4</span>
          <h3 className="trust-card__title">工作日报如何保护隐私</h3>
        </header>
        <div className="trust-card__body">
          <p>
            生成工作日报前，你可以选择哪些时间片段参与生成。未选择的内容不会进入本次日报 prompt。
          </p>
          <ul className="trust-card__list">
            <li>高风险隐私片段（如私人聊天、银行页面）默认不参与日报生成</li>
            <li>你可以手动取消选中任何片段，被取消的片段不会发送给语言模型</li>
            <li>日报生成前会显示预览，让你确认参与生成的片段清单</li>
            <li>未选中的内容仍然保留在本机记忆中，只是不进入这一次的日报</li>
          </ul>
          <p className="trust-card__hint">
            个人复盘只给你自己看，不会自动分享。工作日报由你决定是否复制或导出。
          </p>
        </div>
      </section>

      {/* ============ 卡片 5：你如何控制和删除 ============ */}
      <section className="trust-card">
        <header className="trust-card__header">
          <span className="trust-card__index" aria-hidden>5</span>
          <h3 className="trust-card__title">你如何控制和删除</h3>
        </header>
        <div className="trust-card__body">
          <p>Recall 提供以下控制项，全部在设置页 - 数据管理中可操作：</p>
          <ul className="trust-card__list trust-card__list--controls">
            <li>
              <strong>暂停观察</strong>：暂停期间不采集窗口、不调用模型，正在进行的任务可完成但不再新增。
            </li>
            <li>
              <strong>忘掉最近</strong>：硬删除最近 15 / 30 分钟内的截图缓存和观察记录，关联线索软删除。
            </li>
            <li>
              <strong>删除今天</strong>：硬删除今天全部截图缓存和观察记录。
            </li>
            <li>
              <strong>清空截图</strong>：截图硬删除，结构化记忆不受影响。
            </li>
            <li>
              <strong>导出数据</strong>：JSON 格式导出全部结构化记忆，默认不含截图路径。
            </li>
            <li>
              <strong>清空所有数据</strong>：物理删除全部结构化记忆 + 截图缓存。保留设置、模型配置、隐私规则。
            </li>
          </ul>
          <p className="trust-card__hint">
            危险操作（忘掉最近、删除今天、清空所有）需要二次确认。设置、模型配置、隐私规则不会被清空。
          </p>
          <div className="trust-card__actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setPage("settings")}
            >
              前往设置页管理数据
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
