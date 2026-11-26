import React from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { SectionPanel, StackList, Badge } from '@null-ai/design-tokens/ui';
import { FileText, Package } from "lucide-react";
import { MermaidDiagram } from "@shared/ui/MermaidDiagram";

export interface MarkdownScanReportProps {
    markdown: string;
    attachments?: Array<{
        label: string;
        path?: string;
        type?: string;
        id?: string;
    }>;
    title?: string;
    onDownloadArtifact?: (id: string, name: string) => void;
}

/* Shared component map for ReactMarkdown */
const markdownComponents: Components = {
    h1: ({ children }: { children?: React.ReactNode }) => (
        <h1 className="text-base font-bold text-foreground uppercase tracking-wider mb-4 mt-8 first:mt-0 pb-2 border-b border-border/40 font-sans">
            {children}
        </h1>
    ),
    h2: ({ children }: { children?: React.ReactNode }) => (
        <h2 className="text-sm font-bold text-foreground uppercase tracking-wider mb-3 mt-6 pb-1.5 border-b border-border/20 font-sans">
            {children}
        </h2>
    ),
    h3: ({ children }: { children?: React.ReactNode }) => (
        <h3 className="text-xs font-bold text-foreground uppercase tracking-wider mb-2 mt-5 font-sans">
            {children}
        </h3>
    ),
    h4: ({ children }: { children?: React.ReactNode }) => (
        <h4 className="text-[11px] font-bold text-foreground uppercase tracking-wider mb-1.5 mt-4 font-sans">
            {children}
        </h4>
    ),
    p: ({ children }: { children?: React.ReactNode }) => (
        <p className="text-foreground/90 mb-3.5 leading-[1.7] text-[13px] font-sans">
            {children}
        </p>
    ),
    ul: ({ children }: { children?: React.ReactNode }) => (
        <ul className="space-y-1.5 mb-4 ml-1">
            {children}
        </ul>
    ),
    ol: ({ children }: { children?: React.ReactNode }) => (
        <ol className="list-decimal list-inside space-y-1.5 mb-4 ml-1 text-foreground/90 text-[13px] font-sans">
            {children}
        </ol>
    ),
    li: ({ children }: { children?: React.ReactNode }) => (
        <li className="text-foreground/90 text-[13px] flex items-start gap-2 leading-[1.7] font-sans">
            <span className="text-primary mt-[6px] text-[6px] shrink-0 select-none">■</span>
            <span className="flex-1">{children}</span>
        </li>
    ),
    strong: ({ children }: { children?: React.ReactNode }) => (
        <strong className="text-primary font-bold">
            {children}
        </strong>
    ),
    em: ({ children }: { children?: React.ReactNode }) => (
        <em className="text-foreground italic">
            {children}
        </em>
    ),
    code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
        const match = /language-(\w+)/.exec(className || '');
        const language = match?.[1];
        const content = String(children).replace(/\n$/, '');

        if (language === 'mermaid') {
            return (
                <div className="my-4 overflow-x-auto rounded-none border border-border/40 p-1 bg-muted/10">
                    <MermaidDiagram chart={content} />
                </div>
            );
        }

        const isInline = !className;
        return isInline ? (
            <code className="bg-muted px-1.5 py-0.5 rounded-none text-primary text-[12px] font-mono border border-border/30">
                {children}
            </code>
        ) : (
            <code className="block bg-muted/20 p-3.5 rounded-none border border-border/40 text-foreground text-[12px] font-mono overflow-x-auto my-4 leading-relaxed">
                {children}
            </code>
        );
    },
    pre: ({ children }: { children?: React.ReactNode }) => (
        <pre className="bg-muted/20 p-3.5 rounded-none border border-border/40 overflow-x-auto my-4 text-[12px] font-mono leading-relaxed">
            {children}
        </pre>
    ),
    blockquote: ({ children }: { children?: React.ReactNode }) => (
        <blockquote className="border-l-2 border-primary/50 bg-muted/20 pl-4 py-2 my-4 text-muted-foreground italic text-[12.5px] rounded-r-[4px]">
            {children}
        </blockquote>
    ),
    table: ({ children }: { children?: React.ReactNode }) => (
        <div className="overflow-x-auto my-5 rounded-none border border-border/40">
            <table className="w-full text-xs">
                {children}
            </table>
        </div>
    ),
    thead: ({ children }: { children?: React.ReactNode }) => (
        <thead className="bg-muted/30 border-b border-border/40">
            {children}
        </thead>
    ),
    tbody: ({ children }: { children?: React.ReactNode }) => (
        <tbody className="divide-y divide-border/20 bg-background/25">
            {children}
        </tbody>
    ),
    tr: ({ children }: { children?: React.ReactNode }) => (
        <tr className="hover:bg-muted/10 transition-colors">
            {children}
        </tr>
    ),
    th: ({ children }: { children?: React.ReactNode }) => (
        <th className="px-3.5 py-2.5 text-left text-[10px] text-foreground uppercase tracking-widest font-bold font-mono">
            {children}
        </th>
    ),
    td: ({ children }: { children?: React.ReactNode }) => (
        <td className="px-3.5 py-2.5 text-foreground/90 text-[12.5px] font-sans">
            {children}
        </td>
    ),
    hr: () => (
        <hr className="border-0 h-px bg-gradient-to-r from-transparent via-border/50 to-transparent my-6" />
    ),
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
        <a
            href={href}
            className="text-primary hover:text-primary/80 underline underline-offset-4 transition-colors font-sans"
            target="_blank"
            rel="noopener noreferrer"
        >
            {children}
        </a>
    ),
};

export const MarkdownScanReport: React.FC<MarkdownScanReportProps> = ({
    markdown,
    attachments = [],
    title = "SCAN REPORT",
    onDownloadArtifact,
}) => {
    const markdownContent = (
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
            {markdown}
        </ReactMarkdown>
    );

    // When title is empty or not provided, render seamlessly without a card wrapper
    const isInline = !title;

    return (
        <div className="space-y-6">
            {isInline ? (
                <div className="markdown-report text-[14px] leading-relaxed">
                    {markdownContent}
                </div>
            ) : (
                <SectionPanel
                    title={
                        <span className="flex items-center gap-2">
                            <FileText className="h-4 w-4 flex-none text-primary" aria-hidden />
                            {title}
                        </span>
                    }
                >
                    <div className="markdown-report">
                        {markdownContent}
                    </div>
                </SectionPanel>
            )}

            {attachments.length > 0 && (
                <SectionPanel
                    title={
                        <span className="flex items-center gap-2">
                            <Package className="h-4 w-4 flex-none text-primary" aria-hidden />
                            Artifacts
                        </span>
                    }
                    flush
                >
                    <StackList
                        rows={attachments.map((attachment, idx) => ({
                            key: `${attachment.path ?? attachment.label}-${idx}`,
                            title: attachment.label,
                            subtitle: attachment.path,
                            meta: (
                                <Badge variant="outline">{attachment.type ?? 'artifact'}</Badge>
                            ),
                            onSelect: attachment.id
                                ? () => onDownloadArtifact?.(attachment.id as string, attachment.label)
                                : undefined,
                        }))}
                    />
                </SectionPanel>
            )}
        </div>
    );
};

export default MarkdownScanReport;
