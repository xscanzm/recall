import React from "react";
import ReactDOM from "react-dom/client";
import {
  ArrowDown,
  ArrowRight,
  BookOpenText,
  CirclePause,
  Clock3,
  Code2,
  Download,
  FileText,
  KeyRound,
  Laptop,
  LockKeyhole,
  Search,
  ShieldCheck,
} from "lucide-react";
import logoUrl from "../../src/renderer/public/logo.png";
import "./styles.css";

const DOWNLOAD_URL = "https://recall-update.ppclaw.online/download/latest";
const MAC_ARM64_DOWNLOAD_URL = "https://recall-update.ppclaw.online/download/Recall-0.5.11-mac-arm64.dmg";
const MAC_X64_DOWNLOAD_URL = "https://recall-update.ppclaw.online/download/Recall-0.5.11-mac-x64.dmg";
const MAC_ARM64_ZIP_DOWNLOAD_URL = "https://recall-update.ppclaw.online/download/Recall-0.5.11-mac-arm64.zip";
const MAC_X64_ZIP_DOWNLOAD_URL = "https://recall-update.ppclaw.online/download/Recall-0.5.11-mac-x64.zip";
const SOURCE_URL = "https://github.com/xscanzm/recall";
const METRICS_URL = "https://recall-update.ppclaw.online/api/metrics/website-visit";

function useWebsiteVisitMetric() {
  React.useEffect(() => {
    const sessionKey = "recall-website-visit-recorded";
    try {
      if (window.sessionStorage.getItem(sessionKey)) return;
      window.sessionStorage.setItem(sessionKey, "true");
    } catch {
      // 存储不可用时仍尝试发送一次聚合访问计数。
    }

    void fetch(METRICS_URL, { method: "POST", mode: "cors", keepalive: true }).catch(() => {
      // 统计失败不能影响官网访问或下载。
    });
  }, []);
}

function Mark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`mark ${compact ? "mark--compact" : ""}`} aria-hidden="true">
      <img src={logoUrl} alt="" />
    </span>
  );
}

function DownloadLink({ secondary = false, children = "下载 Windows 公开测试版" }: { secondary?: boolean; children?: React.ReactNode }) {
  return (
    <a className={`button ${secondary ? "button--secondary" : "button--primary"}`} href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
      <Download size={18} strokeWidth={1.8} />
      <span>{children}</span>
      <ArrowRight size={17} strokeWidth={1.8} className="button__arrow" />
    </a>
  );
}

function MacDownloadLinks() {
  return (
    <div className="mac-download-links" aria-label="macOS R2 架构下载">
      <a href={MAC_ARM64_DOWNLOAD_URL} target="_blank" rel="noreferrer">Apple Silicon DMG</a>
      <a href={MAC_X64_DOWNLOAD_URL} target="_blank" rel="noreferrer">Intel DMG</a>
      <a href={MAC_ARM64_ZIP_DOWNLOAD_URL} target="_blank" rel="noreferrer">Apple Silicon ZIP</a>
      <a href={MAC_X64_ZIP_DOWNLOAD_URL} target="_blank" rel="noreferrer">Intel ZIP</a>
    </div>
  );
}

function ProductFrame({ page, title }: { page: "today" | "tasks" | "memory" | "reports" | "projects" | "people"; title: string }) {
  return (
    <div className={`real-product real-product--${page}`}>
      <div className="real-product__bar">
        <Mark compact />
        <span>回声 <b>Recall</b></span>
      </div>
      <iframe src={`/product-demo.html?page=${page}`} title={title} loading="lazy" />
    </div>
  );
}

function AppPreview() {
  return (
    <div className="app-stage" aria-label="回声 Recall 产品界面">
      <div className="app-window">
        <div className="preview-label">
          <Mark compact />
          <span>回声 <b>Recall</b></span>
        </div>
        <iframe
          className="product-demo-frame"
          src="/product-demo.html"
          title="Recall 产品界面交互演示"
          loading="eager"
        />
      </div>
    </div>
  );
}

function CommunityQr({ hero = false }: { hero?: boolean }) {
  return (
    <aside className={`community-qr ${hero ? "community-qr--hero" : ""}`} aria-label="Recall 用户群交流">
      <img src="/qun.png" alt="回声 Recall 用户群微信二维码" />
      <div className="community-qr__copy">
        <p className="community-qr__eyebrow">用户群交流</p>
        <p className="community-qr__hint">微信扫码加入用户群<br />问题、想法和需求，欢迎在 GitHub 或用户群反馈</p>
      </div>
    </aside>
  );
}

