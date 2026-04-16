/**
 * Class structure emission.
 *
 * Produces the full Lit component class from a ComponentIR,
 * assembling imports, properties, lifecycle, handlers, and template.
 */
import type { ComponentIR } from '../ir/types.js';
import type { OutputConfig } from '../config.js';
import { Project, Node, ts } from 'ts-morph';
import { containsHtmlTemplate } from '../text-utils.js';
import { getHtmlElementProps } from '../standards.js';
import { collectIRText } from '../ir/transform-helpers.js';
import { capitalize } from '../naming.js';
import { collectImports } from './imports.js';
import { emitProperties, emitState, emitControllers, emitContexts, emitComputed, emitRefs, emitSkippedHookVars } from './properties.js';
import type { DeferredInit } from './properties.js';
import { findMatchingParen } from '../text-utils.js';
import { emitLifecycle } from './lifecycle.js';
import { emitHandlers, emitPublicMethods } from './handlers.js';
import { emitRenderMethod } from './template.js';
import { stubUndefinedSymbols, detectUndefinedValueSymbols } from './undefined-symbols.js';
import type { StubMode } from './undefined-symbols.js';
import { eliminateDeadCode, collectStrippedSymbols } from './dead-code-elimination.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toKebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Strip classMap() wrapper from preamble variable declarations.
 * `const className = classMap({ 'a': true })` → `const className = { 'a': true }`
 *
 * Only unwraps when the classMap call is the sole RHS of an assignment
 * (e.g., `= classMap({...})`). Uses balanced paren matching.
 */
function unwrapClassMapInPreamble(stmt: string): string {
  const idx = stmt.indexOf('= classMap(');
  if (idx === -1) return stmt;
  const openParen = idx + '= classMap'.length;
  const closeParen = findMatchingParen(stmt, openParen);
  if (closeParen === -1) return stmt;
  // Extract the inner argument (the object literal)
  const inner = stmt.slice(openParen + 1, closeParen);
  return stmt.slice(0, idx + 2) + inner + stmt.slice(closeParen + 1);
}

// ---------------------------------------------------------------------------
// Main emission
// ---------------------------------------------------------------------------

export interface EmitOptions {
  /** Whether to format the output with Prettier */
  format?: boolean;
  /** Optional output configuration for class naming and imports */
  output?: OutputConfig;
  /** How to handle undefined symbols: 'stub' (default), 'diagnostic', or 'error' */
  stubMode?: StubMode;
}

/**
 * Emit a full Lit component TypeScript file from a ComponentIR.
 */
