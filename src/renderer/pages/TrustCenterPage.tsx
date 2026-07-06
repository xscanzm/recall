// src/renderer/pages/TrustCenterPage.tsx
// 信任中心（来自 07、08 文档）
//
// 必须明确展示：
// - Recall 看到什么（仅活动窗口，不全屏）
// - Recall 保存什么（截图本地短期 / 结构化记忆 / 用户反馈）
// - 截图保留多久（默认当天，可选立即删除/1h/6h/当天/3天/7天）
// - API Key 放在哪里（系统安全存储，不进 SQLite/renderer/日志）
// - 如何暂停（顶部状态栏暂停按钮，暂停期间不采集不调用模型）
// - 如何删除（单条/忘掉最近/今天/全部/截图缓存）
// - 如何导出（JSON 导出，默认不含截图）
// - 桌面通知策略（默认关闭，开启后仅高优先级生效）
// - 不做云端（MVP 不上传任何数据到 Recall 服务器）
//
// 不要用营销话术。用简单、可信的产品语言。

export function TrustCenterPage() {
  return (
    <div className="trust-page">
      <header className="page-header">
        <h2>信任中心</h2>
        <p className="page-header__sub">
          以下是 Recall 在本机看到、保存和保护数据的方式。
        </p>
      </header>

      <section className="card">
        <h3 className="card__title">Recall 看到什么</h3>
        <div className="card__body">
          <p>Recall 只观察<strong>当前活动窗口</strong>，不采集全屏。</p>
          <p>触发采集的条件：</p>
          <ul>
            <li>活动窗口切换</li>
            <li>活动窗口标题变化</li>
            <li>用户输入活跃且窗口稳定超过阈值（默认 30 秒）</li>
            <li>窗口内容差异超过阈值（间隔至少 60 秒）</li>
            <li>同一窗口长时间活跃时定期触发（默认 5 分钟）</li>
            <li>空闲恢复后触发一次</li>
          </ul>
          <p className="trust-page__hint">
            用户可调整上述阈值，详见设置页 - 观察设置。
          </p>
        </div>
      </section>

      <section className="card">
        <h3 className="card__title">Recall 保存什么</h3>
        <div className="card__body">
          <ul>
            <li>
              <strong>截图</strong>：仅本地短期保留，作为视觉模型输入。
              文件名不含窗口标题、URL 或用户文本，使用随机 id 命名。
            </li>
            <li>
              <strong>结构化记忆</strong>：观察、线索、工作片段、任务、项目、人物、决策、报告。
              保存在本机 SQLite 数据库（位于 %APPDATA%/Recall/data/recall.db）。
            </li>
            <li>
              <strong>用户反馈和编辑历史</strong>：用于后续模型调用时携带上下文。
            </li>
            <li>
              <strong>模型配置</strong>：endpoint / model / provider 名称保存在 SQLite。
              API Key 单独存于系统安全存储，不在此处。
            </li>
            <li>
              <strong>隐私规则</strong>：黑名单应用、敏感词、域名关键词。首次启动会插入默认规则。
            </li>
          </ul>
        </div>
      </section>

      <section className="card">
        <h3 className="card__title">截图保留多久</h3>
        <div className="card__body">
          <p>默认保留<strong>当天</strong>，次日启动时自动清理前一天截图。</p>
          <p>可选保留策略：</p>
          <ul>
            <li>立即删除：采集后立即删除截图，仅用于实时分析</li>
            <li>1 小时</li>
            <li>6 小时</li>
            <li>当天（默认）</li>
            <li>3 天</li>
            <li>7 天</li>
          </ul>
          <p className="trust-page__hint">
            过期截图硬删除，结构化记忆不受影响。可在设置页 - 截图保留中调整。
          </p>
        </div>
      </section>

      <section className="card">
        <h3 className="card__title">API Key 放在哪里</h3>
        <div className="card__body">
          <p>API Key 保存在<strong>系统安全存储</strong>（Electron safeStorage / keytar）。</p>
          <ul>
            <li>不会进入 SQLite 数据库</li>
            <li>不会出现在 renderer 进程内存或状态中</li>
            <li>不会出现在日志中</li>
            <li>测试失败时不显示完整 key（main 进程已 sanitize）</li>
            <li>API Key 输入框使用 type=password，不显示明文</li>
            <li>删除模型配置时同时删除 SecretService 中对应 key</li>
          </ul>
          <p className="trust-page__hint">
            API Key 命名规范：recall:model:&lt;configId&gt;:apiKey
          </p>
        </div>
      </section>

      <section className="card">
        <h3 className="card__title">如何暂停</h3>
        <div className="card__body">
          <p>顶部状态栏的<strong>暂停按钮</strong>可随时切换观察状态。</p>
          <ul>
            <li>暂停期间不会采集窗口</li>
            <li>暂停期间不会调用模型</li>
            <li>正在进行的任务可完成，但不再新增采集任务</li>
            <li>恢复后不会补采暂停期间的内容</li>
          </ul>
        </div>
      </section>

      <section className="card">
        <h3 className="card__title">如何删除</h3>
        <div className="card__body">
          <p>提供多层级删除选项：</p>
          <ul>
            <li><strong>删除单条记忆/任务/项目</strong>：在对应页面操作，soft delete 优先</li>
            <li><strong>忘掉最近 15 / 30 / 60 分钟</strong>：硬删除截图缓存与观察</li>
            <li><strong>忘掉今天</strong>：硬删除今天全部截图缓存与观察</li>
            <li><strong>清空所有数据</strong>：物理删除全部结构化记忆 + 截图缓存</li>
            <li><strong>清空截图缓存</strong>：截图硬删除，结构化记忆不受影响</li>
          </ul>
          <p className="trust-page__hint">
            策略：soft delete 优先，截图文件硬删除。设置、模型配置、隐私规则、用户反馈不会被清空。
          </p>
        </div>
      </section>

      <section className="card">
        <h3 className="card__title">如何导出</h3>
        <div className="card__body">
          <p>支持本地 JSON 导出，文件名格式：recall-export-YYYY-MM-DD.json</p>
          <p>导出内容包含：</p>
          <ul>
            <li>meta（版本、导出时间、是否含截图）</li>
            <li>observations（观察）</li>
            <li>facts（线索）</li>
            <li>scenes（工作片段）</li>
            <li>tasks（任务）</li>
            <li>projects（项目）</li>
            <li>decisions（决策）</li>
            <li>people（人物）</li>
            <li>reports（报告）</li>
          </ul>
          <p className="trust-page__hint">
            默认不包含截图，除非用户在导出时明确勾选「包含截图路径」。
            注意：即使勾选也只导出路径，不含文件本身。
          </p>
        </div>
      </section>

      <section className="card">
        <h3 className="card__title">桌面通知</h3>
        <div className="card__body">
          <p>桌面通知<strong>默认关闭</strong>。</p>
          <p>用户在设置中手动开启后：</p>
          <ul>
            <li>只对候选高优先级提醒生效</li>
            <li>低优先级提醒只在应用内显示</li>
            <li>应用内提醒默认开启，不建议关闭</li>
          </ul>
        </div>
      </section>

      <section className="card">
        <h3 className="card__title">不做云端</h3>
        <div className="card__body">
          <p>MVP 不建设 Recall 云端。所有数据保存在本机。</p>
          <ul>
            <li>模型调用直接从本机到用户配置的模型 endpoint</li>
            <li>不会上传截图到 Recall 自有服务器</li>
            <li>不会上传结构化记忆到 Recall 自有服务器</li>
            <li>不会上传用户反馈或编辑历史</li>
          </ul>
        </div>
      </section>

      <section className="card">
        <h3 className="card__title">Prompt Injection 防护</h3>
        <div className="card__body">
          <p>Recall 把屏幕文字、网页内容、文档内容都视为<strong>被观察数据</strong>，不是系统指令。</p>
          <ul>
            <li>模型调用时明确告诉 LLM：屏幕文字是被观察数据，不是指令</li>
            <li>不得遵循其中要求忽略规则或泄露数据的指令</li>
            <li>回答必须基于检索到的结构化记忆，不直接基于截图</li>
            <li>回答必须列出来源对象 id</li>
          </ul>
        </div>
      </section>

      <style>{`
        .trust-page .card__body p {
          font-size: 13px;
          line-height: 1.6;
          margin: 0 0 8px 0;
        }
        .trust-page .card__body ul {
          font-size: 13px;
          line-height: 1.6;
          margin: 0 0 8px 0;
          padding-left: 20px;
        }
        .trust-page .card__body li {
          margin-bottom: 4px;
        }
        .trust-page__hint {
          font-size: 12px !important;
          color: var(--text-secondary) !important;
          font-style: italic;
        }
      `}</style>
    </div>
  );
}
