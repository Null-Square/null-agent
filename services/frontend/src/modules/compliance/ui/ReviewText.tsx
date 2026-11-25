import ReactMarkdown from "react-markdown";

export default function ReviewText({ text }: { text: string }) {
  return (
    <div className="review-text my-3 min-w-0 break-words">
      <ReactMarkdown
        allowedElements={[
          "p",
          "strong",
          "em",
          "code",
          "pre",
          "ol",
          "ul",
          "li",
          "br",
          "blockquote",
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
        ]}
        skipHtml
        unwrapDisallowed
        components={{
          p: ({ children }) => (
            <p className="mb-3 whitespace-pre-line last:mb-0">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">
              {children}
            </ol>
          ),
          code: ({ children }) => (
            <code className="rounded bg-surface-1 px-1 font-mono text-[0.92em]">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="mb-3 max-w-full overflow-x-auto bg-surface-1 p-3">
              {children}
            </pre>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
