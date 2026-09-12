/** A rendered page plus its exact, contiguous span in the original text. */
export interface CardPage {
  rawStart: number;
  rawEnd: number;
  text: string;
}

interface MarkdownBlock {
  start: number;
  end: number;
  prefix: string;
  suffix: string;
}

function markdownBlocks(text: string): MarkdownBlock[] {
  const lines = [...text.matchAll(/[^\n]*\n|[^\n]+$/g)];
  const blocks: MarkdownBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i][0];
    const start = lines[i].index!;
    const opener = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
    if (opener && (opener[1][0] !== '`' || !opener[2].includes('`'))) {
      const marker = opener[1];
      const closing = new RegExp(
        `^ {0,3}${marker[0]}{${marker.length},}[\\t \\r]*\\n?$`,
      );
      let end = text.length;
      let closed = false;
      for (i++; i < lines.length; i++) {
        if (closing.test(lines[i][0])) {
          end = lines[i].index! + lines[i][0].length;
          closed = true;
          break;
        }
      }
      blocks.push({
        start,
        // Include the final boundary when an upstream stream has not closed
        // the fence yet, so the independently rendered page still closes it.
        end: closed ? end : end + 1,
        prefix: `${line.replace(/\r?\n$/, '')}\n`,
        suffix: `\n${marker}\n`,
      });
      continue;
    }
    const separator = lines[i + 1]?.[0].trim() ?? '';
    const table =
      line.includes('|') &&
      /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(separator);
    if (table) {
      const prefix = line + lines[i + 1][0];
      i += 2;
      while (
        i < lines.length &&
        lines[i][0].trim() &&
        lines[i][0].includes('|')
      )
        i++;
      const last = lines[i - 1];
      blocks.push({
        start,
        end: last.index! + last[0].length,
        prefix,
        suffix: '',
      });
      i--;
    }
  }
  return blocks;
}

/** Return a code-point boundary within a UTF-8 byte budget. */
function byteEnd(text: string, start: number, budget: number): number {
  let end = start;
  let used = 0;
  for (const point of text.slice(start)) {
    const size = Buffer.byteLength(point);
    if (used + size > budget) break;
    used += size;
    end += point.length;
  }
  return end;
}

/** Last-resort display for indivisible syntax that cannot fit on one card. */
function splitRawPages(text: string, maxBytes: number): CardPage[] {
  const notice = '> 内容较长，以下按原文分段展示。\n\n';
  const budget = maxBytes - Buffer.byteLength(notice);
  const pages: CardPage[] = [];
  for (let start = 0; start < text.length; ) {
    const end = byteEnd(text, start, budget);
    pages.push({
      rawStart: start,
      rawEnd: end,
      text: notice + text.slice(start, end),
    });
    start = end;
  }
  return pages;
}

/**
 * Preserve every source character across byte-bounded cards. Boundaries prefer
 * paragraphs and lines, keep tables/fences whole when they fit, and replay
 * their syntax on continuation pages. raw offsets exclude synthetic syntax.
 */
export function splitCardPages(
  text: string,
  { maxBytes = 18_000 }: { maxBytes?: number } = {},
): CardPage[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 256) {
    throw new Error('Card page budget must be at least 256 bytes');
  }
  if (!text) return [{ rawStart: 0, rawEnd: 0, text: '' }];
  const blocks = markdownBlocks(text);
  if (
    blocks.some(
      (block) =>
        Buffer.byteLength(block.prefix + block.suffix) > maxBytes - 128 ||
        (!block.suffix &&
          text
            .slice(block.start, block.end)
            .split('\n')
            .some(
              (row) => Buffer.byteLength(block.prefix + row + '\n') > maxBytes,
            )),
    )
  ) {
    return splitRawPages(text, maxBytes);
  }
  const containing = (offset: number) =>
    blocks.find((block) => offset > block.start && offset < block.end);
  const pages: CardPage[] = [];
  let start = 0;
  while (start < text.length) {
    const previous = containing(start);
    const prefix = previous?.prefix ?? '';
    let end = byteEnd(text, start, maxBytes - Buffer.byteLength(prefix));
    const candidateBlock = containing(end);
    if (end < text.length && candidateBlock && candidateBlock.start > start) {
      end = candidateBlock.start;
    } else if (end < text.length) {
      const paragraph = text.lastIndexOf('\n\n', end - 1) + 2;
      const newline = text.lastIndexOf('\n', end - 1) + 1;
      // A table or fenced code block may contain blank lines; line boundaries
      // are safe there once continuation syntax is supplied below.
      if (!containing(end) && paragraph > start + (end - start) / 3)
        end = paragraph;
      else if (newline > start) end = newline;
    }
    let suffix = containing(end)?.suffix ?? '';
    while (
      Buffer.byteLength(prefix + text.slice(start, end) + suffix) > maxBytes
    ) {
      end = byteEnd(text, start, maxBytes - Buffer.byteLength(prefix + suffix));
      const newline = text.lastIndexOf('\n', end - 1) + 1;
      if (newline > start) end = newline;
      suffix = containing(end)?.suffix ?? '';
    }
    if (end <= start) return splitRawPages(text, maxBytes);
    pages.push({
      rawStart: start,
      rawEnd: end,
      text: prefix + text.slice(start, end) + suffix,
    });
    start = end;
  }
  return pages;
}
