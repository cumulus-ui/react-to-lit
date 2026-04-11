/**
 * Property and state declaration emission.
 *
 * Produces @property() and @state() declarations from PropIR and StateIR.
 */
import { Project, ts } from 'ts-morph';
import type { PropIR, StateIR, ControllerIR, ContextIR, ComputedIR, RefIR } from '../ir/types.js';

// ---------------------------------------------------------------------------
// Native DOM properties — queried from TypeScript's DOM lib, not hardcoded.
//
// Any property that exists on HTMLElement needs `override` when redeclared
// on a LitElement subclass. We ask the compiler directly.
// ---------------------------------------------------------------------------

let _htmlElementProps: Set<string> | undefined;

function getHtmlElementProps(): Set<string> {
  if (_htmlElementProps) return _htmlElementProps;

  const project = new Project({
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      lib: ['lib.dom.d.ts', 'lib.es2022.d.ts'],
    },
  });

  const sf = project.createSourceFile('__dom.ts',
    'const __el: HTMLElement = null as any;');
  const decl = sf.getVariableDeclaration('__el')!;
  const type = project.getTypeChecker().getTypeAtLocation(decl);

  _htmlElementProps = new Set(type.getProperties().map(p => p.getName()));
  project.removeSourceFile(sf);
  return _htmlElementProps;
}

/**
 * Check if a prop needs `override` — i.e., it already exists on HTMLElement.
 * Only applies to simple types (string, boolean, number) — complex types
 * like `ariaLabels: { ... }` are component-specific, not native.
 */
function needsOverride(prop: PropIR): boolean {
  if (prop.category === 'property' && prop.attribute === false) return false;
  return getHtmlElementProps().has(prop.name);
}

// ---------------------------------------------------------------------------
// Property emission
// ---------------------------------------------------------------------------

export function emitProperties(props: PropIR[]): string {
  const lines: string[] = [];

  for (const prop of props) {
    if (prop.category === 'slot' || prop.category === 'event') continue;

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
    const defaultValue = prop.default ? ` = ${prop.default}` : '';

    lines.push(`  ${decorator}`);
    lines.push(`  ${override}${prop.name}${typeAnnotation}${defaultValue};`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// State emission
// ---------------------------------------------------------------------------

export function emitState(state: StateIR[]): string {
  const lines: string[] = [];

  for (const s of state) {
    const typeAnnotation = s.type ? `: ${s.type}` : '';
    lines.push(`  @state()`);
    lines.push(`  private _${s.name}${typeAnnotation} = ${s.initialValue};`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Controller emission
// ---------------------------------------------------------------------------

export function emitControllers(controllers: ControllerIR[]): string {
  const lines: string[] = [];

  for (const ctrl of controllers) {
    lines.push(`  private ${ctrl.fieldName} = new ${ctrl.className}(this, { ${ctrl.constructorArgs} });`);
    lines.push('');
  }

  return lines.join('\n');
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
    // If the expression is a block, extract the return value
    let body = c.expression.trim();
    if (body.startsWith('{') && body.endsWith('}')) {
      // Block body — emit as-is
      lines.push(`  private get _${c.name}()${typeAnnotation} ${body}`);
    } else {
      // Expression body
      lines.push(`  private get _${c.name}()${typeAnnotation} { return ${body}; }`);
    }
    lines.push('');
  }

  return lines.join('\n');
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
      const type = ref.type ? `: { current: ${ref.type} | null }` : '';
      lines.push(`  private _${ref.name}${type} = { current: ${ref.initialValue} };`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function camelToKebab(str: string): string {
  return str.replace(/([A-Z])/g, '-$1').toLowerCase();
}
