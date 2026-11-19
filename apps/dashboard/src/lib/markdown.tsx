import { Fragment, type ReactNode } from "react";

/**
 * A deliberately small Markdown parser for docs/api.md: #/##/### headings, paragraphs, "- " lists,
 * fenced code blocks, pipe tables (with escaped `\|` inside cells) and inline `code` / **bold**.
 * It returns plain data so the page decides how each block renders (no innerHTML anywhere).
 */
export type MdBlock =
  | { type: "heading"; level: number; text: string; id: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "code"; lang: string; text: string }
  | { type: "table"; header: string[]; rows: string[][] };

export function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[`*]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const PIPE = "\u0000";

/** Splits "| a | b \| c |" into ["a", "b | c"]. */
export function splitRow(line: string): string[] {
  let s = line.trim().replace(/\\\|/g, PIPE);
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim().split(PIPE).join("|"));
}

const isSeparator = (cells: string[]) => cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
const startsBlock = (line: string) => /^(#{1,6}\s|```|\||- )/.test(line);

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  const used = new Map<string, number>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(/^```\s*([\w-]*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence
      blocks.push({ type: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const text = h[2]!.trim();
      let id = slugify(text) || "section";
      const n = used.get(id) ?? 0;
      used.set(id, n + 1);
      if (n) id = `${id}-${n}`;
      blocks.push({ type: "heading", level: h[1]!.length, text, id });
      i++;
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        const cells = splitRow(lines[i++]!);
        if (!isSeparator(cells)) rows.push(cells);
      }
      const [header = [], ...rest] = rows;
      blocks.push({ type: "table", header, rows: rest });
      continue;
    }
    if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("- ")) {
        let item = lines[i++]!.slice(2);
        // Indented continuation lines belong to the item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!)) item += " " + lines[i++]!.trim();
        items.push(item);
      }
      blocks.push({ type: "list", items });
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!)) para.push(lines[i++]!.trim());
    blocks.push({ type: "paragraph", text: para.join(" ") });
  }
  return blocks;
}

/** Renders inline `code` and **bold** (bold may contain code). */
export function Inline({ text }: { text: string }): ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*.+?\*\*)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (!p) return null;
        if (p.startsWith("`") && p.endsWith("`") && p.length > 1) return <code key={i}>{p.slice(1, -1)}</code>;
        if (p.startsWith("**") && p.endsWith("**") && p.length > 4)
          return (
            <strong key={i}>
              <Inline text={p.slice(2, -2)} />
            </strong>
          );
        return <Fragment key={i}>{p}</Fragment>;
      })}
    </>
  );
}

/** Plain text of an inline string (for search and copy): drops the markers. */
export const plain = (text: string) => text.replace(/\*\*/g, "").replace(/`/g, "");
