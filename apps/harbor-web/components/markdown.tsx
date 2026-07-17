"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

/**
 * Assistant 正文的 Markdown 渲染（GFM + highlight.js 代码高亮，排版见 globals.css `.md`）。
 * 不挂 rehype-raw——agent 输出里的原始 HTML 一律按文本转义，无 XSS 面。
 * memo 化：SSE 流式刷新时正文块逐个 memo，未变化的块跳过重解析。
 */
export const Markdown = memo(function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
          table: ({ node: _node, ...props }) => (
            <div className="md-table">
              <table {...props} />
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
