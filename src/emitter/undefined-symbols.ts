/**
 * Post-emission pass: detect undefined symbols and inject stubs.
 *
 * After the emitter produces output, this pass scans for identifiers
 * that are referenced but never defined (imports, declarations, params,
 * class members). For each, it injects a stub declaration so the output
 * compiles and doesn't throw ReferenceError at runtime.
 *
 * Uses regex-based detection on the predictable emitter output structure.
 */

// ---------------------------------------------------------------------------
// Known globals — never stub these
// ---------------------------------------------------------------------------

const KNOWN_GLOBALS = new Set([
  'console', 'window', 'document', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'queueMicrotask', 'structuredClone',
  'Array', 'Object', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef',
  'Promise', 'Math', 'JSON', 'Date', 'Number', 'String', 'Boolean',
  'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'Symbol', 'BigInt', 'Proxy', 'Reflect', 'Intl',
  'undefined', 'null', 'true', 'false', 'NaN', 'Infinity',
  'globalThis', 'self', 'arguments', 'this', 'super',
  'navigator', 'location', 'history', 'fetch', 'crypto', 'performance',
  'URL', 'URLSearchParams', 'Headers', 'Request', 'Response',
  'AbortController', 'AbortSignal',
  'Event', 'CustomEvent', 'HTMLElement', 'Element', 'Node', 'NodeList',
  'HTMLInputElement', 'HTMLButtonElement', 'HTMLAnchorElement',
  'HTMLDivElement', 'HTMLSpanElement', 'HTMLSlotElement',
  'HTMLFormElement', 'HTMLSelectElement', 'HTMLTextAreaElement',
  'CSSStyleDeclaration', 'CSSStyleSheet', 'DocumentFragment',
  'ShadowRoot', 'MutationObserver', 'ResizeObserver',
  'IntersectionObserver', 'PerformanceObserver',
  'getComputedStyle', 'matchMedia',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI',
  'btoa', 'atob', 'alert', 'confirm', 'prompt',
  'TextEncoder', 'TextDecoder', 'Blob', 'File', 'FileReader',
  'FormData', 'XMLHttpRequest',
  'Worker', 'MessageChannel', 'MessagePort', 'BroadcastChannel',
  'ReadableStream', 'WritableStream', 'TransformStream',
  'DOMParser', 'XMLSerializer',
  'KeyboardEvent', 'FocusEvent', 'MouseEvent', 'DragEvent',
  'ClipboardEvent', 'InputEvent', 'TouchEvent', 'PointerEvent',
  'WheelEvent', 'AnimationEvent', 'TransitionEvent', 'CompositionEvent',
  'SVGElement', 'SVGSVGElement', 'DataTransfer', 'Selection',
  'DOMRect', 'DOMRectReadOnly', 'DOMTokenList',
  'requestIdleCallback', 'cancelIdleCallback',
  'reportError', 'customElements',
  // Lit lifecycle methods (appear in override declarations)
  'willUpdate', 'firstUpdated', 'connectedCallback', 'disconnectedCallback',
  'updated', 'attributeChangedCallback', 'performUpdate', 'scheduleUpdate',
  'requestUpdate', 'updateComplete', 'createRenderRoot', 'adoptedCallback',
  // Lit @property() decorator option keys (appear in object literals)
  'reflect', 'attribute', 'converter', 'noAccessor', 'hasChanged',
  // EventInit property keys (appear in { bubbles: true, composed: true })
  'bubbles', 'composed', 'cancelable', 'detail',
  // HTML tag and CSS names that appear in template literals
  'div', 'span', 'button', 'input', 'label', 'form', 'select', 'option',
  'textarea', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'nav', 'header', 'footer',
  'main', 'section', 'article', 'aside', 'details', 'summary',
  'dialog', 'figure', 'figcaption', 'img', 'video', 'audio', 'source',
  'canvas', 'svg', 'path', 'circle', 'rect', 'line', 'polygon',
  'slot', 'template', 'br', 'hr', 'pre', 'code', 'blockquote',
  'host', 'display', 'block', 'inline', 'flex', 'grid', 'none',
  'contents', 'hidden', 'visible', 'relative', 'absolute', 'fixed',
  'sticky', 'solid', 'dashed', 'dotted', 'transparent', 'inherit',
  'initial', 'unset', 'auto', 'normal', 'bold', 'italic',
  'px', 'em', 'rem', 'vh', 'vw', 'calc', 'var', 'rgb', 'rgba',
  'hsl', 'hsla', 'url', 'attr',
  // Lit globals
  'html', 'css', 'svg', 'LitElement', 'ReactiveElement',
  'nothing', 'noChange', 'render',
  // Lit decorators / directives
  'property', 'state', 'query', 'queryAll', 'customElement',
  'classMap', 'styleMap', 'ifDefined', 'repeat', 'guard',
  'live', 'ref', 'cache', 'choose', 'when', 'map', 'join', 'range',
  'unsafeHTML', 'unsafeSVG', 'templateContent', 'until', 'asyncReplace',
  'asyncAppend', 'directive', 'Directive',
  'consume', 'provide', 'createContext', 'ContextConsumer', 'ContextProvider',
  'PropertyValues',
  // Lit class properties
  'styles', 'shadowRootOptions', 'elementProperties', 'properties',
  // TypeScript built-in utility types
  'Partial', 'Required', 'Readonly', 'Record', 'Pick', 'Omit',
  'Exclude', 'Extract', 'NonNullable', 'Parameters', 'ReturnType',
  'InstanceType', 'Awaited', 'ConstructorParameters',
  'ThisType', 'Uppercase', 'Lowercase', 'Capitalize', 'Uncapitalize',
  'ReadonlyArray', 'ReadonlyMap', 'ReadonlySet',
  'TemplateStringsArray', 'PromiseLike', 'ArrayLike', 'Iterable',
  'Iterator', 'AsyncIterable', 'AsyncIterator', 'Generator',
  'PropertyKey', 'PropertyDescriptor',
  // TS type keywords that appear as identifiers
  'any', 'unknown', 'never', 'void', 'string', 'number', 'boolean',
  'object', 'symbol', 'bigint',
  'keyof', 'typeof', 'infer', 'extends', 'implements',
  // JS keywords
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
  'continue', 'return', 'throw', 'try', 'catch', 'finally',
  'new', 'delete', 'in', 'of', 'instanceof', 'with', 'yield', 'await',
  'async', 'function', 'class', 'const', 'let', 'var', 'export',
  'import', 'default', 'from', 'as', 'type', 'interface', 'enum',
  'static', 'override', 'private', 'protected', 'public', 'readonly',
  'abstract', 'declare', 'get', 'set', 'is',
  // Prototype chain names
  'constructor', 'prototype', 'length', 'name', 'toString', 'valueOf',
  'hasOwnProperty', 'apply', 'call', 'bind',
]);

