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
import { collectIRText } from '../ir/transform-helpers.js';
import { collectImports } from './imports.js';
import { emitProperties, emitState, emitControllers, emitContexts, emitComputed, emitRefs, emitSkippedHookVars } from './properties.js';
import type { DeferredInit } from './properties.js';
import { findMatchingParen } from '../text-utils.js';
import { emitLifecycle } from './lifecycle.js';
import { emitHandlers, emitPublicMethods } from './handlers.js';
import { emitRenderMethod } from './template.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  sections.push(`const hostStyles = css\`:host { display: block; }\`;`);
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
  const classPrefix = _options.output?.classPrefix ?? 'Cs';
  const classSuffix = _options.output?.classSuffix ?? 'Internal';
  const className = `${classPrefix}${ir.name}${classSuffix}`;
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
  const allDeferred: DeferredInit[] = [];
  const propsResult = emitProperties(ir.props);
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
  const allCode = collectIRText(ir);
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

  // --- Assemble final output ---
  const bodyStr = sections.join('\n');
  collector.filterUnused(bodyStr);
  const importsStr = collector.emit();

  const raw = `${importsStr}\n\n${bodyStr}\n`;

  // Final text-based cleanup for any remaining React patterns
  // Clean up excessive blank lines
  return raw.replace(/\n{3,}/g, '\n\n');
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