export function emitComponent(ir: ComponentIR, _options: EmitOptions = {}): string {
  const collector = collectImports(ir, _options.output);
  const sections: string[] = [];

  // --- Imports ---
  // (collected during emission, emitted at the end)

  // --- Host styles ---
  const hostDisplay = ir.hostDisplay ?? 'block';
  sections.push(`const hostStyles = css\`:host { display: ${hostDisplay}; }\`;`);
  sections.push('');

  // --- File-level constants ---
  if (ir.fileConstants.length > 0) {
    for (const constant of ir.fileConstants) {
      sections.push(constant);
    }
    sections.push('');
  }

  // --- File-level type declarations ---
  if (ir.fileTypeDeclarations.length > 0) {
    for (const typeDecl of ir.fileTypeDeclarations) {
      sections.push(typeDecl);
    }
    sections.push('');
  }

  // --- Helpers (utility only — render helpers go inside the class) ---
  const utilityHelpers = ir.helpers.filter(h => !isRenderHelper(h.source));
  const renderHelpers = ir.helpers.filter(h => isRenderHelper(h.source));

  for (const helper of utilityHelpers) {
    sections.push(helper.source);
    sections.push('');
  }

  // --- Mixin application ---
    const defaultBase = ir.baseClass?.name ?? _options.output?.baseClass?.name ?? 'LitElement';
  let baseClassName: string;
  if (ir.mixins.includes('FormControlMixin')) {
    sections.push(`const Base = FormControlMixin(${defaultBase});`);
    sections.push('');
    baseClassName = 'Base';
  } else {
    baseClassName = defaultBase;
  }

  // --- Class declaration ---
  const className = ir.name;
  const typeParamStr = ir.typeParams?.length ? `<${ir.typeParams.join(', ')}>` : '';
  sections.push(`export class ${className}${typeParamStr} extends ${baseClassName} {`);
  sections.push(`  static override styles = [sharedStyles, componentStyles, hostStyles];`);
  sections.push('');

  // --- Context consumers/providers ---
  const contextCode = emitContexts(ir.contexts);
  if (contextCode.trim()) {
    sections.push(contextCode);
  }

  // --- Properties ---
  // Collect all IR text once — used for filtering unused slot getters and hook vars.
  const allCode = collectIRText(ir);

  // Filter out slot props whose getter/method is never referenced in the IR.
  const filteredProps = ir.props.filter(prop => {
    if (prop.category !== 'slot') return true;
    const memberName = prop.name === 'children' ? '_hasChildren' : `_has${capitalize(prop.name)}Slot`;
    return new RegExp('\\b' + memberName + '\\b').test(allCode);
  });

  // Filter out HTMLElement-inherited props that are never referenced in
  // the component code.  Props like className and id exist on HTMLElement
  // and are inherited from React's overlay types but the component never
  // actually uses them — emitting them adds noise.
  const htmlElementProps = getHtmlElementProps();
  const activeProps = filteredProps.filter(prop => {
    if (!htmlElementProps.has(prop.name)) return true;
    if (prop.category === 'slot' || prop.category === 'event') return true;
    return new RegExp('\\bthis\\.' + prop.name + '\\b').test(allCode);
  });

  const allDeferred: DeferredInit[] = [];
  const propsResult = emitProperties(activeProps);
  if (propsResult.code.trim()) {
    sections.push(propsResult.code);
  }
  allDeferred.push(...propsResult.deferred);

  // --- State ---
  const stateResult = emitState(ir.state);
  if (stateResult.code.trim()) {
    sections.push(stateResult.code);
  }
  allDeferred.push(...stateResult.deferred);

  // --- Refs ---
  const refsResult = emitRefs(ir.refs);
  if (refsResult.code.trim()) {
    sections.push(refsResult.code);
  }
  allDeferred.push(...refsResult.deferred);

  // --- Controllers ---
  const controllerResult = emitControllers(ir.controllers);
  if (controllerResult.code.trim()) {
    sections.push(controllerResult.code);
  }
  allDeferred.push(...controllerResult.deferred);

  // --- Skipped hook variable stubs ---
  // Filter out stubs that are never referenced anywhere in the IR.
  const usedHookVars = ir.skippedHookVars.filter(
    name => new RegExp('\\b_' + name + '\\b').test(allCode),
  );
  const skippedCode = emitSkippedHookVars(usedHookVars);
  if (skippedCode.trim()) {
    sections.push(skippedCode);
  }

  // --- Computed values (useMemo → getters) ---
  const computedCode = emitComputed(ir.computedValues);
  if (computedCode.trim()) {
    sections.push(computedCode);
  }

  // --- Lifecycle ---
  const lifecycleCode = emitLifecycle(ir.effects, allDeferred);
  if (lifecycleCode.trim()) {
    sections.push(lifecycleCode);
  }

  // --- Public methods ---
  const publicMethodCode = emitPublicMethods(ir.publicMethods);
  if (publicMethodCode.trim()) {
    sections.push(publicMethodCode);
  }

  // --- Handlers ---
  const handlerCode = emitHandlers(ir.handlers);
  if (handlerCode.trim()) {
    sections.push(handlerCode);
  }

  // --- Render helpers (as private methods) ---
  for (const helper of renderHelpers) {
    const method = convertToPrivateMethod(helper.source);
    sections.push(method);
    sections.push('');
  }

  // --- Render method ---
  let renderCode = emitRenderMethod(ir.template, collector);

  // Inject body preamble into render() before the return statement.
  // These are transformed variable declarations (className computations,
  // attribute builders) that the template references.
  // Filter out statements that are standalone React hook calls.
  // Statements where a hook call is embedded in a larger expression
  // (e.g., `const x = { ref: useMergeRefs(...) }`) are NOT filtered —
  // those need the hook call cleaned up, not the whole statement removed.
  // Note: className assignments that have been converted to classMap() are valid Lit code.
  const safePreamble = ir.bodyPreamble.filter((stmt) => {
    // Standalone hook call: `useEffect(...)` or `useLayoutEffect(...)`
    const trimmed = stmt.trimStart();
    if (/^use[A-Z]\w*\s*\(/.test(trimmed)) return false;
    // Variable initialized purely from a hook: `const x = useFoo(...)`
    if (/^(?:const|let|var)\s+(?:\{[^}]*\}|\[[^\]]*\]|\w+)\s*=\s*use[A-Z]\w*\s*\(/.test(trimmed)) return false;
    // Filter className assignments that still use clsx() or styles.xxx (unconverted)
    if (/\bclassName\s*=/.test(stmt) && !stmt.includes('classMap(')) return false;
    // Filter orphaned assignments from clsx → classMap rewrites (e.g. "= classMap({...})")
    if (stmt.trimStart().startsWith('=')) return false;
    return true;
  });
  // Filter preamble: keep only statements whose assigned variable is
  // actually referenced in the template or render-helper bodies.
  // Conservative: destructured assignments and side-effect statements
  // (no simple variable name extractable) are always kept.
  const renderRefCorpus = renderCode + '\n' + renderHelpers.map(h => h.source).join('\n');
  const usedPreamble = safePreamble.filter(stmt => {
    const match = stmt.trimStart().match(/^(?:const|let|var)\s+(\w+)\s*=/);
    if (!match) return true; // side-effect, destructuring, etc. — keep
    const varName = match[1];
    return new RegExp('\\b' + varName + '\\b').test(renderRefCorpus);
  });

  if (usedPreamble.length > 0) {
    // Strip classMap() wrapper from preamble variables — the template emitter
    // will add classMap() when rendering the class attribute. Keeping classMap()
    // in the preamble would cause double-wrapping.
    const preambleLines = usedPreamble
      .map((stmt) => unwrapClassMapInPreamble(stmt))
      .map((stmt) => `    ${stmt}`)
      .join('\n');
    renderCode = renderCode.replace(
      /^(  override render\(\) \{)\n/m,
      `$1\n${preambleLines}\n\n`,
    );
  }

  sections.push(renderCode);

  // --- Close class ---
  sections.push('}');

  // --- Custom element registration ---
  const tagPrefix = _options.output?.tagPrefix ?? 'x';
  const tagName = `${tagPrefix}-${toKebabCase(className)}`;
  sections.push('');
  sections.push(`customElements.define('${tagName}', ${className});`);

  // --- Assemble final output ---
  let bodyStr = sections.join('\n');

  // Strip unused private class members and top-level declarations.
  // This runs before import filtering so that removing a member
  // also allows its import to be detected as unused.
  bodyStr = stripUnusedPrivateMembers(bodyStr);
  bodyStr = stripUnusedTopLevelDeclarations(bodyStr);

  collector.filterUnused(bodyStr);
  collector.promoteToTypeImports(bodyStr);
  const importsStr = collector.emit();

  const raw = `${importsStr}\n\n${bodyStr}\n`;

  // Dead-code elimination: remove code that transitively depends on
  // stripped framework symbols (analytics, funnel tracking, etc.)
  const deadSymbols = collectStrippedSymbols(raw);
  const afterDCE = eliminateDeadCode(raw, deadSymbols);

  // Second DCE pass: eliminate references to remaining undefined symbols
  // Conservative mode: only remove template attrs and object shorthand, not declarations
  const undefinedSyms = detectUndefinedValueSymbols(afterDCE);
  const afterDCE2 = eliminateDeadCode(afterDCE, undefinedSyms, true);

  // Stub undefined symbols (stripped framework references like analytics)
  const withStubs = stubUndefinedSymbols(afterDCE2, {
    mode: _options.stubMode,
    componentName: ir.name,
  });

  // Final text-based cleanup for any remaining React patterns
  // Clean up excessive blank lines
  return withStubs.replace(/\n{3,}/g, '\n\n');
}

// ---------------------------------------------------------------------------
// Dead code elimination — unused private members and top-level declarations
// ---------------------------------------------------------------------------

/**
 * Remove private class members (fields, methods, getters) whose names are
 * not referenced anywhere else in the class body.  Handles single-line and
 * multi-line declarations (arrow functions, method bodies with braces).
 *
 * Patterns matched:
 *  - `@query(...) private _name...;`
 *  - `@state()\n  private _name...;`
 *  - `private _name: type;`
 *  - `private _name = value;`
 *  - `private _name = () => { ... };`
 *  - `private get name() { ... }`
 */
function stripUnusedPrivateMembers(body: string): string {
  const lines = body.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Handle decorator + private on SAME line: `@query(...) private _name...;`
    const inlineDecoratorMatch = trimmed.match(
      /^@(?:query|state|consume|provide)\b.*\bprivate\s+(?:get\s+)?(_?\w+)/,
    );
    if (inlineDecoratorMatch) {
      const memberName = inlineDecoratorMatch[1];
      const declEnd = findDeclarationEnd(lines, i);
      const restOfBody = buildRestOfBody(lines, i, declEnd);

      if (isMemberReferenced(memberName, restOfBody)) {
        for (let j = i; j <= declEnd; j++) result.push(lines[j]);
      }
      i = declEnd + 1;
      continue;
    }

    // Handle decorator on separate line, private on next line
    let decoratorStart = -1;
    if (/^@(?:query|state|consume|provide)\b/.test(trimmed)) {
      decoratorStart = i;
      let peek = i + 1;
      while (peek < lines.length && lines[peek].trim() === '') peek++;
      if (peek < lines.length && /^\s*private\s+/.test(lines[peek])) {
        i = peek;
      } else {
        result.push(line);
        i++;
        continue;
      }
    }

    const privMatch = lines[i].trimStart().match(
      /^private\s+(?:get\s+)?(_?\w+)/,
    );

    if (!privMatch) {
      if (decoratorStart >= 0) {
        result.push(lines[decoratorStart]);
        i = decoratorStart + 1;
      } else {
        result.push(line);
        i++;
      }
      continue;
    }

    const memberName = privMatch[1];
    const declStart = decoratorStart >= 0 ? decoratorStart : i;
    const declEnd = findDeclarationEnd(lines, i);
    const restOfBody = buildRestOfBody(lines, declStart, declEnd);

    if (isMemberReferenced(memberName, restOfBody)) {
      for (let j = declStart; j <= declEnd; j++) result.push(lines[j]);
    }

    i = declEnd + 1;
  }

  return result.join('\n');
}

