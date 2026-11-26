import { Children, isValidElement, useEffect, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { MermaidDiagram } from '@shared/ui/MermaidDiagram';
import { downloadArtifactBlob } from '@modules/sessions';
import { resolveReportImageArtifact } from '@shared/lib/reportImages';
import type { SessionArtifact } from '@/types/chat';

type RunReportPdfDocumentProps = {
  title?: string | null;
  markdown: string;
  sessionId: string;
  scopeName?: string | null;
  runnerName?: string | null;
  status?: string | null;
  generatedAtLabel?: string | null;
  classification?: 'CONFIDENTIAL' | 'INTERNAL' | 'PUBLIC';
  artifacts?: SessionArtifact[];
};

const MONO_FONT = "'JetBrains Mono', 'SF Mono', Consolas, monospace";
const BODY_FONT = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

const artifactDisplayName = (artifact: SessionArtifact): string =>
  artifact.originalName || artifact.filePath || artifact.id;

function ReportEvidenceImage({
  src,
  alt,
  title,
  sessionId,
  artifacts,
}: {
  src?: string;
  alt?: string;
  title?: string;
  sessionId: string;
  artifacts: SessionArtifact[];
}) {
  const artifact = useMemo(
    () => resolveReportImageArtifact(src, artifacts),
    [artifacts, src],
  );
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const caption = alt?.trim();
  const wrapWithCaption = (content: ReactNode) =>
    caption ? (
      <figure
        className="my-4 break-inside-avoid text-center"
        style={{ breakInside: 'avoid', pageBreakInside: 'avoid' }}
      >
        {content}
        <figcaption
          style={{ fontFamily: MONO_FONT }}
          className="mt-2 text-[11px] leading-[1.5] text-[#555555]"
        >
          {caption}
        </figcaption>
      </figure>
    ) : (
      <>{content}</>
    );

  useEffect(() => {
    let isMounted = true;
    let generatedUrl: string | null = null;

    setObjectUrl(null);
    setFailed(false);

    if (!artifact) {
      return () => {
        isMounted = false;
      };
    }

    void downloadArtifactBlob(sessionId, artifact.id)
      .then((blob) => {
        generatedUrl = URL.createObjectURL(blob);
        if (isMounted) {
          setObjectUrl(generatedUrl);
        } else {
          URL.revokeObjectURL(generatedUrl);
        }
      })
      .catch(() => {
        if (isMounted) {
          setFailed(true);
        }
      });

    return () => {
      isMounted = false;
      if (generatedUrl) {
        URL.revokeObjectURL(generatedUrl);
      }
    };
  }, [artifact, sessionId]);

  if (artifact && !objectUrl && !failed) {
    return wrapWithCaption(
      <span
        data-report-image-status="loading"
        className={`${caption ? 'mb-2' : 'my-4'} block border border-[#dddddd] bg-[#f7f7f7] px-3 py-4 text-center text-[11px] text-[#666666]`}
      >
        Loading image evidence
      </span>,
    );
  }

  if (artifact && failed) {
    return wrapWithCaption(
      <span
        data-report-image-status="error"
        className={`${caption ? 'mb-2' : 'my-4'} block border border-[#dddddd] bg-[#f7f7f7] px-3 py-4 text-center text-[11px] text-[#666666]`}
      >
        Image evidence unavailable: {artifactDisplayName(artifact)}
      </span>,
    );
  }

  return wrapWithCaption(
    <img
      src={objectUrl ?? src}
      alt={alt ?? ''}
      title={title}
      data-report-image-status={artifact ? 'ready' : undefined}
      className={`${caption ? 'mx-auto mb-2' : 'my-4'} block max-h-[520px] max-w-full border border-[#d6d6d6] bg-[#fafafa] object-contain`}
    />,
  );
}

type MarkdownNode = {
  children?: Array<{
    type?: string;
    tagName?: string;
    value?: string;
  }>;
};

function MarkdownParagraph({ children, node }: { children?: ReactNode; node?: MarkdownNode }) {
  const nodes = Children.toArray(children).filter((child) => !(typeof child === 'string' && child.trim() === ''));
  const markdownNodes = node?.children?.filter((child) => !(child.type === 'text' && child.value?.trim() === '')) ?? [];
  const hasImageMarkdownNode = markdownNodes.some((child) => child.type === 'element' && child.tagName === 'img');
  const containsRenderedImage = nodes.some(
    (node) => isValidElement(node) && (node.type === 'img' || node.type === ReportEvidenceImage),
  );
  const containsMarkdownImage = hasImageMarkdownNode || containsRenderedImage;
  const isStandaloneReportImage = nodes.length === 1 && containsMarkdownImage;

  if (isStandaloneReportImage) {
    return <>{children}</>;
  }

  if (containsMarkdownImage) {
    return <div className="mb-3 text-sm leading-[1.7] text-[#333333]">{children}</div>;
  }

  return <p className="mb-3 text-sm leading-[1.7] text-[#333333]">{children}</p>;
}

const baseMarkdownComponents = {
  h1: ({ children }: { children?: ReactNode }) => (
    <h1
      style={{ fontFamily: MONO_FONT }}
      className="mb-5 border-b-[3px] border-black pb-3 text-[24px] font-black   text-black first:mt-0"
    >
      {children}
    </h1>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2
      style={{ fontFamily: MONO_FONT }}
      className="mb-4 mt-8 border-l-4 border-[#F5D13A] pl-3 text-[18px] font-bold text-black"
    >
      {children}
    </h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3
      style={{ fontFamily: MONO_FONT }}
      className="mb-3 mt-6 text-[14px] font-semibold   text-muted-foreground"
    >
      {children}
    </h3>
  ),
  h4: ({ children }: { children?: ReactNode }) => (
    <h4
      style={{ fontFamily: MONO_FONT }}
      className="mb-2 mt-5 text-[12px] font-semibold   text-muted-foreground"
    >
      {children}
    </h4>
  ),
  p: MarkdownParagraph,
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="mb-3 ml-6 list-disc text-sm leading-[1.7] text-[#333333]">{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="mb-3 ml-6 list-decimal text-sm leading-[1.7] text-[#333333]">{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => (
    <li className="mb-1">{children}</li>
  ),
  strong: ({ children }: { children?: ReactNode }) => (
    <strong className="font-bold text-black">{children}</strong>
  ),
  em: ({ children }: { children?: ReactNode }) => (
    <em className="italic text-[#333333]">{children}</em>
  ),
  code: ({ className, children }: { className?: string; children?: ReactNode }) => {
    const match = /language-(\w+)/.exec(className || '');
    const language = match?.[1];
    const content = String(children).replace(/\n$/, '');

    if (language === 'mermaid') {
      return <MermaidDiagram chart={content} className="!my-5 border border-[#dddddd] bg-white p-3" />;
    }

    const isInline = !className;
    return isInline ? (
      <code
        style={{ fontFamily: MONO_FONT }}
        className="bg-$[#F5F5F7] px-1.5 py-0.5 text-sm text-black"
      >
        {children}
      </code>
    ) : (
      <code
        style={{ fontFamily: MONO_FONT }}
        className="block overflow-x-auto bg-transparent p-0 text-sm leading-[1.5] text-black"
      >
        {children}
      </code>
    );
  },
  pre: ({ children }: { children?: ReactNode }) => (
    <pre
      style={{ fontFamily: MONO_FONT }}
      className="my-4 overflow-x-auto border border-[#dddddd] border-l-[4px] border-l-black bg-[#f5f5f5] p-4 text-sm leading-[1.5] text-black"
    >
      {children}
    </pre>
  ),
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="my-4 border-l-4 border-[#F5D13A] bg-[#fffbeb] px-4 py-3 text-sm italic leading-[1.7] text-[#333333]">
      {children}
    </blockquote>
  ),
  table: ({ children }: { children?: ReactNode }) => (
    <div className="my-4 overflow-hidden">
      <table className="w-full border-collapse text-left text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: ReactNode }) => <thead>{children}</thead>,
  tbody: ({ children }: { children?: ReactNode }) => <tbody>{children}</tbody>,
  tr: ({ children }: { children?: ReactNode }) => (
    <tr className="even:bg-[#f9f9f9]">{children}</tr>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th
      style={{ fontFamily: MONO_FONT }}
      className="bg-black px-2 py-3 text-xs font-bold   text-white"
    >
      {children}
    </th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td className="border-b border-[#eeeeee] px-2 py-2.5 align-top text-sm leading-[1.6] text-[#333333]">
      {children}
    </td>
  ),
  hr: () => <hr className="my-8 border-0 border-t-2 border-[#eeeeee]" />,
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} className="text-black underline decoration-[#F5D13A] underline-offset-2">
      {children}
    </a>
  ),
};

function MetaItem({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-w-[140px] flex-col gap-1">
      <span
        style={{ fontFamily: MONO_FONT }}
        className="text-xs   text-[#666666]"
      >
        {label}
      </span>
      <span
        style={{ fontFamily: MONO_FONT }}
        className="text-[13px] font-bold text-[#F5D13A]"
      >
        {value}
      </span>
    </div>
  );
}

export default function RunReportPdfDocument({
  title,
  markdown,
  sessionId,
  scopeName,
  runnerName,
  status,
  generatedAtLabel,
  classification = 'CONFIDENTIAL',
  artifacts = [],
}: RunReportPdfDocumentProps) {
  const displayTitle = title?.trim() || 'Mission Report';
  const displayStatus = status ? status.replace(/_/g, ' ').toUpperCase() : 'COMPLETED';
  const sessionRef = sessionId.substring(0, 8).toUpperCase();
  const signatureId = sessionId.substring(0, 12).toUpperCase();
  const markdownComponents = useMemo(
    () => ({
      ...baseMarkdownComponents,
      img: ({ src, alt, title }: { src?: string; alt?: string; title?: string }) => (
        <ReportEvidenceImage
          src={src}
          alt={alt}
          title={title}
          sessionId={sessionId}
          artifacts={artifacts}
        />
      ),
    }),
    [artifacts, sessionId],
  );

  return (
    <div
      style={{ fontFamily: BODY_FONT }}
      className="w-[794px] bg-white text-[#333333]"
    >
      <section
        className="flex min-h-[1123px] flex-col items-center justify-center bg-black px-[60px] py-[60px] text-center text-white"
        style={{ breakAfter: 'page', pageBreakAfter: 'always' }}
      >
        <div className="mb-20">
          <div
            style={{ fontFamily: MONO_FONT }}
            className="text-[22px] font-black   text-white"
          >
            NULLSQUARE
          </div>
          <div
            style={{ fontFamily: MONO_FONT }}
            className="mt-2 text-sm   text-[#666666]"
          >
            Security Assessment
          </div>
        </div>

        <div className="mb-16">
          <div
            style={{ fontFamily: MONO_FONT }}
            className="mb-5 inline-block bg-[#F5D13A] px-5 py-1.5 text-sm font-bold   text-black"
          >
            {classification}
          </div>
          <h1
            style={{ fontFamily: MONO_FONT }}
            className="mb-3 text-[32px] font-black   text-white"
          >
            {displayTitle}
          </h1>
          <p
            style={{ fontFamily: MONO_FONT }}
            className="text-[14px]   text-[#888888]"
          >
            {scopeName ?? 'Demo Scope'} // {runnerName ?? 'Private Runner'}
          </p>
        </div>

        <div className="mb-16 flex gap-10 border border-[#333333] px-12 py-6 text-left">
          <MetaItem label="Reference ID" value={sessionRef} />
          <MetaItem label="Generated" value={generatedAtLabel ?? 'In progress'} />
          <MetaItem label="Classification" value={classification} />
        </div>

        <div className="text-sm text-[#666666]">
          <p className="mb-1">This document contains confidential security assessment risk information.</p>
          <p>Unauthorized distribution is prohibited.</p>
        </div>
      </section>

      <section className="bg-white px-10 py-10">
        <div>
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents as never}>
            {markdown}
          </ReactMarkdown>
        </div>

        <div className="mt-16 border-t-2 border-black pt-10 text-center">
          <div className="mx-auto mb-4 h-px w-[200px] bg-black" />
          <p
            style={{ fontFamily: MONO_FONT }}
            className="text-[12px] font-bold   text-black"
          >
            NULLSQUARE SECURITY ASSESSMENT
          </p>
          <p
            style={{ fontFamily: MONO_FONT }}
            className="mt-2 text-sm text-[#666666]"
          >
            Digital Signature: {signatureId} // {displayStatus}
          </p>
        </div>
      </section>
    </div>
  );
}
