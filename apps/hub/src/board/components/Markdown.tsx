import { memo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "../lib/markdown";
import { cx } from "./ui";

// Renders the safe subset from lib/markdown as React text nodes: no raw HTML ever reaches the DOM.

function inline(nodes: Inline[], key = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case "text":
        return n.v;
      case "code":
        return (
          <code key={k} className="rounded-[4px] bg-sunk px-1 py-px font-mono text-[0.88em] text-fg [overflow-wrap:anywhere]">
            {n.v}
          </code>
        );
      case "strong":
        return (
          <strong key={k} className="font-semibold text-fg">
            {inline(n.c, `${k}.`)}
          </strong>
        );
      case "em":
        return <em key={k}>{inline(n.c, `${k}.`)}</em>;
      case "link":
        return (
          <a
            key={k}
            href={n.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-accent underline decoration-accent/30 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-accent"
          >
            {inline(n.c, `${k}.`)}
          </a>
        );
    }
  });
}

function block(b: Block, i: number): ReactNode {
  switch (b.t) {
    case "p":
      return <p key={i}>{inline(b.c)}</p>;
    case "h":
      return (
        <p key={i} className="font-semibold text-fg">
          {inline(b.c)}
        </p>
      );
    case "code":
      return (
        <pre
          key={i}
          className="scroll-thin overflow-x-auto rounded-md border border-line bg-sunk px-3 py-2 font-mono text-[12px] leading-[1.55] text-fg"
        >
          <code>{b.v}</code>
        </pre>
      );
    case "quote":
      return (
        <p key={i} className="border-l-2 border-line-strong pl-3 text-muted">
          {inline(b.c)}
        </p>
      );
    case "list": {
      const Tag = b.ordered ? "ol" : "ul";
      return (
        <Tag key={i} start={b.ordered ? b.start : undefined} className={cx("flex flex-col gap-0.5 pl-5", b.ordered ? "list-decimal" : "list-disc")}>
          {b.items.map((it, j) => (
            <li key={j} style={it.level ? { marginLeft: `${it.level * 1.1}rem` } : undefined} className="pl-0.5 marker:text-faint">
              {inline(it.c)}
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <div key={i} className="scroll-thin overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12.5px]">
            <thead>
              <tr>
                {b.head.map((c, j) => (
                  <th key={j} className="border-b border-line-strong py-1 pr-4 font-semibold whitespace-nowrap text-fg">
                    {inline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, k) => (
                    <td key={k} className="border-b border-line py-1 pr-4 align-top">
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={cx("flex min-w-0 flex-col gap-2 [overflow-wrap:break-word]", className)}>{parseMarkdown(text).map(block)}</div>;
});