function buildRestOfBody(lines: string[], declStart: number, declEnd: number): string {
  const before = lines.slice(0, declStart).join('\n');
  const after = lines.slice(declEnd + 1).join('\n');
  return before + '\n' + after;
}

/**
 * Check if a member name is referenced in the body text.
 * For underscore-prefixed names: plain word-boundary match (no string false positives).
 * For non-underscore names (slot getters like `trigger`): require `this.name` access
 * to avoid false positives from string literals containing the word.
 */
function isMemberReferenced(name: string, body: string): boolean {
  if (name.startsWith('_')) {
    return new RegExp('\\b' + name + '\\b').test(body);
  }
  // Non-underscore private members (e.g., slot getters) — only count `this.name` access
  return new RegExp('this\\.' + name + '\\b').test(body);
}

/**
 * Find the last line index of a declaration starting at `startLine`.
 * Handles multi-line arrow functions and method bodies by tracking
 * brace depth.
 */
function findDeclarationEnd(lines: string[], startLine: number): number {
  const firstLine = lines[startLine];

  // Single-line declaration ending with `;`
  if (/;\s*$/.test(firstLine) && !firstLine.includes('{')) {
    return startLine;
  }

  // Track brace depth for multi-line bodies
  let braceDepth = 0;
  let foundOpen = false;
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { braceDepth++; foundOpen = true; }
      if (ch === '}') braceDepth--;
    }
    // If we've seen at least one brace and are back to zero, or
    // we hit a semicolon at brace depth 0 — declaration is complete
    if (foundOpen && braceDepth <= 0) return i;
    if (!foundOpen && /;\s*$/.test(lines[i])) return i;
  }

  return startLine; // fallback: treat as single line
}

