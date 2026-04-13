/**
 * Web standards queries — derived from TypeScript's DOM and ES lib types.
 *
 * Instead of hardcoding lists of global names, ARIA properties, or boolean
 * attributes, we query the TypeScript compiler which embeds the standards.
 * Results are cached — the compiler is only invoked once.
 */
import { Project, ts } from 'ts-morph';

// ---------------------------------------------------------------------------
// Shared compiler instance
// ---------------------------------------------------------------------------

let _project: Project | undefined;
let _globals: Set<string> | undefined;
let _htmlElementProps: Set<string> | undefined;
let _booleanAttrs: Set<string> | undefined;

function getProject(): Project {
  if (!_project) {
    _project = new Project({
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        lib: ['lib.dom.d.ts', 'lib.es2022.d.ts'],
      },
    });
  }
  return _project;
}

// ---------------------------------------------------------------------------
// Global scope names (ES2022 + DOM)
// ---------------------------------------------------------------------------

/**
 * All names available in the global scope: JS built-ins (Array, Object, Map,
 * Promise, ...), DOM APIs (document, window, HTMLElement, Event, ...),
 * Web APIs (fetch, setTimeout, ResizeObserver, ...), and JS keywords.
 *
 * Used by the identifier rewriter to avoid prefixing globals with `this.`.
 */
export function getGlobalNames(): Set<string> {
  if (_globals) return _globals;

  const project = getProject();
  const sf = project.createSourceFile('__globals.ts', '');
  const checker = project.getTypeChecker().compilerObject;
  const tsSf = sf.compilerNode;

  const symbols = checker.getSymbolsInScope(
    tsSf,
    ts.SymbolFlags.Variable | ts.SymbolFlags.Function |
    ts.SymbolFlags.Class | ts.SymbolFlags.Interface |
    ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Enum |
    ts.SymbolFlags.Module,
  );

  _globals = new Set(symbols.map(s => s.getName()));

  // JS keywords/literals (not symbols in the compiler's scope)
  for (const kw of [
    'true', 'false', 'null', 'undefined', 'void',
    'this', 'super', 'arguments', 'props', 'state',
  ]) {
    _globals.add(kw);
  }

  // Lit-specific names (no standard source — framework-specific)
  for (const lit of [
    'html', 'css', 'svg', 'nothing', 'LitElement', 'PropertyValues',
    'classMap', 'ifDefined', 'repeat', 'guard', 'cache', 'live',
    'styleMap', 'unsafeHTML', 'unsafeSVG',
  ]) {
    _globals.add(lit);
  }

  project.removeSourceFile(sf);
  return _globals;
}

// ---------------------------------------------------------------------------
// HTMLElement properties (for `override` detection)
// ---------------------------------------------------------------------------

/**
 * All properties on HTMLElement — any of these needs `override` when
 * redeclared on a LitElement subclass.
 */
export function getHtmlElementProps(): Set<string> {
  if (_htmlElementProps) return _htmlElementProps;

  const project = getProject();
  const sf = project.createSourceFile('__dom.ts',
    'const __el: HTMLElement = null as any;');
  const decl = sf.getVariableDeclaration('__el')!;
  const type = project.getTypeChecker().getTypeAtLocation(decl);

  _htmlElementProps = new Set(type.getProperties().map(p => p.getName()));
  project.removeSourceFile(sf);
  return _htmlElementProps;
}

// ---------------------------------------------------------------------------
// Boolean HTML attributes (for `?attr=` binding)
// ---------------------------------------------------------------------------

/**
 * HTML attributes that are boolean (presence/absence, not string values).
 * Queried from HTMLInputElement which has the most boolean attributes.
 * Used to emit `?disabled=\${expr}` instead of `.disabled=\${expr}`.
 */
export function getBooleanAttributes(): Set<string> {
  if (_booleanAttrs) return _booleanAttrs;

  const project = getProject();
  const sf = project.createSourceFile('__bool.ts',
    'const __el: HTMLInputElement = null as any;');
  const decl = sf.getVariableDeclaration('__el')!;
  const checker = project.getTypeChecker();
  const type = checker.getTypeAtLocation(decl);

  _booleanAttrs = new Set<string>();
  for (const prop of type.getProperties()) {
    const name = prop.getName();
    const propDecls = prop.getDeclarations();
    if (propDecls.length === 0) continue;
    const propDecl = propDecls[0];
    const propType = checker.getTypeAtLocation(propDecl);
    const typeText = propType.getText();
    if (typeText === 'boolean') {
      _booleanAttrs.add(name);
    }
  }

  project.removeSourceFile(sf);
  return _booleanAttrs;
}

// ---------------------------------------------------------------------------
// HTML tag names (for distinguishing HTML elements from components)
// ---------------------------------------------------------------------------

let _htmlTagNames: Set<string> | undefined;

/**
 * Valid HTML element tag names, queried from HTMLElementTagNameMap.
 * Used to distinguish native elements from custom components.
 */
export function getHtmlTagNames(): Set<string> {
  if (_htmlTagNames) return _htmlTagNames;

  const project = getProject();
  const sf = project.createSourceFile('__tags.ts', '');
  const checker = project.getTypeChecker();

  // HTMLElementTagNameMap has all standard HTML tag names as keys
  const tagMapSymbol = checker.compilerObject.resolveName(
    'HTMLElementTagNameMap', sf.compilerNode, ts.SymbolFlags.Interface, false,
  );

  _htmlTagNames = new Set<string>();
  if (tagMapSymbol) {
    const tagMapType = checker.compilerObject.getDeclaredTypeOfSymbol(tagMapSymbol);
    for (const prop of tagMapType.getProperties?.() ?? []) {
      _htmlTagNames.add(prop.getName());
    }
  }

  project.removeSourceFile(sf);
  return _htmlTagNames;
}

// HTML void elements — cannot have children or closing tags.
// Per https://html.spec.whatwg.org/multipage/syntax.html#void-elements
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

export function isVoidElement(tag: string): boolean {
  return VOID_ELEMENTS.has(tag);
}
