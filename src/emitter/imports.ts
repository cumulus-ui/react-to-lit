/**
 * Import collection and emission.
 *
 * Collects all necessary imports during emission and produces
 * a deduplicated, sorted import block.
 */
import type { ComponentIR } from '../ir/types.js';

// ---------------------------------------------------------------------------
// Import collector
// ---------------------------------------------------------------------------

export class ImportCollector {
  private _litImports = new Set<string>();
  private _decoratorImports = new Set<string>();
  private _directiveImports = new Map<string, Set<string>>(); // module → names
  private _contextImports = new Set<string>();
  private _namedImports = new Map<string, Set<string>>(); // module → names
  private _typeImports = new Map<string, Set<string>>(); // module → names
  private _sideEffectImports = new Set<string>();
  private _defaultImports = new Map<string, string>(); // module → default name

  addLit(name: string): void {
    this._litImports.add(name);
  }

  addDecorator(name: string): void {
    this._decoratorImports.add(name);
  }

  addDirective(module: string, name: string): void {
    if (!this._directiveImports.has(module)) {
      this._directiveImports.set(module, new Set());
    }
    this._directiveImports.get(module)!.add(name);
  }

  addContextImport(name: string): void {
    this._contextImports.add(name);
  }

  addNamed(module: string, name: string): void {
    if (!this._namedImports.has(module)) {
      this._namedImports.set(module, new Set());
    }
    this._namedImports.get(module)!.add(name);
  }

  addType(module: string, name: string): void {
    if (!this._typeImports.has(module)) {
      this._typeImports.set(module, new Set());
    }
    this._typeImports.get(module)!.add(name);
  }

  addSideEffect(module: string): void {
    this._sideEffectImports.add(module);
  }

  addDefault(module: string, name: string): void {
    this._defaultImports.set(module, name);
  }

