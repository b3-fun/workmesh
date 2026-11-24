import { memo, type ReactNode } from "react";
import { cn } from "../b3os/ds/lib/utils";
import { parseMarkdown, type Block, type Inline } from "../lib/markdown";

// Renders the safe subset from lib/markdown as React text nodes: no raw HTML ever reaches the DOM. Styled by
// `.bp-md` in board.css, on the console's tokens.

function inline(nodes: Inline[], key = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case "text":
        return n.v;
      case "code":
        return <code key={k}>{n.v}</code>;
      case "strong":
        return <strong key={k}>{inline(n.c, `${k}.`)}</strong>;
      case "em":
        return <em key={k}>{inline(n.c, `${k}.`)}</em>;
      case "link":
        return (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer" className="kit-link">
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
        <p key={i} className="bp-md__h">
          {inline(b.c)}
        </p>
      );
    case "code":
      return (
        <pre key={i} className="bp-md__pre">
          <code>{b.v}</code>
        </pre>
      );
    case "quote":
      return (
        <p key={i} className="bp-md__quote">
          {inline(b.c)}
        </p>
      );
    case "list": {
      const Tag = b.ordered ? "ol" : "ul";
      return (
        <Tag key={i} start={b.ordered ? b.start : undefined}>
          {b.items.map((it, j) => (
            <li key={j} style={it.level ? { marginLeft: `${it.level * 1.1}rem` } : undefined}>
              {inline(it.c)}
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <div key={i} className="bp-md__table">
          <table>
            <thead>
              <tr>
                {b.head.map((c, j) => (
                  <th key={j}>{inline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, k) => (
                    <td key={k}>{inline(c)}</td>
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
  return <div className={cn("bp-md", className)}>{parseMarkdown(text).map(block)}</div>;
});
