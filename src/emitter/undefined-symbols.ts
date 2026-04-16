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
  'requestIdleCallback', 'cancelIdleCallback',
  'reportError', 'customElements',
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
const CLASS_MEMBER_RE = /(?:@\w+[^)]*\)\s*)?(?:private\s+)?(?:get\s+)?(_?\w+)\s*(?:[=:!?]|(?:\([^)]*\)\s*\{))/g;

const IDENT_RE = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function stubUndefinedSymbols(code: string): string {
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

  const stubs: string[] = [];
  stubs.push('// Stubs for stripped framework references (auto-generated)');
  for (const name of [...undefinedTypes].sort()) {
    stubs.push(`type ${name} = any;`);
  }
  for (const name of [...undefinedValues].sort()) {
    stubs.push(`const ${name}: any = undefined;`);
  }

  return injectStubs(code, stubs);
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
  // The class body extends from `export class ... {` to its matching `}`.
  const classStart = code.indexOf('export class ');
  if (classStart !== -1) {
    const braceStart = code.indexOf('{', classStart);
    if (braceStart !== -1) {
      let depth = 1;
      let pos = braceStart + 1;
      while (pos < code.length && depth > 0) {
        if (code[pos] === '{') depth++;
        else if (code[pos] === '}') depth--;
        pos++;
      }
      const classBody = code.slice(braceStart + 1, pos - 1);
      for (const match of classBody.matchAll(CLASS_MEMBER_RE)) {
        defined.add(match[1]);
      }
    }
  }

  defined.delete('');
  return defined;
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

function injectStubs(code: string, stubs: string[]): string {
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
