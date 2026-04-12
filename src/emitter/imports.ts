/**
 * Import collection and emission.
 *
 * Collects all necessary imports during emission and produces
 * a deduplicated, sorted import block.
 */
import type { ComponentIR } from '../ir/types.js';
import { someInTemplate } from '../template-walker.js';

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

    // Type-only imports — skip names already covered by named imports from the same module
    for (const [module, names] of sortedEntries(this._typeImports)) {
      // Find the normalized module key for named imports (./interfaces vs ./interfaces.js)
      const namedFromSame = this._namedImports.get(module)
        ?? this._namedImports.get(module.replace(/\.js$/, ''))
        ?? this._namedImports.get(module + '.js');
      const filteredNames = namedFromSame
        ? sorted(names).filter(n => !namedFromSame.has(n))
        : sorted(names);
      if (filteredNames.length > 0) {
        lines.push(`import type { ${filteredNames.join(', ')} } from '${module}';`);
      }
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

  // nothing (for conditional rendering or other Lit patterns)
  if (hasConditionalRendering(ir.template)) {
    collector.addLit('nothing');
  }

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

  // fireNonCancelableEvent for event dispatch — only if not already imported from source
  const hasEventProps = ir.props.some((p) => p.category === 'event');
  const eventsAlreadyImported = ir.imports.some(imp =>
    imp.moduleSpecifier.includes('events') &&
    imp.namedImports?.includes('fireNonCancelableEvent'),
  );
  if (hasEventProps && !eventsAlreadyImported) {
    collector.addNamed('../internal/events.js', 'fireNonCancelableEvent');
  }

  // Mixin imports
  for (const mixin of ir.mixins) {
    if (mixin === 'FormControlMixin') {
      collector.addNamed('../internal/mixins/form-control.js', 'FormControlMixin');
    }
  }

  // Interface import — always add as type import.
  // The ImportCollector deduplicates, so if the preserved source import
  // also provides it via addNamed(), the type version is harmless.
  const interfaceName = `${ir.name}Props`;
  collector.addType('./interfaces.js', interfaceName);

  // Transform-added imports (from ir.imports) — only emit if identifiers are used
  const allCode = [
    ...ir.handlers.map(h => h.body + (h.params ?? '')),
    ...ir.effects.map(e => e.body + (e.cleanup ?? '')),
    ...ir.helpers.map(h => h.source),
    ...ir.bodyPreamble,
    ...ir.computedValues.map(c => c.expression),
    ...ir.publicMethods.map(m => m.body),
    ...ir.state.map(s => s.initialValue),
    ...ir.refs.map(r => r.initialValue),
    templateToText(ir.template),
  ].join('\n');

  // Also import 'nothing' if used anywhere in the output (not just templates)
  if (/\bnothing\b/.test(allCode)) {
    collector.addLit('nothing');
  }

  for (const imp of ir.imports) {
    if (imp.isSideEffect) {
      collector.addSideEffect(imp.moduleSpecifier);
    } else if (imp.isTypeOnly && imp.namedImports) {
      for (const name of imp.namedImports) {
        if (allCode.includes(name)) collector.addType(imp.moduleSpecifier, name);
      }
    } else if (imp.defaultImport) {
      if (allCode.includes(imp.defaultImport)) collector.addDefault(imp.moduleSpecifier, imp.defaultImport);
    } else if (imp.namedImports) {
      for (const name of imp.namedImports) {
        if (allCode.includes(name)) collector.addNamed(imp.moduleSpecifier, name);
      }
    }
  }

  return collector;
}

/** Flatten a template tree into text for identifier scanning. */
function templateToText(node: import('../ir/types.js').TemplateNodeIR): string {
  const parts: string[] = [];
  if (node.expression) parts.push(node.expression);
  for (const attr of node.attributes) {
    if (attr.value) {
      parts.push(typeof attr.value === 'string' ? attr.value : attr.value.expression);
    }
  }
  if (node.condition) {
    parts.push(node.condition.expression);
    if (node.condition.alternate) parts.push(templateToText(node.condition.alternate));
  }
  if (node.loop) {
    parts.push(node.loop.iterable);
    if (node.loop.variable) parts.push(node.loop.variable);
  }
  for (const child of node.children) {
    parts.push(templateToText(child));
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Template analysis helpers
// ---------------------------------------------------------------------------

function hasConditionalRendering(node: import('../ir/types.js').TemplateNodeIR): boolean {
  return someInTemplate(node, (n) => !!n.condition);
}

function hasClassMap(node: import('../ir/types.js').TemplateNodeIR): boolean {
  return someInTemplate(node, (n) => {
    for (const attr of n.attributes) {
      if (attr.kind === 'classMap') return true;
      // Also check expression text for classMap() calls (from clsx transform)
      if (typeof attr.value === 'object' && attr.value.expression.includes('classMap(')) return true;
    }
    // Check node expression text
    if (n.expression?.includes('classMap(')) return true;
    return false;
  });
}

function hasIfDefined(node: import('../ir/types.js').TemplateNodeIR): boolean {
  return someInTemplate(node, (n) => {
    for (const attr of n.attributes) {
      if (typeof attr.value === 'object' && attr.value.expression.includes('ifDefined(')) return true;
      if (typeof attr.value === 'string' && attr.value.includes('ifDefined(')) return true;
    }
    if (n.expression && n.expression.includes('ifDefined(')) return true;
    return false;
  });
}

function hasClassMapInCodeBodies(ir: ComponentIR): boolean {
  return codeBodyContains(ir, 'classMap(');
}

function hasIfDefinedInCodeBodies(ir: ComponentIR): boolean {
  return codeBodyContains(ir, 'ifDefined(');
}

/** Check if any IR code body (handlers, effects, helpers, etc.) contains the given text. */
function codeBodyContains(ir: ComponentIR, needle: string): boolean {
  for (const h of ir.handlers) { if (h.body.includes(needle)) return true; }
  for (const e of ir.effects) {
    if (e.body.includes(needle)) return true;
    if (e.cleanup?.includes(needle)) return true;
  }
  for (const h of ir.helpers) { if (h.source.includes(needle)) return true; }
  for (const s of ir.bodyPreamble) { if (s.includes(needle)) return true; }
  for (const m of ir.publicMethods) { if (m.body.includes(needle)) return true; }
  for (const c of ir.computedValues) { if (c.expression.includes(needle)) return true; }
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
