import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

interface AssistantAnswerBodyProps {
  content: string;
  isStreaming?: boolean;
  startedAt?: number;
}

const ANSWER_WARMUP_MS = 500;

/** GFM + safe HTML; tables wrapped for horizontal scroll. Future: optional JSON tool payloads → dedicated card UI. */
const assistantMarkdownComponents: Components = {
  table({ children, ...rest }) {
    return (
      <div className="assistant-md-table-wrap">
        <table {...rest}>{children}</table>
      </div>
    );
  },
  a({ href, children, ...rest }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    );
  },
};

export function AssistantAnswerBody({ content, isStreaming, startedAt }: AssistantAnswerBodyProps) {
  const [now, setNow] = useState(() => Date.now());

  const rehypePlugins = useMemo(() => [rehypeSanitize], []);

  useEffect(() => {
    if (!isStreaming || content || !startedAt) return;
    const timer = setTimeout(() => setNow(Date.now()), ANSWER_WARMUP_MS);
    return () => clearTimeout(timer);
  }, [isStreaming, content, startedAt]);

  const showWarmup = Boolean(
    isStreaming && !content && startedAt && now - startedAt < ANSWER_WARMUP_MS
  );

  return (
    <section className="assistant-answer-body" aria-live={isStreaming ? "polite" : "off"} role="region" aria-label="Assistant response">
      {showWarmup ? (
        <div className="assistant-answer-warmup">
          <div className="turn-loading-line" />
          <div className="turn-loading-line short" />
          <p>Composing response...</p>
        </div>
      ) : (
        <div className="message-content assistant-markdown">
          <Markdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={rehypePlugins}
            components={assistantMarkdownComponents}
          >
            {content || " "}
          </Markdown>
        </div>
      )}
      {isStreaming && <div className="assistant-answer-cursor" aria-hidden="true" />}
    </section>
  );
}
