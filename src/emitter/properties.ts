/**
 * Property and state declaration emission.
 *
 * Produces @property() and @state() declarations from PropIR and StateIR.
 */
import type { PropIR, StateIR, ControllerIR, ContextIR, ComputedIR, RefIR } from '../ir/types.js';
import { getHtmlElementProps } from '../standards.js';
import { camelToKebab } from '../naming.js';

// ---------------------------------------------------------------------------
// Native DOM properties — queried from TypeScript's DOM lib, not hardcoded.
// ---------------------------------------------------------------------------

/**
 * Check if a prop needs `override` — i.e., it already exists on HTMLElement.
 * Only applies when the prop is an attribute (not property-only with attribute: false),
 * since property-only bindings don't conflict with DOM reflections.
 */
function needsOverride(prop: PropIR): boolean {
  if (prop.category === 'property' && prop.attribute === false) return false;
  return getHtmlElementProps().has(prop.name);
}

// ---------------------------------------------------------------------------
// Property emission
// ---------------------------------------------------------------------------

export function emitProperties(props: PropIR[]): { code: string; deferred: DeferredInit[] } {
  const lines: string[] = [];
  const deferred: DeferredInit[] = [];

  for (const prop of props) {
    // Event callback props — declare as optional function properties
    // so identifier-rewritten references (this.onChange) compile.
    if (prop.category === 'event') {
      lines.push(`  ${prop.name}?: (...args: any[]) => void;`);
      continue;
    }

    // Slot props — emit a slotted-content check helper
    if (prop.category === 'slot') {
      if (prop.name === 'children') {
        // Default slot: check any non-slot-assigned children.
        // Use a separate name to avoid conflict with HTMLElement.children.
        lines.push(`  /** True when the default slot has content. */`);
        lines.push(`  private get _hasChildren() { return this.childElementCount > 0; }`);
      } else {
        // Named slot: check for elements assigned to this slot
        lines.push(`  /** True when the '${prop.name}' slot has content. */`);
        lines.push(`  private get ${prop.name}() { return !!this.querySelector('[slot="${prop.name}"]'); }`);
      }
      lines.push('');
      continue;
    }

    const decoratorParts: string[] = [];

    // type
    if (prop.litType) {
      decoratorParts.push(`type: ${prop.litType}`);
    }

    // attribute
    if (prop.attribute === false) {
      decoratorParts.push('attribute: false');
    } else if (prop.attribute && prop.attribute !== prop.name) {
      decoratorParts.push(`attribute: '${prop.attribute}'`);
    }

    const decorator = decoratorParts.length > 0
      ? `@property({ ${decoratorParts.join(', ')} })`
      : '@property()';

    const override = needsOverride(prop) ? 'override ' : '';
    const typeAnnotation = getTypeAnnotation(prop);

    if (prop.default && refsThis(prop.default)) {
      // Defer initialization to firstUpdated to avoid TS2729
      lines.push(`  ${decorator}`);
      lines.push(`  ${override}${prop.name}${typeAnnotation};`);
      deferred.push({ assignment: `this.${prop.name} ??= ${prop.default};` });
    } else {
      const defaultValue = prop.default ? ` = ${prop.default}` : '';
      lines.push(`  ${decorator}`);
      lines.push(`  ${override}${prop.name}${typeAnnotation}${defaultValue};`);
    }
    lines.push('');
  }

  return { code: lines.join('\n'), deferred };
}

// ---------------------------------------------------------------------------
// State emission
// ---------------------------------------------------------------------------

export interface DeferredInit {
  /** Assignment statement for firstUpdated, e.g. "this._foo = this.bar;" */
  assignment: string;
}

/**
 * Check if an initializer expression references `this.` (meaning it reads
 * another property/state and would trigger TS2729 as a class field init).
 */
function refsThis(expr: string): boolean {
  return /\bthis\./.test(expr);
}

export function emitState(state: StateIR[]): { code: string; deferred: DeferredInit[] } {
  const lines: string[] = [];
  const deferred: DeferredInit[] = [];

  for (const s of state) {
    const typeAnnotation = s.type ? `: ${s.type}` : '';
    lines.push(`  @state()`);
    if (refsThis(s.initialValue)) {
      // Defer initialization to firstUpdated to avoid TS2729
      const fallback = getTypeDefault(s.type);
      lines.push(`  private _${s.name}${typeAnnotation} = ${fallback};`);
      deferred.push({ assignment: `this._${s.name} = ${s.initialValue};` });
    } else {
      lines.push(`  private _${s.name}${typeAnnotation} = ${s.initialValue};`);
    }
    lines.push('');
  }

  return { code: lines.join('\n'), deferred };
}

/**
 * Get a safe default value for a type to use as a placeholder when deferring
 * initialization. Returns a neutral value that won't cause type errors.
 */
