// src/renderer/utils/simpleMarkdown.tsx
// 极简 Markdown 渲染
// 仅处理 release-notes.md 用到的语法：## / ### / - / **bold** / `code` / 普通段落
// 不引入外部库，与报告页结构化渲染风格一致
//
// 用于：
// - SettingsPage「关于」分区（打包嵌入的 release-notes.md）
// - UpdatePanel 弹窗（从 CF Worker API 返回的 releaseNotes）

import type { ReactNode } from "react";

export function renderSimpleMarkdown(md: string): ReactNode {
  const lines = md.split("\n");
  const blocks: ReactNode[] = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="release-notes__list">
        {listItems.map((item, i) => (
          <li key={i}>{renderInline(item)}</li>
        ))}
      </ul>
    );
    listItems = [];
  };

  /** 渲染行内 **bold** 和 `code` */
  const renderInline = (text: string): ReactNode => {
    const parts: ReactNode[] = [];
    let remaining = text;
    let key = 0;
    while (remaining.length > 0) {
      const bold = remaining.match(/\*\*(.+?)\*\*/);
      const code = remaining.match(/`(.+?)`/);
      const next = [bold, code].filter(Boolean).sort((a, b) => (a!.index! - b!.index!))[0];
      if (!next) {
        parts.push(remaining);
        break;
      }
      if (next.index! > 0) parts.push(remaining.slice(0, next.index!));
      if (next === bold) {
        parts.push(<strong key={key++}>{next[1]}</strong>);
      } else {
        parts.push(<code key={key++} className="release-notes__code">{next[1]}</code>);
      }
      remaining = remaining.slice(next.index! + next[0].length);
    }
    return parts;
  };

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith("## ")) {
      flushList();
      blocks.push(<h4 key={blocks.length} className="release-notes__h">{trimmed.slice(3)}</h4>);
    } else if (trimmed.startsWith("### ")) {
      flushList();
      blocks.push(<h5 key={blocks.length} className="release-notes__h">{trimmed.slice(4)}</h5>);
    } else if (trimmed.startsWith("- ")) {
      listItems.push(trimmed.slice(2));
    } else if (trimmed === "") {
      flushList();
    } else {
      flushList();
      blocks.push(<p key={blocks.length} className="release-notes__p">{renderInline(trimmed)}</p>);
    }
  }
  flushList();
  return blocks;
}
