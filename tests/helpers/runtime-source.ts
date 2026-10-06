import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute whole production functions with explicit dependencies, without
// importing index.ts (which starts the server). No routing/cursor algorithm is
// copied into the harness. Missing globals fail normally instead of becoming
// permissive mocks, and tests assert observable effects rather than source text.
const sources = new Map<string, ts.SourceFile>();
function readSource(location: URL): ts.SourceFile {
  const key = location.href;
  let source = sources.get(key);
  if (!source) {
    source = ts.createSourceFile(
      key,
      fs.readFileSync(location, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    sources.set(key, source);
  }
  return source;
}
const compiled = new Map<string, vm.Script>();

function unique(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
  const matches: ts.Node[] = [];
  function visit(node: ts.Node): void {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  if (matches.length !== 1) {
    throw new Error(
      `Expected one production function, found ${matches.length}`,
    );
  }
  return matches[0];
}

function named(
  name: string,
  source: ts.SourceFile,
  root: ts.Node = source,
): ts.Node {
  return unique(
    root,
    (node) =>
      (ts.isFunctionDeclaration(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name?.getText(source) === name,
  );
}

export function createRuntimeSourceHarness(
  globals: Record<string, unknown>,
  location = new URL('../../src/index.ts', import.meta.url),
) {
  const source = readSource(location);
  const context = vm.createContext(globals);
  function installNode(
    name: string,
    node: ts.Node,
    wrap = (code: string) => code,
  ): void {
    const key = `${source.fileName}:${name}:${node.pos}`;
    let script = compiled.get(key);
    if (!script) {
      const expression = ts.isVariableDeclaration(node)
        ? node.initializer!
        : node;
      const js = ts.transpileModule(
        `globalThis[${JSON.stringify(name)}] = (${wrap(expression.getText(source).replace(/^export\s+/, ''))});`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
      ).outputText;
      script = new vm.Script(js, { filename: `index.ts:${name}` });
      compiled.set(key, script);
    }
    script.runInContext(context);
  }
  return {
    globals,
    install(name: string, owner?: string): void {
      installNode(
        name,
        named(name, source, owner ? named(owner, source) : source),
      );
    },
    installMainOutput(): void {
      const call = unique(
        named('processGroupMessages', source),
        (node) =>
          ts.isCallExpression(node) &&
          node.expression.getText(source) === 'runAgent',
      ) as ts.CallExpression;
      installNode('handleMainOutput', call.arguments[4]);
    },
    /** Install the argument of the unique `callee(...)` call in `owner`. */
    installCallArgument(
      name: string,
      owner: string,
      callee: string,
      index: number,
    ): void {
      const call = unique(
        named(owner, source),
        (node) =>
          ts.isCallExpression(node) &&
          node.expression.getText(source) === callee,
      ) as ts.CallExpression;
      installNode(name, call.arguments[index]);
    },
    /**
     * Install the `finally` block of `owner`'s top-level try statement as an
     * async function, so its cleanup runs against the provided state.
     */
    installFinally(name: string, owner: string): void {
      const fn = named(owner, source) as ts.FunctionDeclaration;
      const statement = unique(
        fn,
        (node) =>
          ts.isTryStatement(node) &&
          node.finallyBlock !== undefined &&
          node.parent === fn.body,
      ) as ts.TryStatement;
      installNode(
        name,
        statement.finallyBlock!,
        (block) => `async () => ${block}`,
      );
    },
  };
}
