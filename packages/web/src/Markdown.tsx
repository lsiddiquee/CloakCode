import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Hoisted so their identities are stable across renders. react-markdown re-parses
// on every render, so a fresh plugins array / components object each time would
// defeat memoization; combined with `memo`, an unchanged part never re-parses.
const remarkPlugins = [remarkGfm];
const components: Components = {
  a(props) {
    const { node: _node, ...rest } = props;
    return <a {...rest} target="_blank" rel="noopener noreferrer nofollow" />;
  },
};

/**
 * Renders a markdown session part. Raw HTML is NOT enabled (react-markdown's
 * default), so untrusted transcript text cannot inject markup — GFM covers
 * headings, lists, tables, code, and emphasis, which is what Copilot emits.
 * Memoized: parsing markdown is the transcript's hot path, so an unchanged part
 * must not re-parse when a sibling updates.
 */
export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}): JSX.Element {
  return (
    <div className={className ?? "assistant markdown-body"}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