  emit(): string {
    const lines: string[] = [];

    // lit core
    if (this._litImports.size > 0) {
      const names = sorted(this._litImports);
      lines.push(`import { ${names.join(', ')} } from 'lit';`);
    }

    // lit decorators
    if (this._decoratorImports.size > 0) {
      const names = sorted(this._decoratorImports);
      lines.push(`import { ${names.join(', ')} } from 'lit/decorators.js';`);
    }

    // lit directives
    for (const [module, names] of sortedEntries(this._directiveImports)) {
      lines.push(`import { ${sorted(names).join(', ')} } from '${module}';`);
    }

    // @lit/context
    if (this._contextImports.size > 0) {
      const names = sorted(this._contextImports);
      lines.push(`import { ${names.join(', ')} } from '@lit/context';`);
    }

    // Named imports (internal utilities, etc.)
    for (const [module, names] of sortedEntries(this._namedImports)) {
      lines.push(`import { ${sorted(names).join(', ')} } from '${module}';`);
    }

    // Default imports
    for (const [module, name] of sortedMapEntries(this._defaultImports)) {
      lines.push(`import ${name} from '${module}';`);
    }

    // Type-only imports
    for (const [module, names] of sortedEntries(this._typeImports)) {
      lines.push(`import type { ${sorted(names).join(', ')} } from '${module}';`);
    }

    // Side-effect imports
    for (const module of sorted(this._sideEffectImports)) {
      lines.push(`import '${module}';`);
    }

    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Pre-populate imports from IR
// ---------------------------------------------------------------------------

export function collectImports(ir: ComponentIR): ImportCollector {
  const collector = new ImportCollector();

  // Always need html from lit
  collector.addLit('html');
  collector.addLit('css');

  // Decorators
  if (ir.props.some((p) => p.category === 'attribute' || p.category === 'property')) {
    collector.addDecorator('property');
  }
  if (ir.state.length > 0) {
    collector.addDecorator('state');
  }
  if (ir.refs.some((r) => r.isDom)) {
    collector.addDecorator('query');
  }

  // nothing (for conditional rendering)
  if (hasConditionalRendering(ir.template)) {
    collector.addLit('nothing');
  }

  // svg (if template uses svg elements)
  // TODO: detect svg usage in template

  // classMap directive
  if (hasClassMap(ir.template) || hasClassMapInCodeBodies(ir)) {
    collector.addDirective('lit/directives/class-map.js', 'classMap');
  }

  // ifDefined directive
  if (hasIfDefined(ir.template) || hasIfDefinedInCodeBodies(ir)) {
    collector.addDirective('lit/directives/if-defined.js', 'ifDefined');
  }

  // Context imports
  for (const ctx of ir.contexts) {
    collector.addContextImport(ctx.role === 'consumer' ? 'consume' : 'provide');
    collector.addNamed(ctx.contextImport, ctx.contextName);
    if (ctx.defaultValue) {
      // Import the default value (e.g. defaultFormFieldContext)
      const defaultImportName = ctx.defaultValue;
      if (defaultImportName && !defaultImportName.includes('{') && !defaultImportName.includes('(')) {
        collector.addNamed(ctx.contextImport, defaultImportName);
      }
    }
    collector.addType(ctx.contextImport, ctx.type);
  }

  // Controller imports
  for (const ctrl of ir.controllers) {
    collector.addNamed(ctrl.importPath, ctrl.className);
  }

  // Base element import
  if (ir.baseClass) {
    collector.addNamed(ir.baseClass.importPath, ir.baseClass.name);
  } else {
    collector.addNamed('../internal/base-element.js', 'CsBaseElement');
  }

  // Style imports
  collector.addNamed('./styles.js', 'componentStyles');
  collector.addNamed('./styles.js', 'sharedStyles');

  // PropertyValues for willUpdate
  const hasDepEffects = ir.effects.some((e) => Array.isArray(e.deps));
  if (hasDepEffects) {
    collector.addType('lit', 'PropertyValues');
  }

  // fireNonCancelableEvent for event dispatch
  const hasEventProps = ir.props.some((p) => p.category === 'event');
  if (hasEventProps) {
    collector.addNamed('../internal/events.js', 'fireNonCancelableEvent');
  }

  // Mixin imports
  for (const mixin of ir.mixins) {
    if (mixin === 'FormControlMixin') {
      collector.addNamed('../internal/mixins/form-control.js', 'FormControlMixin');
    }
  }

  // Interface import
  const interfaceName = `${ir.name}Props`;
  collector.addType('./interfaces.js', interfaceName);

  return collector;
}

// ---------------------------------------------------------------------------
// Template analysis helpers
// ---------------------------------------------------------------------------

function hasConditionalRendering(node: import('../ir/types.js').TemplateNodeIR): boolean {
  if (node.condition) return true;
  for (const child of node.children) {
    if (hasConditionalRendering(child)) return true;
  }
  return false;
}

function hasClassMap(node: import('../ir/types.js').TemplateNodeIR): boolean {
  for (const attr of node.attributes) {
    if (attr.kind === 'classMap') return true;
  }
  for (const child of node.children) {
    if (hasClassMap(child)) return true;
  }
  return false;
}

function hasClassMapInCodeBodies(ir: ComponentIR): boolean {
  const check = (text: string) => text.includes('classMap(');
  for (const h of ir.handlers) { if (check(h.body)) return true; }
  for (const e of ir.effects) {
    if (check(e.body)) return true;
    if (e.cleanup && check(e.cleanup)) return true;
  }
  for (const h of ir.helpers) { if (check(h.source)) return true; }
  for (const s of ir.bodyPreamble) { if (check(s)) return true; }
  for (const m of ir.publicMethods) { if (check(m.body)) return true; }
  for (const c of ir.computedValues) { if (check(c.expression)) return true; }
  return false;
}

function hasIfDefined(node: import('../ir/types.js').TemplateNodeIR): boolean {
  for (const attr of node.attributes) {
    if (typeof attr.value === 'object' && attr.value.expression.includes('ifDefined(')) return true;
    if (typeof attr.value === 'string' && attr.value.includes('ifDefined(')) return true;
  }
  if (node.expression && node.expression.includes('ifDefined(')) return true;
  for (const child of node.children) {
    if (hasIfDefined(child)) return true;
  }
  return false;
}

function hasIfDefinedInCodeBodies(ir: ComponentIR): boolean {
  const check = (text: string) => text.includes('ifDefined(');
  for (const h of ir.handlers) { if (check(h.body)) return true; }
  for (const e of ir.effects) {
    if (check(e.body)) return true;
    if (e.cleanup && check(e.cleanup)) return true;
  }
  for (const h of ir.helpers) { if (check(h.source)) return true; }
  for (const s of ir.bodyPreamble) { if (check(s)) return true; }
  for (const m of ir.publicMethods) { if (check(m.body)) return true; }
  for (const c of ir.computedValues) { if (check(c.expression)) return true; }
  return false;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sorted(set: Set<string>): string[] {
  return [...set].sort();
}

function sortedEntries(map: Map<string, Set<string>>): [string, Set<string>][] {
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function sortedMapEntries(map: Map<string, string>): [string, string][] {
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