/**
 * Remove top-level `const`, `let`, or `function` declarations that are
 * not referenced in the class body (the `export class ... { }` section).
 */
function stripUnusedTopLevelDeclarations(body: string): string {
  const lines = body.split('\n');
  const result: string[] = [];

  // Find the class body range
  const classStartIdx = lines.findIndex(l => /^export class\s/.test(l));
  const classBody = classStartIdx >= 0 ? lines.slice(classStartIdx).join('\n') : '';

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Only process lines BEFORE the class (top-level scope) and skip hostStyles
    if (i >= classStartIdx || trimmed.startsWith('export ')) {
      result.push(line);
      i++;
      continue;
    }

    // Match top-level const/let/var or function declarations
    const constMatch = trimmed.match(/^(?:const|let|var)\s+(\w+)\s*[=:]/);
    const funcMatch = !constMatch ? trimmed.match(/^function\s+(\w+)\s*[(<]/) : null;

    if (!constMatch && !funcMatch) {
      result.push(line);
      i++;
      continue;
    }

    const varName = (constMatch || funcMatch)![1];

    // Skip hostStyles — always needed
    if (varName === 'hostStyles' || varName === 'Base') {
      result.push(line);
      i++;
      continue;
    }

    // Determine declaration extent
    const declEnd = findDeclarationEnd(lines, i);

    // Check if the name is referenced in the class body
    const namePattern = new RegExp('\\b' + varName + '\\b');
    if (namePattern.test(classBody)) {
      for (let j = i; j <= declEnd; j++) result.push(lines[j]);
    }
    // else: strip the declaration

    i = declEnd + 1;
  }

  return result.join('\n');
}

