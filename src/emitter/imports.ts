/**
 * Import collection and emission.
 *
 * Collects all necessary imports during emission and produces
 * a deduplicated, sorted import block.
 */
import type { ComponentIR } from '../ir/types.js';
import type { OutputConfig } from '../config.js';
import { someInTemplate } from '../template-walker.js';
import { collectIRText } from '../ir/transform-helpers.js';
import { Project, SyntaxKind, Node, ts } from 'ts-morph';

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
  private _preservedNames = new Set<string>();
  private _importExtension: string;

  constructor(importExtension: string = '') {
    this._importExtension = importExtension;
  }

  /**
   * Normalize module specifiers so that `'./interfaces'` and `'./interfaces.js'`
   * resolve to the same dedup key. Relative imports are stored without any file
   * extension (stripped if present). The configured `importExtension` is applied
   * at emit time. Non-relative (bare) and `.css` imports are untouched.
   */
  private _normalizeModule(module: string): string {
    if (module.startsWith('.') && !module.endsWith('.css')) {
      return module.replace(/\.js$/, '');
    }
    return module;
  }

  /**
   * Apply the configured import extension to a module specifier for emission.
   * Only relative, non-.css modules get the extension appended.
   */
  private _emitModule(module: string): string {
    if (module.startsWith('.') && !module.endsWith('.css')) {
      return module + this._importExtension;
    }
    return module;
  }

  /** Add a name to a Map<string, Set<string>>, creating the Set on first use. */
  private _addToMap(map: Map<string, Set<string>>, key: string, name: string): void {
    let set = map.get(key);
    if (!set) { set = new Set(); map.set(key, set); }
    set.add(name);
  }

  addLit(name: string): void {
    this._litImports.add(name);
  }

  addDecorator(name: string): void {
    this._decoratorImports.add(name);
  }

  addDirective(module: string, name: string): void {
    this._addToMap(this._directiveImports, this._normalizeModule(module), name);
  }

  addContextImport(name: string): void {
    this._contextImports.add(name);
  }

  addNamed(module: string, name: string): void {
    this._addToMap(this._namedImports, this._normalizeModule(module), name);
  }

  addType(module: string, name: string): void {
    this._addToMap(this._typeImports, this._normalizeModule(module), name);
  }

  addSideEffect(module: string): void {
    this._sideEffectImports.add(this._normalizeModule(module));
  }

  addDefault(module: string, name: string): void {
    this._defaultImports.set(this._normalizeModule(module), name);
  }

  markPreserved(name: string): void {
    this._preservedNames.add(name);
  }

  /**
   * Remove named/default/lit/directive imports whose identifiers don't appear
   * in the emitted body string.  Decorators, context, type-only, side-effect,
   * and preserve-flagged imports are never touched.
   */
  filterUnused(bodyString: string): void {
    // Named imports
    for (const [module, names] of this._namedImports) {
      for (const name of names) {
        if (this._preservedNames.has(name)) continue;
        if (!new RegExp('\\b' + name + '\\b').test(bodyString)) {
          names.delete(name);
        }
      }
      if (names.size === 0) {
        this._namedImports.delete(module);
      }
    }

    // Default imports
    for (const [module, name] of this._defaultImports) {
      if (this._preservedNames.has(name)) continue;
      if (!new RegExp('\\b' + name + '\\b').test(bodyString)) {
        this._defaultImports.delete(module);
      }
    }

    // Lit core imports (html, css, nothing, LitElement, etc.)
    for (const name of this._litImports) {
      if (!new RegExp('\\b' + name + '\\b').test(bodyString)) {
        this._litImports.delete(name);
      }
    }

    // Directive imports (classMap, ifDefined, etc.)
    for (const [module, names] of this._directiveImports) {
      for (const name of names) {
        if (!new RegExp('\\b' + name + '\\b').test(bodyString)) {
          names.delete(name);
        }
      }
      if (names.size === 0) {
        this._directiveImports.delete(module);
      }
    }
  }

  /**
   * Promote named imports to type-only when the identifier has no runtime
   * usage in the body — only appears in type annotations, not as a value.
   *
   * Uses ts-morph to parse the body and TypeScript's `ts.isPartOfTypeNode()`
   * to check each identifier occurrence. Zero false positives.
   */
  promoteToTypeImports(bodyString: string): void {
    const namesToCheck = new Map<string, string>(); // name → module
    for (const [module, names] of this._namedImports) {
      for (const name of names) {
        if (this._preservedNames.has(name)) continue;
        namesToCheck.set(name, module);
      }
    }
    if (namesToCheck.size === 0) return;

    // Synthetic declarations so the body parses without unresolved identifiers
    const declarations = [...namesToCheck.keys()]
      .map(n => `declare const ${n}: any;`)
      .join('\n');
    const syntheticSource = `${declarations}\n${bodyString}`;

    const project = _getSharedProject();
    const fileName = `__promote_check_${_fileCounter++}.ts`;
    const sourceFile = project.createSourceFile(fileName, syntheticSource);

    try {
      const declLength = declarations.length + 1; // offset past synthetic declarations

      for (const [name, module] of namesToCheck) {
        let allTypeOnly = true;
        let hasUsage = false;

        sourceFile.forEachDescendant((node) => {
          if (!allTypeOnly) return;
          if (!Node.isIdentifier(node)) return;
          if (node.getText() !== name) return;
          if (node.getStart() < declLength) return;
          if (node.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)) return;

          hasUsage = true;

          // ts.isPartOfTypeNode: walks up the AST, returns true if inside a type annotation
          if (!ts.isPartOfTypeNode(node.compilerNode)) {
            allTypeOnly = false;
          }
        });

        if (hasUsage && allTypeOnly) {
          const names = this._namedImports.get(module);
          if (names) {
            names.delete(name);
            this._addToMap(this._typeImports, module, name);
            if (names.size === 0) this._namedImports.delete(module);
          }
        }
      }
    } finally {
      project.removeSourceFile(sourceFile);
    }
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
      lines.push(`import { ${sorted(names).join(', ')} } from '${this._emitModule(module)}';`);
    }

    // @lit/context
    if (this._contextImports.size > 0) {
      const names = sorted(this._contextImports);
      lines.push(`import { ${names.join(', ')} } from '@lit/context';`);
    }

    // Named imports (internal utilities, etc.)
    for (const [module, names] of sortedEntries(this._namedImports)) {
      lines.push(`import { ${sorted(names).join(', ')} } from '${this._emitModule(module)}';`);
    }

    // Default imports
    for (const [module, name] of sortedMapEntries(this._defaultImports)) {
      lines.push(`import ${name} from '${this._emitModule(module)}';`);
    }

    // Type-only imports — skip names already covered by named imports from the same module
    for (const [module, names] of sortedEntries(this._typeImports)) {
      const namedFromSame = this._namedImports.get(module);
      const filteredNames = namedFromSame
        ? sorted(names).filter(n => !namedFromSame.has(n))
        : sorted(names);
      if (filteredNames.length > 0) {
        lines.push(`import type { ${filteredNames.join(', ')} } from '${this._emitModule(module)}';`);
      }
    }

    // Side-effect imports
    for (const module of sorted(this._sideEffectImports)) {
      lines.push(`import '${this._emitModule(module)}';`);
    }

    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Pre-populate imports from IR