function App() {
  useWebsiteVisitMetric();

  return (
    <>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="回声 Recall 首页"><Mark compact /><span>回声 <b>Recall</b></span></a>
        <nav aria-label="主导航">
          <a href="#how">它如何陪你</a><a href="#privacy">隐私与控制</a><a href="#before">使用前须知</a>
        </nav>
        <a className="header-download" href={DOWNLOAD_URL} target="_blank" rel="noreferrer"><Download size={16} />下载</a>
      </header>

      <main id="top">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow"><span /> Windows & macOS 支持 · v0.5.11</p>
            <h1>让认真度过的一天，<br /><em>被好好记住。</em></h1>
            <p className="hero-lede">你翻过的资料、写下又删掉的句子、做到一半的事，<br className="desktop-only" />不必在关掉电脑后，一起消失。</p>
            <p className="hero-description">回声 Recall 安静地理解你在电脑前做过什么，替你接住散落的思路、进展和未完成。等你回头时，一天已经有了清晰的来路。</p>
            <div className="hero-actions">
              <DownloadLink />
              <div className="mac-download-group">
                <span className="mac-download-title">macOS 版 · R2 直连下载</span>
                <MacDownloadLinks />
              </div>
              <a className="text-link" href="#how">先看看它如何工作 <ArrowDown size={16} /></a>
            </div>
            <CommunityQr hero />
            <p className="hero-meta">
              <Laptop size={15} /> Windows x64 & macOS (Apple Silicon / Intel) <span /> 默认模型服务已配置
              <br />
              <small style={{ opacity: 0.8, marginTop: "4px", display: "inline-block" }}>
                当前版本没有 Windows 代码签名或 Apple 公证。macOS 首次请右键点击 DMG 内的【双击修复安装.command】→ 打开，授予一次权限（或按 README 使用终端命令）。
              </small>
            </p>
          </div>
          <AppPreview />
        </section>

        <section className="quiet-line" aria-label="产品理念">
          <p>我们每天都做了很多事。</p><p>只是很少有一天，真的被完整地留下。</p>
        </section>

        <section className="story-section" id="how">
          <div className="section-number">01 / 一天的来路</div>
          <div className="section-intro"><p className="kicker">不需要一边工作，一边记录工作</p><h2>你只管往前走。<br />它替你把沿途的线索，轻轻收好。</h2></div>
          <div className="story-grid">
            <article><Clock3 /><span>上午 09:30</span><h3>从昨天停下的地方继续</h3><p>重新打开项目时，不必在几十个标签页里寻找自己。Recall 会告诉你上次做到哪里，还有什么没有完成。</p></article>
            <article><BookOpenText /><span>下午 14:10</span><h3>散落的工作，渐渐有了脉络</h3><p>文档、网页、聊天和创作之间的切换，会被整理成一段段自然的工作记忆，而不是一面让人不安的截图墙。</p></article>
            <article><FileText /><span>晚上 18:20</span><h3>一天结束，不再只剩下疲惫</h3><p>做成了什么、改过哪些决定、明天从哪里继续，已经成为一份可以阅读、编辑和带走的回顾。</p></article>
          </div>
        </section>

        <section className="unfinished-section">
          <div className="unfinished-copy"><p className="kicker">那些做到一半的事</p><h2>不是忘了。<br />只是被新的事情推远了。</h2><p>Recall 从一天的工作脉络里找到还没有收尾的线索。在合适的时候放回你眼前，不催促，也不打断。</p></div>
          <ProductFrame page="tasks" title="Recall 待收尾页面演示" />
        </section>

        <section className="memory-section">
          <div className="memory-heading"><div><p className="kicker">记忆不是归档，是重新找到</p><h2>有些答案，<br />你其实早就想明白过。</h2></div><p>用一句自然的话，找回某个决定、某段资料或一条突然想不起的思路。不是搜索文件名，而是回到当时的上下文。</p></div>
          <ProductFrame page="memory" title="Recall 记忆库页面演示" />
        </section>

        <section className="review-section">
          <ProductFrame page="reports" title="Recall 报告页面演示" />
          <div className="review-copy"><p className="kicker">留给今天，也留给以后的你</p><h2>原来这一天，<br />我真的做了很多。</h2><p>Recall 会把一天整理成个人回顾，也能生成可编辑的工作报告。那些微小却真实的推进，不再被疲惫轻易抹去。</p></div>
        </section>

        <section className="relations-section">
          <div className="relations-heading">
            <div>
              <p className="kicker">一天之外，还有持续推进的事和一起做事的人</p>
              <h2>工作会散在很多天里。<br />Recall 帮你重新看见完整的关系。</h2>
            </div>
            <p>它会把同一主题的进展归到项目，也把协作中提到的决定、承诺和上下文连接到相关人物。你看到的不是孤立记录，而是事情为什么走到今天。</p>
          </div>
          <div className="relations-showcases">
            <article className="relations-showcase">
              <div className="relations-copy">
                <span>项目</span>
                <h3>知道每件事推进到了哪里</h3>
                <p>项目页汇集最近进展、待收尾、关键决策、相关资料、人物和报告。跨过几天再回来，也能迅速找到主线和下一步。</p>
              </div>
              <ProductFrame page="projects" title="Recall 项目页面演示" />
            </article>
            <article className="relations-showcase relations-showcase--reverse">
              <div className="relations-copy">
                <span>人物</span>
                <h3>记住协作里真正重要的事</h3>
                <p>人物页整理相关项目、最近协作、答应过的事和对方提到的需求。它是你的关系记忆，不是对他人的追踪。</p>
              </div>
              <ProductFrame page="people" title="Recall 人物页面演示" />
            </article>
          </div>
        </section>

        <section className="privacy-section" id="privacy">
          <div className="privacy-title"><p className="kicker">安静地工作，也清楚地交代边界</p><h2>记住你，<br />不等于占有你的记忆。</h2></div>
          <div className="privacy-grid">
            <article><LockKeyhole /><h3>长期记忆留在本地</h3><p>截图和结构化记忆保存在你的电脑中。Recall 不运营屏幕历史云端，也不收集遥测数据。</p></article>
            <article><KeyRound /><h3>模型由你选择</h3><p>开箱即可使用 Recall 提供的默认模型服务，也可以配置自己的兼容模型 Endpoint 与 API Key。使用自配模型时，请求会直接发送给你选择的服务商。</p></article>
            <article><CirclePause /><h3>随时暂停，随时忘记</h3><p>你可以暂停观察、跳过敏感应用，调整截图保留时间，也可以删除、纠正或导出自己的数据。</p></article>
          </div>
          <a className="source-link" href={SOURCE_URL} target="_blank" rel="noreferrer"><Code2 size={18} /> 源码公开，可自行审阅 <ArrowRight size={16} /></a>
        </section>

        <section className="before-section" id="before">
          <div><p className="kicker">下载以前，先把这些告诉你</p><h2>这是一个正在长大的<br />Windows 与 macOS 内测版。</h2></div>
          <div className="before-list">
            <p><span>01</span><b>Windows x64 与 macOS 双架构</b><small>Windows 安装包约 184 MB；macOS 提供 Apple Silicon arm64 与 Intel x64 的 DMG / ZIP。</small></p>
            <p><span>02</span><b>v0.5.11 已发布</b><small>本版修复记忆批量任务失败（模型输出缺字段不再校验失败、repair 修复机制增强）；默认模型服务上游超时可控（60s 显式超时、明确报错）；本地轮询超时可安全重试，任务结果不再丢失。</small></p>
            <p><span>03</span><b>这是无证书签名的内测构建</b><small>Windows 可能显示“未知发布者”；macOS 首次打开可能被拦截，请按 DMG 内说明解除隔离。</small></p>
          </div>
        </section>

        <section className="final-cta">
          <div className="final-cta__content">
            <div className="final-cta__copy">
              <Mark />
              <p>一天会过去。</p>
              <h2>但你走过的路，<br />可以留下回声。</h2>
              <DownloadLink>下载 Windows 公开测试版</DownloadLink>
              <small>Windows x64 & macOS · v0.5.11 · 默认模型服务已配置</small>
            </div>
            <CommunityQr />
          </div>
        </section>
      </main>

      <footer>
        <a className="brand" href="#top"><Mark compact /><span>回声 <b>Recall</b></span></a>
        <p>把电脑前流逝的工作上下文，变成可行动的记忆和提醒。</p>
        <div><a href={SOURCE_URL} target="_blank" rel="noreferrer">GitHub</a><a href={`${SOURCE_URL}/issues`} target="_blank" rel="noreferrer">问题反馈</a><a href="#privacy">隐私说明</a></div>
        <small>© 2026 Recall Contributors · BUSL 1.1</small>
      </footer>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
