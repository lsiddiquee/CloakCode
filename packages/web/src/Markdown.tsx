import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders a markdown session part. Raw HTML is NOT enabled (react-markdown's
 * default), so untrusted transcript text cannot inject markup — GFM covers
 * headings, lists, tables, code, and emphasis, which is what Copilot emits.
 */
export function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}): JSX.Element {
  return (
    <div className={className ?? "assistant markdown-body"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a(props) {
            const { node: _node, ...rest } = props;
            return (
              <a {...rest} target="_blank" rel="noopener noreferrer nofollow" />
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
