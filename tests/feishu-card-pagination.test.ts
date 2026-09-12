import { describe, expect, test } from 'vitest';
import { splitCardPages } from '../src/feishu-cards/pagination.js';
import { splitIntoBodySections } from '../src/feishu-cards/length.js';
import { buildAgentReplyCard } from '../src/feishu-cards/builder.js';

function verifyCoverage(source: string, maxBytes: number) {
  const pages = splitCardPages(source, { maxBytes });
  let position = 0;
  for (const page of pages) {
    expect(page.rawStart).toBe(position);
    expect(page.rawEnd).toBeGreaterThan(page.rawStart);
    expect(page.text).toContain(source.slice(page.rawStart, page.rawEnd));
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(maxBytes);
    expect(page.text).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
    position = page.rawEnd;
  }
  expect(position).toBe(source.length);
  expect(pages.map((p) => source.slice(p.rawStart, p.rawEnd)).join('')).toBe(
    source,
  );
  return pages;
}

describe('card pagination', () => {
  test('five 2500-character paragraphs survive final rendering (12508-character regression)', () => {
    const source = Array.from({ length: 5 }, (_, i) =>
      String(i).repeat(2500),
    ).join('\n\n');
    expect(source.length).toBe(12508);
    const card = buildAgentReplyCard({ text: source, status: 'done' });
    const body = card.body as {
      elements: Array<{ tag: string; content?: string }>;
    };
    expect(
      body.elements
        .filter((e) => e.tag === 'markdown')
        .map((e) => e.content)
        .join(''),
    ).toBe(source);
  });

  test('paragraph sections preserve exact whitespace and blank lines inside code', () => {
    const source =
      'Intro\n\n' + '```ts\n' + 'const x = 1;\n\n'.repeat(450) + '```\n\nTail';
    const sections = splitIntoBodySections(source);
    expect(sections.map((section) => section.text).join('')).toBe(source);
    const code = sections.find((section) => section.text.includes('```ts'))!;
    expect(code.text).toContain('const x = 1;\n\n'.repeat(450));
    expect(code.text).toContain('```\n');
  });

  test('completed cards retain indentation on the first code line', () => {
    const source = '    const x = 1;\n    console.log(x);\n';
    const card = buildAgentReplyCard({ text: source, status: 'done' });
    const body = card.body as { elements: Array<{ content?: string }> };
    expect(body.elements[0].content).toBe(source);
  });

  test('CJK and emoji use UTF-8 byte limits without splitting surrogate pairs', () => {
    verifyCoverage('中文🙂👨‍👩‍👧‍👦 e\u0301\n'.repeat(800), 1024);
  });

  test.each(['```typescript', '~~~~python'])(
    'continuation pages close and reopen %s fences',
    (opener) => {
      const marker = opener.startsWith('`') ? '```' : '~~~~';
      const source =
        `Intro\n\n${opener}\n` +
        'const 中文 = "🙂";\n\n'.repeat(200) +
        marker +
        '\nTail';
      const pages = verifyCoverage(source, 1024);
      expect(pages.length).toBeGreaterThan(2);
      for (const page of pages) {
        const fences = page.text
          .split('\n')
          .filter((line) => line.startsWith(marker));
        expect(fences.length % 2).toBe(0);
      }
    },
  );

  test('open upstream fence is closed in the displayed tail only', () => {
    const source = '```ts\n' + 'const x = 1;\n'.repeat(100);
    const pages = verifyCoverage(source, 600);
    expect(pages.at(-1)?.text.endsWith('\n```\n')).toBe(true);
    expect(source.endsWith('```')).toBe(false);
  });

  test('table pages repeat the header and preserve every row once', () => {
    const header = '| Key | Value |\n| --- | --- |\n';
    const rows = Array.from(
      { length: 100 },
      (_, i) => `| key_${i} | 中文详情_${i} |\n`,
    );
    const source = header + rows.join('');
    const pages = verifyCoverage(source, 600);
    for (const page of pages) expect(page.text.startsWith(header)).toBe(true);
    const allRows = pages.flatMap((p) =>
      p.text.split('\n').filter((row) => row.startsWith('| key_')),
    );
    expect(allRows).toEqual(rows.map((row) => row.trimEnd()));
  });

  test('a fitting table stays on one page even after a long introduction', () => {
    const table = '| Name | Status |\n| --- | --- |\n| Read | Done |\n';
    const source = 'Intro '.repeat(90) + '\n\n' + table;
    const pages = verifyCoverage(source, 570);
    expect(pages.some((page) => page.text.includes(table))).toBe(true);
  });

  test('a huge single line makes progress without truncating', () => {
    const source = '🙂'.repeat(2500);
    const pages = verifyCoverage(source, 1024);
    expect(pages.map((page) => page.text).join('')).toBe(source);
  });

  test.each([
    '| Name | Value |\n| --- | --- |\n| one | ' + '字'.repeat(1000) + ' |\n',
    '```' + 'language'.repeat(200) + '\nconst x = 1;\n```',
  ])(
    'indivisible Markdown keeps the complete source with an explicit plain continuation notice',
    (source) => {
      const pages = verifyCoverage(source, 600);
      expect(
        pages.every((page) =>
          page.text.startsWith('> 内容较长，以下按原文分段展示。'),
        ),
      ).toBe(true);
    },
  );

  test('empty content and invalid byte budgets have explicit behavior', () => {
    expect(splitCardPages('')).toEqual([{ rawStart: 0, rawEnd: 0, text: '' }]);
    expect(() => splitCardPages('hello', { maxBytes: 0 })).toThrow('256');
  });
});