// ---------------------------------------------------------------------------
// Regex patterns for collecting defined symbols
// ---------------------------------------------------------------------------

const IMPORT_NAMED_RE = /import\s+(?:type\s+)?\{\s*([^}]+)\s*\}\s+from\s+['"][^'"]+['"]/g;
const IMPORT_DEFAULT_RE = /import\s+(\w+)\s+from\s+['"][^'"]+['"]/g;
const VAR_DECL_RE = /\b(?:const|let|var)\s+(\w+)\s*[=:]/g;
const FUNC_DECL_RE = /\bfunction\s+(\w+)\s*[(<]/g;
const CLASS_DECL_RE = /\bclass\s+(\w+)/g;
const TYPE_DECL_RE = /\btype\s+(\w+)\s*[=<]/g;
const INTERFACE_DECL_RE = /\binterface\s+(\w+)/g;
const ENUM_DECL_RE = /\benum\s+(\w+)/g;
const DESTRUCTURE_RE = /\b(?:const|let|var)\s+\{([^}]+)\}\s*=/g;
const ARRAY_DESTRUCTURE_RE = /\b(?:const|let|var)\s+\[([^\]]+)\]\s*=/g;

/**
 * Class member declarations — handles emitter output patterns:
 *   `@property({ type: String }) variant = "default";`
 *   `@state() private _count = 0;`
 *   `@query('.foo') private _el!: HTMLElement;`
 *   `@consume(...) private _ctx: FormFieldContext;`
 *   `private _handler = () => { ... }`
 *   `private get _something() { ... }`
 */
const CLASS_MEMBER_RE = /(?:@\w+[^)]*\)\s*)?(?:static\s+)?(?:override\s+)?(?:private\s+)?(?:get\s+)?(_?\w+)\s*(?:[=:!?]|(?:\([^)]*\)\s*\{))/g;

const IDENT_RE = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StubMode = 'stub' | 'diagnostic' | 'error';

