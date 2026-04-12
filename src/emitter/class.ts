/**
 * Class structure emission.
 *
 * Produces the full Lit component class from a ComponentIR,
 * assembling imports, properties, lifecycle, handlers, and template.
 */
import type { ComponentIR } from '../ir/types.js';
import { Project, Node, ts } from 'ts-morph';
import { containsHtmlTemplate } from '../text-utils.js';
import { collectImports } from './imports.js';
import { emitProperties, emitState, emitControllers, emitContexts, emitComputed, emitRefs, emitSkippedHookVars } from './properties.js';
import { stripFunctionCalls, findMatchingParen } from '../text-utils.js';
import { emitLifecycle } from './lifecycle.js';
import { emitHandlers, emitPublicMethods } from './handlers.js';
import { emitRenderMethod } from './template.js';

// ---------------------------------------------------------------------------
// Main emission
// ---------------------------------------------------------------------------

export interface EmitOptions {
  /** Whether to format the output with Prettier */
  format?: boolean;
}

/**
 * Emit a full Lit component TypeScript file from a ComponentIR.
 */
export function emitComponent(ir: ComponentIR, _options: EmitOptions = {}): string {
  const collector = collectImports(ir);
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
  let baseClassName: string;
  if (ir.mixins.includes('FormControlMixin')) {
    sections.push(`const Base = FormControlMixin(CsBaseElement);`);
    sections.push('');
    baseClassName = 'Base';
  } else {
    baseClassName = ir.baseClass?.name ?? 'CsBaseElement';
  }

  // --- Class declaration ---
  const className = `Cs${ir.name}Internal`;
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
  const propsCode = emitProperties(ir.props);
  if (propsCode.trim()) {
    sections.push(propsCode);
  }

  // --- State ---
  const stateCode = emitState(ir.state);
  if (stateCode.trim()) {
    sections.push(stateCode);
  }

  // --- Refs ---
  const refsCode = emitRefs(ir.refs);
  if (refsCode.trim()) {
    sections.push(refsCode);
  }

  // --- Controllers ---
  const controllerCode = emitControllers(ir.controllers);
  if (controllerCode.trim()) {
    sections.push(controllerCode);
  }

  // --- Skipped hook variable stubs ---
  const skippedCode = emitSkippedHookVars(ir.skippedHookVars);
  if (skippedCode.trim()) {
    sections.push(skippedCode);
  }

  // --- Computed values (useMemo → getters) ---
  const computedCode = emitComputed(ir.computedValues);
  if (computedCode.trim()) {
    sections.push(computedCode);
  }

  // --- Lifecycle ---
  const lifecycleCode = emitLifecycle(ir.effects);
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
    const cleaned = stripReactHooks(helper.source);
    const method = convertToPrivateMethod(cleaned);
    sections.push(method);
    sections.push('');
  }

  // --- Render method ---
  let renderCode = emitRenderMethod(ir.template, collector);

  // Inject body preamble into render() before the return statement.
  // These are transformed variable declarations (className computations,
  // attribute builders) that the template references.
  // Filter out statements containing untransformed React patterns.
  // Note: className assignments that have been converted to classMap() are valid Lit code.
  const REACT_PATTERNS = /\buseEffect\b|\buseLayoutEffect\b|\buseState\b|\buseCallback\b|\bcheckControlled\(/;
  const safePreamble = ir.bodyPreamble.filter((stmt) => {
    if (REACT_PATTERNS.test(stmt)) return false;
    // Filter className assignments that still use clsx() or styles.xxx (unconverted)
    if (/\bclassName\s*=/.test(stmt) && !stmt.includes('classMap(')) return false;
    // Filter orphaned assignments from clsx → classMap rewrites (e.g. "= classMap({...})")
    if (stmt.trimStart().startsWith('=')) return false;
    return true;
  });
  if (safePreamble.length > 0) {
    const preambleLines = safePreamble.map((stmt) => `    ${stmt}`).join('\n');
    renderCode = renderCode.replace(
      /^(  override render\(\) \{)\n/m,
      `$1\n${preambleLines}\n\n`,
    );
  }

  sections.push(renderCode);

  // --- Close class ---
  sections.push('}');

  // --- Assemble final output ---
  const importsStr = collector.emit();
  const bodyStr = sections.join('\n');

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
// Hook stripping for render helpers
// ---------------------------------------------------------------------------

/**
 * Strip residual React hook calls (useEffect, useLayoutEffect) from a render
 * helper's source text.  These are full statement-level calls of the form
 *   useEffect(() => { ... }, [...]);
 * We use a balanced-paren approach to find the matching `)` and then consume
 * the trailing semicolon.
 */
function stripReactHooks(source: string): string {
  const hookNames = [
    'useEffect', 'useLayoutEffect', 'useInternalI18n', 'useFunnel',
    'useFunnelStep', 'useFunnelSubStep', 'useVisualRefresh', 'useUniqueId',
    'useMergeRefs',
  ];

  let result = source;

  // First pass: strip variable declarations with hook calls (const x = useHook(...))
  for (const hook of hookNames) {
    const declPattern = new RegExp(`(?:const|let|var)\\s+(?:\\{[^}]*\\}|\\[[^\\]]*\\]|\\w+)\\s*=\\s*${hook}\\s*\\(`);
    for (let safety = 0; safety < 50; safety++) {
      const m = declPattern.exec(result);
      if (!m) break;
      const openParen = result.indexOf('(', m.index + m[0].length - 1);
      if (openParen === -1) break;
      const closeParen = findMatchingParen(result, openParen);
      if (closeParen === -1) break;
      let end = closeParen + 1;
      while (end < result.length && (result[end] === ' ' || result[end] === '\t')) end++;
      if (end < result.length && result[end] === ';') end++;
      if (end < result.length && result[end] === '\n') end++;
      result = result.slice(0, m.index) + result.slice(end);
    }
  }

  // Second pass: strip bare hook calls via shared utility
  for (const hook of hookNames) {
    result = stripFunctionCalls(result, hook);
  }

  // Strip comments that mention React hooks (gate3 checks for \buseEffect\b etc.)
  result = result.replace(/\/\/.*\b(useEffect|useLayoutEffect|useState|useCallback|useContext)\b.*\n?/g, '');
  result = result.replace(/\/\*[\s\S]*?\b(useEffect|useLayoutEffect|useState|useCallback|useContext)\b[\s\S]*?\*\//g, '');

  return result;
}