// ---------------------------------------------------------------------------
// Render helper detection and conversion
// ---------------------------------------------------------------------------

/**
 * Check if a helper function contains template rendering (html`` tagged templates).
 */
function isRenderHelper(source: string): boolean {
  return containsHtmlTemplate(source);
}

/**
 * Convert a helper function source to a private class method using ts-morph.
 *
 * Handles: function Foo(...) { }, const Foo = (...) => { }, const Foo = (...) => expr
 */
let _helperProject: Project | undefined;

function convertToPrivateMethod(source: string): string {
  // Strip export keywords
  let s = source.replace(/^\s*export\s+default\s+/, '').replace(/^\s*export\s+/, '');

  if (!_helperProject) {
    _helperProject = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { target: ts.ScriptTarget.ESNext, strict: false },
    });
  }

  const existing = _helperProject.getSourceFile('__helper.ts');
  if (existing) _helperProject.removeSourceFile(existing);

  let sf;
  try {
    sf = _helperProject.createSourceFile('__helper.ts', s);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[react-to-lit] Warning: failed to parse helper, emitting raw: ${msg}`);
    return `  ${s.replace(/\n/g, '\n  ')}`;
  }

  // Find the first function or variable declaration
  for (const stmt of sf.getStatements()) {
    // function Foo(...) { ... }
    if (Node.isFunctionDeclaration(stmt) && stmt.getName()) {
      const name = toPrivateMethodName(stmt.getName()!);
      const params = stmt.getParameters().map(p => p.getText()).join(', ');
      const body = stmt.getBody()?.getText() ?? '{}';
      return `  private ${name}(${params}) ${body}`;
    }

    // const Foo = (...) => { ... } or const Foo = (...) => expr
    if (Node.isVariableStatement(stmt)) {
      for (const decl of stmt.getDeclarationList().getDeclarations()) {
        const varName = decl.getName();
        const methodName = toPrivateMethodName(varName);
        const init = decl.getInitializer();

        if (init && Node.isArrowFunction(init)) {
          const params = init.getParameters().map(p => p.getText()).join(', ');
          const body = init.getBody();
          if (Node.isBlock(body)) {
            return `  private ${methodName}(${params}) ${body.getText()}`;
          } else {
            // Expression body
            return `  private ${methodName}(${params}) { return ${body.getText()}; }`;
          }
        }

        if (init && Node.isFunctionExpression(init)) {
          const params = init.getParameters().map(p => p.getText()).join(', ');
          const body = init.getBody()?.getText() ?? '{}';
          return `  private ${methodName}(${params}) ${body}`;
        }

        // Non-function value (e.g., const header = html`...`) → getter
        if (init) {
          const value = init.getText();
          return `  private get ${methodName}() { return ${value}; }`;
        }
      }
    }
  }

  // Fallback: emit as-is
  return `  ${s.replace(/\n/g, '\n  ')}`;
}

/**
 * Convert a helper name to a private method name.
 * - "RenderFoo" → "_renderFoo"
 * - "renderFoo" → "_renderFoo"
 * - "fooBar" → "_fooBar"
 */
function toPrivateMethodName(name: string): string {
  if (name.startsWith('_')) return name;
  if (/^Render[A-Z]/.test(name)) return `_${name[0].toLowerCase()}${name.slice(1)}`;
  if (/^[A-Z]/.test(name)) return `_render${name}`;
  if (name.startsWith('render')) return `_${name}`;
  return `_${name}`;
}

// ---------------------------------------------------------------------------