export interface StubOptions {
  /** How to handle undefined symbols (default: 'stub') */
  mode?: StubMode;
  /** Component name for diagnostic/error messages */
  componentName?: string;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function detectUndefinedValueSymbols(code: string): string[] {
  const defined = collectDefinedSymbols(code);
  const { valueRefs } = collectReferencedSymbols(code);
  const result: string[] = [];
  for (const ref of valueRefs) {
    if (!defined.has(ref) && !KNOWN_GLOBALS.has(ref)) {
      result.push(ref);
    }
  }
  return result;
}

export function stubUndefinedSymbols(code: string, options?: StubOptions): string {
  const mode = options?.mode ?? 'stub';
  const componentName = options?.componentName ?? '<unknown>';
  const defined = collectDefinedSymbols(code);
  const { valueRefs, typeRefs } = collectReferencedSymbols(code);

  const undefinedValues = new Set<string>();
  const undefinedTypes = new Set<string>();

  for (const ref of valueRefs) {
    if (!defined.has(ref) && !KNOWN_GLOBALS.has(ref)) {
      undefinedValues.add(ref);
    }
  }

  for (const ref of typeRefs) {
    if (!defined.has(ref) && !KNOWN_GLOBALS.has(ref)) {
      undefinedTypes.add(ref);
    }
  }

  // `const X: any = undefined` satisfies both value and type usage in TS
  for (const v of undefinedValues) {
    undefinedTypes.delete(v);
  }

  if (undefinedValues.size === 0 && undefinedTypes.size === 0) {
    return code;
  }

  // In error mode, throw with all undefined symbols listed
  if (mode === 'error') {
    const allSymbols = [
      ...[...undefinedValues].map(n => `${n} (value)`),
      ...[...undefinedTypes].map(n => `${n} (type)`),
    ];
    throw new Error(
      `[stub-error] ${componentName}: ${allSymbols.length} undefined symbol(s): ${allSymbols.join(', ')}`
    );
  }

  // In diagnostic mode, log each stub
  if (mode === 'diagnostic') {
    for (const name of [...undefinedValues].sort()) {
      console.warn(`[stub] ${componentName}: ${name} (value)`);
    }
    for (const name of [...undefinedTypes].sort()) {
      console.warn(`[stub] ${componentName}: ${name} (type)`);
    }
  }

  // Type stubs go at module scope (erased at compile time, esbuild doesn't care)
  const typeStubs: string[] = [];
  if (undefinedTypes.size > 0) {
    typeStubs.push('// Type stubs for stripped framework references (auto-generated)');
    for (const name of [...undefinedTypes].sort()) {
      typeStubs.push(`type ${name} = any;`);
    }
  }

  // Value stubs go inside render() so esbuild can't tree-shake them
  const valueStubs: string[] = [];
  if (undefinedValues.size > 0) {
    for (const name of [...undefinedValues].sort()) {
      valueStubs.push(`const ${name}: any = {};`);
    }
  }

  let result = code;
  if (typeStubs.length > 0) {
    result = injectTypeStubs(result, typeStubs);
  }
  if (valueStubs.length > 0) {
    result = injectValueStubsInRender(result, valueStubs);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Symbol collection
// ---------------------------------------------------------------------------

function collectDefinedSymbols(code: string): Set<string> {
  const defined = new Set<string>();

  // Named imports
  for (const match of code.matchAll(IMPORT_NAMED_RE)) {
    for (const part of match[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const asMatch = trimmed.match(/\w+\s+as\s+(\w+)/);
      defined.add(asMatch ? asMatch[1] : (trimmed.match(/^(\w+)/) ?? [])[1] ?? '');
    }
  }

  // Default imports
  for (const match of code.matchAll(IMPORT_DEFAULT_RE)) {
    if (match[0].includes('import type')) continue;
    defined.add(match[1]);
  }

  // Variable declarations
  for (const match of code.matchAll(VAR_DECL_RE)) defined.add(match[1]);

  // Destructured declarations
  for (const match of code.matchAll(DESTRUCTURE_RE)) {
    for (const part of match[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const colonMatch = trimmed.match(/\w+\s*:\s*(\w+)/);
      defined.add(colonMatch ? colonMatch[1] : (trimmed.match(/^(\w+)/) ?? [])[1] ?? '');
    }
  }

  // Array destructured declarations
  for (const match of code.matchAll(ARRAY_DESTRUCTURE_RE)) {
    for (const part of match[1].split(',')) {
      const trimmed = part.trim().replace(/^\.\.\./, '');
      const nameMatch = trimmed.match(/^(\w+)/);
      if (nameMatch) defined.add(nameMatch[1]);
    }
  }

  for (const match of code.matchAll(FUNC_DECL_RE)) defined.add(match[1]);
  for (const match of code.matchAll(CLASS_DECL_RE)) defined.add(match[1]);
  for (const match of code.matchAll(TYPE_DECL_RE)) defined.add(match[1]);
  for (const match of code.matchAll(INTERFACE_DECL_RE)) defined.add(match[1]);
  for (const match of code.matchAll(ENUM_DECL_RE)) defined.add(match[1]);

  // Class members (properties, methods, getters declared inside the class)
  // Applied to full code — the regex is specific enough (private/override/decorator)
  // to avoid false matches outside the class. Brace-based class body extraction
  // fails on template literals containing `}`.
  for (const match of code.matchAll(CLASS_MEMBER_RE)) {
    defined.add(match[1]);
  }

  // Function/arrow params, for-loop variables, catch variables
  for (const p of collectFunctionParams(code)) {
    defined.add(p);
  }

  // Interface/type body member names (property keys, not runtime values)
  for (const match of code.matchAll(/(?:^|\n)\s*(?:readonly\s+)?(\w+)\s*[?:](?!.*=>)/gm)) {
    const name = match[1];
    if (name && /^[a-z]/.test(name)) defined.add(name);
  }

  defined.delete('');
  return defined;
}

function collectFunctionParams(code: string): Set<string> {
  const params = new Set<string>();

  // Arrow function params: (a, b) => or (a: Type, b) =>
  const arrowRE = /\(([^)]*)\)\s*(?::\s*\w+\s*)?=>/g;
  for (const match of code.matchAll(arrowRE)) {
    extractParamNames(match[1], params);
  }

  // Regular/method params: function foo(a, b) { or methodName(a: T) {
  const funcParamRE = /(?:function\s+\w+|(?:private\s+)?_?\w+)\s*\(([^)]*)\)\s*(?::\s*[^{]+?)?\s*\{/g;
  for (const match of code.matchAll(funcParamRE)) {
    extractParamNames(match[1], params);
  }

  // for-of / for-in variables: for (const x of ...) or for (const x in ...)
  const forRE = /for\s*\(\s*(?:const|let|var)\s+(\w+)\s+(?:of|in)\b/g;
  for (const match of code.matchAll(forRE)) {
    params.add(match[1]);
  }

  // for-loop index variables: for (let i = 0; ...)
  const forIdxRE = /for\s*\(\s*(?:let|var)\s+(\w+)\s*=/g;
  for (const match of code.matchAll(forIdxRE)) {
    params.add(match[1]);
  }

  // catch clause: catch (e)
  const catchRE = /catch\s*\(\s*(\w+)\s*\)/g;
  for (const match of code.matchAll(catchRE)) {
    params.add(match[1]);
  }

  return params;
}

function extractParamNames(paramStr: string, out: Set<string>): void {
  for (const part of paramStr.split(',')) {
    const trimmed = part.trim().replace(/^\.\.\./, '');
    if (!trimmed) continue;
    // Handle destructured params: { a, b } or [a, b]
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const inner = trimmed.slice(1).replace(/[}\]].*/, '');
      for (const sub of inner.split(',')) {
        const name = sub.trim().replace(/:.*/, '').trim().match(/^(\w+)/);
        if (name) out.add(name[1]);
      }
      continue;
    }
    // Simple param: name or name: Type or name = default
    const nameMatch = trimmed.match(/^(\w+)/);
    if (nameMatch) out.add(nameMatch[1]);
  }
}

/**
 * Collect referenced identifiers, separating value vs type positions.
 *
 * Type positions: after `:`, in `<>`, after `as`, after `extends`/`implements`.
 * Value positions: everything else (excluding property access after `.`).
 */
function collectReferencedSymbols(code: string): { valueRefs: Set<string>; typeRefs: Set<string> } {
  const valueRefs = new Set<string>();
  const typeRefs = new Set<string>();

  const stripped = stripStringsAndComments(code);

  // Match identifiers with their preceding non-word character.
  // Group 1: the character before the identifier (undefined at line start).
  // Group 2: the identifier (2+ chars to skip loop vars).
  // Skip if preceded by `.` (property access like `this.variant`).
  const standaloneIdents = new Set<string>();
  const contextRE = /(?:^|([^A-Za-z0-9_$]))([A-Za-z_$][A-Za-z0-9_$]+)\b/gm;
  for (const match of stripped.matchAll(contextRE)) {
    const preceding = match[1];
    const ident = match[2];
    if (preceding === '.') continue;
    standaloneIdents.add(ident);
  }

  // Type-position references (uppercase identifiers after `:`, `as`, `extends`, in `<>`)
  const typeAnnotationRE = /:\s*([A-Z][A-Za-z0-9_$]*)\b/g;
  for (const match of stripped.matchAll(typeAnnotationRE)) typeRefs.add(match[1]);

  const asCastRE = /\bas\s+([A-Z][A-Za-z0-9_$]*)\b/g;
  for (const match of stripped.matchAll(asCastRE)) typeRefs.add(match[1]);

  const genericRE = /[<,]\s*([A-Z][A-Za-z0-9_$]*)\b/g;
  for (const match of stripped.matchAll(genericRE)) typeRefs.add(match[1]);

  const extendsRE = /\b(?:extends|implements)\s+([A-Z][A-Za-z0-9_$]*)\b/g;
  for (const match of stripped.matchAll(extendsRE)) typeRefs.add(match[1]);

  for (const ident of standaloneIdents) {
    if (!typeRefs.has(ident)) {
      valueRefs.add(ident);
    }
  }

  return { valueRefs, typeRefs };
}

// ---------------------------------------------------------------------------
// String/comment stripping
// ---------------------------------------------------------------------------

function stripStringsAndComments(code: string): string {
  let result = code;
  result = result.replace(/\/\/[^\n]*/g, '');
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');
  result = result.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  result = result.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  result = stripTemplateLiteralContent(result);
  return result;
}

/**
 * Strip static parts of template literals while preserving ${...} expressions.
 * Uses a character scanner to handle nested template literals correctly.
 * Input: `text${expr}more` → `    ${expr}    `
 */
function stripTemplateLiteralContent(code: string): string {
  const chars = [...code];
  const result = [...code];
  let i = 0;

  function scanTemplateLiteral() {
    // Current position is right after the opening backtick
    while (i < chars.length) {
      if (chars[i] === '\\') {
        result[i] = ' ';
        i++;
        if (i < chars.length) { result[i] = ' '; i++; }
        continue;
      }
      if (chars[i] === '`') {
        result[i] = ' ';
        i++;
        return;
      }
      if (chars[i] === '$' && i + 1 < chars.length && chars[i + 1] === '{') {
        result[i] = ' ';
        result[i + 1] = ' ';
        i += 2;
        scanExpression();
        continue;
      }
      result[i] = ' ';
      i++;
    }
  }

  function scanExpression() {
    // Inside ${...}, keep content but handle nested template literals and braces
    let braceDepth = 1;
    while (i < chars.length && braceDepth > 0) {
      if (chars[i] === '`') {
        result[i] = ' ';
        i++;
        scanTemplateLiteral();
        continue;
      }
      if (chars[i] === '{') { braceDepth++; i++; continue; }
      if (chars[i] === '}') {
        braceDepth--;
        if (braceDepth === 0) { result[i] = ' '; i++; return; }
        i++;
        continue;
      }
      if (chars[i] === '"') {
        i++;
        while (i < chars.length && chars[i] !== '"') {
          if (chars[i] === '\\') i++;
          i++;
        }
        if (i < chars.length) i++;
        continue;
      }
      if (chars[i] === "'") {
        i++;
        while (i < chars.length && chars[i] !== "'") {
          if (chars[i] === '\\') i++;
          i++;
        }
        if (i < chars.length) i++;
        continue;
      }
      i++;
    }
  }

  while (i < chars.length) {
    if (chars[i] === '`') {
      result[i] = ' ';
      i++;
      scanTemplateLiteral();
      continue;
    }
    i++;
  }

  return result.join('');
}

// ---------------------------------------------------------------------------
// Stub injection
// ---------------------------------------------------------------------------

function injectTypeStubs(code: string, stubs: string[]): string {
  if (stubs.length === 0) return code;

  const stubBlock = stubs.join('\n');
  const lines = code.split('\n');
  let lastImportLine = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('import ')) {
      lastImportLine = i;
    }
  }

  if (lastImportLine === -1) {
    return stubBlock + '\n\n' + code;
  }

  const before = lines.slice(0, lastImportLine + 1).join('\n');
  const after = lines.slice(lastImportLine + 1).join('\n');
  return before + '\n\n' + stubBlock + '\n' + after;
}

function injectValueStubsInRender(code: string, stubs: string[]): string {
  if (stubs.length === 0) return code;

  const renderMatch = code.match(/^([ \t]*)(override\s+)?render\s*\(\s*\)\s*\{/m);
  if (!renderMatch) {
    return injectTypeStubs(code, stubs);
  }

  const insertPos = renderMatch.index! + renderMatch[0].length;
  const indent = renderMatch[1] + '  ';
  const stubBlock = stubs.map(s => indent + s).join('\n');

  return code.slice(0, insertPos) + '\n' + stubBlock + code.slice(insertPos);
}