function getTypeDefault(type?: string): string {
  if (!type) return 'undefined as any';
  const t = type.trim().replace(/\s+/g, ' ');
  if (t === 'boolean') return 'false';
  if (t === 'number') return '0';
  if (t === 'string') return "''";
  if (t.endsWith('[]') || t.startsWith('Array<') || t.startsWith('ReadonlyArray<')) return '[]';
  return 'undefined as any';
}

// ---------------------------------------------------------------------------
// Controller emission
// ---------------------------------------------------------------------------

export function emitControllers(controllers: ControllerIR[]): { code: string; deferred: DeferredInit[] } {
  const lines: string[] = [];
  const deferred: DeferredInit[] = [];

  for (const ctrl of controllers) {
    const initExpr = `new ${ctrl.className}(this, { ${ctrl.constructorArgs} })`;
    if (refsThis(ctrl.constructorArgs)) {
      // Defer to connectedCallback to avoid TS2729
      lines.push(`  private ${ctrl.fieldName}: ${ctrl.className};`);
      deferred.push({ assignment: `this.${ctrl.fieldName} = ${initExpr};` });
    } else {
      lines.push(`  private ${ctrl.fieldName} = ${initExpr};`);
    }
    lines.push('');
  }

  return { code: lines.join('\n'), deferred };
}

// ---------------------------------------------------------------------------
// Context emission
// ---------------------------------------------------------------------------

export function emitContexts(contexts: ContextIR[]): string {
  const lines: string[] = [];

  for (const ctx of contexts) {
    if (ctx.role === 'consumer') {
      lines.push(`  @consume({ context: ${ctx.contextName}, subscribe: true })`);
      const defaultVal = ctx.defaultValue ? ` = ${ctx.defaultValue}` : '';
      lines.push(`  private ${ctx.fieldName}: ${ctx.type}${defaultVal};`);
    } else {
      lines.push(`  @provide({ context: ${ctx.contextName} })`);
      lines.push(`  ${ctx.fieldName}: ${ctx.type};`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Computed values (from useMemo → getters)
// ---------------------------------------------------------------------------

export function emitComputed(computed: ComputedIR[]): string {
  const lines: string[] = [];

  for (const c of computed) {
    const typeAnnotation = c.type ? `: ${c.type}` : '';
    let body = c.expression.trim();

    if (body.startsWith('{') && body.endsWith('}') && isBlockBody(body)) {
      // Multi-statement block body — emit as getter body directly
      lines.push(`  private get _${c.name}()${typeAnnotation} ${body}`);
    } else {
      // Expression body — object literals starting with { need parens
      // to disambiguate from a block when used after `return`.
      if (body.startsWith('{')) {
        body = `(${body})`;
      }
      lines.push(`  private get _${c.name}()${typeAnnotation} { return ${body}; }`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Distinguish a block body `{ const x = ...; return x; }` from an
 * object literal `{ key: value, ... }`.
 *
 * Heuristic: after the opening brace, skip whitespace and comments,
 * then check if the first token is a statement keyword (const, let,
 * var, return, if, for, while, switch, throw, try).  An object
 * literal starts with an identifier/string followed by a colon.
 */
function isBlockBody(text: string): boolean {
  let inner = text.slice(1).trimStart();
  // Skip leading line comments
  while (inner.startsWith('//')) {
    const nl = inner.indexOf('\n');
    if (nl === -1) return false;
    inner = inner.slice(nl + 1).trimStart();
  }
  // Skip leading block comments
  while (inner.startsWith('/*')) {
    const end = inner.indexOf('*/');
    if (end === -1) return false;
    inner = inner.slice(end + 2).trimStart();
  }
  return /^(?:const |let |var |return |if |for |while |switch |throw |try )/.test(inner);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTypeAnnotation(prop: PropIR): string {
  // For properties with known Lit types, the type annotation is often implicit
  // from the default value. But for clarity:
  switch (prop.litType) {
    case 'Boolean':
      return '';  // inferred from default
    case 'String':
      return '';  // inferred from default
    case 'Number':
      return '';  // inferred from default
    default:
      return prop.type && prop.type !== 'unknown' ? `: ${prop.type}` : '';
  }
}

// ---------------------------------------------------------------------------
// Skipped hook variable stubs
// ---------------------------------------------------------------------------

export function emitSkippedHookVars(vars: string[]): string {
  if (vars.length === 0) return '';
  const lines: string[] = [];
  for (const name of vars) {
    lines.push(`  private _${name}: any;`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Ref emission
// ---------------------------------------------------------------------------

export function emitRefs(refs: RefIR[]): string {
  const lines: string[] = [];

  for (const ref of refs) {
    if (ref.isDom) {
      const selectorId = camelToKebab(ref.name.replace(/Ref$/, ''));
      const type = ref.type || 'HTMLElement';
      lines.push(`  @query('#${selectorId}') private _${ref.name}!: ${type};`);
    } else {
      // Non-DOM refs: the identifier transform rewrites refName.current → this._refName,
      // so we declare the field as the unwrapped type (not { current: T }).
      const type = ref.type ? `: ${ref.type} | null` : '';
      lines.push(`  private _${ref.name}${type} = ${ref.initialValue};`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
