import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { PackageAnalyzer } from './package-analyzer.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RenderManifestEntry {
  skip?: boolean;
  reason?: string;
  props: Record<string, unknown>;
  context?: {
    providerImport: string;
    providerName: string;
    mockValue: Record<string, unknown>;
  };
  portal?: boolean;
}

export type RenderManifest = Record<string, RenderManifestEntry>;

// ---------------------------------------------------------------------------
// Input shape (subset of PackageComponent)
// ---------------------------------------------------------------------------

export interface ManifestComponent {
  name: string;
  dir: string;
  propsType?: string;
  propsFile?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONTEXT_HOOK_RE = /^use\w+Context$/;

const MAIN_FILES = ['internal.tsx', 'implementation.tsx', 'index.tsx'];

function findSourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return MAIN_FILES
    .filter(name => entries.includes(name))
    .map(name => path.join(dir, name));
}

function parseFile(filePath: string): ts.SourceFile | undefined {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

// ---------------------------------------------------------------------------
// Context detection
// ---------------------------------------------------------------------------

interface ContextInfo {
  providerImport: string;
  providerName: string;
  mockValue: Record<string, unknown>;
}

/**
 * Scan imports for `useXxxContext` hooks → follow import → check if hook
 * throws on null → locate Provider export in the same file.
 */
function detectContext(
  sf: ts.SourceFile,
  _componentDir: string,
  sourceRoot: string,
): ContextInfo | undefined {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!stmt.importClause?.namedBindings) continue;
    if (!ts.isNamedImports(stmt.importClause.namedBindings)) continue;
    if (!stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;

    const importPath = stmt.moduleSpecifier.text;

    for (const el of stmt.importClause.namedBindings.elements) {
      const name = el.name.text;
      if (!CONTEXT_HOOK_RE.test(name)) continue;

      const sourceDir = path.dirname(sf.fileName);
      const contextFilePath = path.resolve(sourceDir, importPath);
      const resolved = resolveContextFile(contextFilePath);
      if (!resolved) continue;

      const contextSf = parseFile(resolved);
      if (!contextSf) continue;

      if (!hookThrowsOnNull(contextSf, name)) continue;

      const providerName = findProviderExport(contextSf);
      if (!providerName) continue;

      const providerImport = path.relative(sourceRoot, resolved).replace(/\.tsx?$/, '');
      return { providerImport, providerName, mockValue: {} };
    }
  }
  return undefined;
}

function resolveContextFile(basePath: string): string | undefined {
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const candidate = basePath + ext;
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function hookThrowsOnNull(sf: ts.SourceFile, hookName: string): boolean {
  let found = false;
  function visit(node: ts.Node) {
    if (found) return;
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === hookName &&
      node.body
    ) {
      if (bodyContainsThrow(node.body)) found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sf, visit);
  return found;
}

function bodyContainsThrow(block: ts.Block): boolean {
  let hasThrow = false;
  function visit(node: ts.Node) {
    if (hasThrow) return;
    if (ts.isThrowStatement(node)) {
      hasThrow = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(block, visit);
  return hasThrow;
}

function findProviderExport(sf: ts.SourceFile): string | undefined {
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text.includes('Provider')) {
          return decl.name.text;
        }
      }
    }
    if (
      ts.isFunctionDeclaration(stmt) &&
      hasExportModifier(stmt) &&
      stmt.name?.text.includes('Provider')
    ) {
      return stmt.name.text;
    }
  }
  return undefined;
}

function hasExportModifier(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

// ---------------------------------------------------------------------------
// Portal detection
// ---------------------------------------------------------------------------

function detectPortal(sf: ts.SourceFile): boolean {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!stmt.importClause) continue;

    if (stmt.importClause.name?.text === 'Portal') return true;

    if (
      stmt.importClause.namedBindings &&
      ts.isNamedImports(stmt.importClause.namedBindings)
    ) {
      for (const el of stmt.importClause.namedBindings.elements) {
        const n = el.name.text;
        if (n === 'Portal' || n === 'createPortal') return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Provider-only detection
// ---------------------------------------------------------------------------

/**
 * Heuristic: a component is provider-only if it has no style imports AND
 * every JSX tag is uppercase (React component) or fragment — no HTML elements.
 */
function detectProviderOnly(sf: ts.SourceFile): boolean {
  if (hasStyleImport(sf)) return false;

  const tags = collectJsxTagNames(sf);
  if (tags.length === 0) return false;

  for (const tag of tags) {
    if (tag === '' || tag === 'Fragment' || tag === 'React.Fragment') continue;
    // Property access like `ctx.Provider` — always a component reference
    if (tag.includes('.')) continue;
    if (tag[0] === tag[0].toLowerCase()) return false;
  }
  return true;
}

function hasStyleImport(sf: ts.SourceFile): boolean {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    if (spec.includes('styles.css') || spec.endsWith('.scss')) return true;
  }
  return false;
}

function collectJsxTagNames(sf: ts.SourceFile): string[] {
  const names: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      names.push(node.tagName.getText(sf));
    }
    if (ts.isJsxFragment(node)) {
      names.push('');
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sf, visit);
  return names;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function buildRenderManifest(
  components: ManifestComponent[],
  analyzer: PackageAnalyzer,
  sourceRoot: string,
): RenderManifest {
  const manifest: RenderManifest = {};

  for (const comp of components) {
    const entry: RenderManifestEntry = { props: {} };

    if (comp.propsType && comp.propsFile) {
      const propsType = analyzer.getPropsType(comp.propsType, comp.propsFile);
      if (propsType) {
        entry.props = analyzer.generateDummyProps(propsType);
      }
    }

    const compDir = path.resolve(sourceRoot, comp.dir);
    const sourceFiles = findSourceFiles(compDir);
    if (sourceFiles.length === 0) {
      manifest[comp.name] = entry;
      continue;
    }

    let providerOnlyChecked = false;
    for (const filePath of sourceFiles) {
      const sf = parseFile(filePath);
      if (!sf) continue;

      if (!entry.context) {
        const ctx = detectContext(sf, compDir, sourceRoot);
        if (ctx) entry.context = ctx;
      }

      if (!entry.portal && detectPortal(sf)) entry.portal = true;

      if (!providerOnlyChecked && detectProviderOnly(sf)) {
        entry.skip = true;
        entry.reason = 'provider-only';
        providerOnlyChecked = true;
      }
    }

    manifest[comp.name] = entry;
  }

  return manifest;
}