// ---------------------------------------------------------------------------

export function collectImports(ir: ComponentIR, outputConfig?: OutputConfig): ImportCollector {
  const collector = new ImportCollector(outputConfig?.importExtension ?? '');

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

  // Collect all IR text for reference-checking (used below for imports,
  // directives, and any name-based decisions).
  const allCode = collectIRText(ir);

  // nothing (for conditional rendering or other Lit patterns)
  if (hasConditionalRendering(ir.template)) {
    collector.addLit('nothing');
  }

  // classMap directive
  if (allCode.includes('classMap(')) {
    collector.addDirective('lit/directives/class-map.js', 'classMap');
  }

  // ifDefined directive
  if (allCode.includes('ifDefined(')) {
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
    const baseName = outputConfig?.baseClass?.name ?? 'LitElement';
    const baseImport = outputConfig?.baseClass?.import ?? 'lit';
    collector.addNamed(baseImport, baseName);
  }

  // Style imports
  collector.addNamed('./styles.js', 'componentStyles');
  collector.addNamed('./styles.js', 'sharedStyles');

  // PropertyValues for willUpdate
  const hasDepEffects = ir.effects.some((e) => Array.isArray(e.deps));
  if (hasDepEffects) {
    collector.addType('lit', 'PropertyValues');
  }

  // fireNonCancelableEvent for event dispatch — only if not already imported from source.
  // Check specifically for fireNonCancelableEvent, not just any events import,
  // because the source may only import fireCancelableEvent.
  const hasEventProps = ir.props.some((p) => p.category === 'event');
  const fireNonCancelableAlreadyImported = ir.imports.some(imp =>
    imp.namedImports?.includes('fireNonCancelableEvent'),
  );
  if (hasEventProps && !fireNonCancelableAlreadyImported) {
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

  // Also import 'nothing' if used anywhere in the output (not just templates)
  if (/\bnothing\b/.test(allCode)) {
    collector.addLit('nothing');
  }

  for (const imp of ir.imports) {
    if (imp.isSideEffect) {
      collector.addSideEffect(imp.moduleSpecifier);
      continue;
    }
    if (imp.isTypeOnly && imp.namedImports) {
      for (const name of imp.namedImports) {
        if (allCode.includes(name)) collector.addType(imp.moduleSpecifier, name);
      }
      continue;
    }
    // Process default and named imports independently — an import
    // statement can have both (import Foo, { bar } from '...').
    if (imp.defaultImport) {
      if (imp.preserve || allCode.includes(imp.defaultImport)) {
        collector.addDefault(imp.moduleSpecifier, imp.defaultImport);
        if (imp.preserve) collector.markPreserved(imp.defaultImport);
      }
    }
    if (imp.namedImports) {
      for (const name of imp.namedImports) {
        if (imp.preserve || allCode.includes(name)) {
          if (imp.moduleSpecifier.includes('/interfaces')) {
            collector.addType(imp.moduleSpecifier, name);
          } else {
            collector.addNamed(imp.moduleSpecifier, name);
          }
          if (imp.preserve) collector.markPreserved(name);
        }
      }
    }
  }

  return collector;
}

// ---------------------------------------------------------------------------
// Template analysis helpers
// ---------------------------------------------------------------------------

function hasConditionalRendering(node: import('../ir/types.js').TemplateNodeIR): boolean {
  return someInTemplate(node, (n) => !!n.condition);
}

// ---------------------------------------------------------------------------
// Shared ts-morph project for promoteToTypeImports (reused across calls)
// ---------------------------------------------------------------------------

let _sharedProject: InstanceType<typeof Project> | undefined;
let _fileCounter = 0;

function _getSharedProject(): InstanceType<typeof Project> {
  if (!_sharedProject) {
    _sharedProject = new Project({ useInMemoryFileSystem: true });
  }
  return _sharedProject;
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
