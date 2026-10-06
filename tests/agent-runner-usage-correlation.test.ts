import fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

// Execute the production serialization boundary without starting an SDK query.
const source = ts.createSourceFile(
  'runner.ts',
  fs.readFileSync(
    new URL('../container/agent-runner/src/index.ts', import.meta.url),
    'utf8',
  ),
  ts.ScriptTarget.Latest,
  true,
);
const declaration = source.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'writeOutput',
)!;
const compiled = ts.transpileModule(declaration.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
function emit(output: Record<string, unknown>, activeInput: string): any {
  const lines: string[] = [];
  const writer = new Function(
    'activeOutputInputTurnId',
    'console',
    'OUTPUT_START_MARKER',
    'OUTPUT_END_MARKER',
    `${compiled}; return writeOutput;`,
  )(activeInput, { log: (line: string) => lines.push(line) }, 'START', 'END');
  writer(output);
  return JSON.parse(lines[1]);
}

describe('usage WS immutable input correlation', () => {
  test('copies explicit A owner into usage even when B is active and its presentation ID differs', () => {
    const output = emit(
      {
        status: 'stream',
        inputTurnId: 'delivery-a',
        turnId: 'presentation-a',
        streamEvent: {
          eventType: 'usage',
          turnId: 'presentation-a',
          inputTurnId: 'incorrect-b',
          queryRunId: 'query-a',
          usage: { inputTokens: 1 },
        },
      },
      'delivery-b',
    );
    expect(output.inputTurnId).toBe('delivery-a');
    expect(output.streamEvent).toMatchObject({
      inputTurnId: 'delivery-a',
      turnId: 'presentation-a',
      queryRunId: 'query-a',
    });
  });
  test('uses the existing active input fallback only for a frame without an explicit owner', () => {
    const output = emit(
      {
        status: 'stream',
        streamEvent: { eventType: 'usage', turnId: 'presentation-b' },
      },
      'delivery-b',
    );
    expect(output.streamEvent.inputTurnId).toBe('delivery-b');
    expect(output.streamEvent.turnId).toBe('presentation-b');
  });
  test('leaves ordinary presentation events unchanged', () => {
    const output = emit(
      {
        status: 'stream',
        streamEvent: {
          eventType: 'text_delta',
          turnId: 'presentation-b',
          text: 'B',
        },
      },
      'delivery-b',
    );
    expect(output.streamEvent).toEqual({
      eventType: 'text_delta',
      turnId: 'presentation-b',
      text: 'B',
    });
  });
});
