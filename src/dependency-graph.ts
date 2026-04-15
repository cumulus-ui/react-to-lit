/**
 * Dependency graph builder for React source directories.
 *
 * Performs static analysis on .ts/.tsx files to produce a graph showing
 * what each module imports and what kind of module it is (component,
 * hook, utility, context, type-only, unknown).
 */
import ts from 'typescript';
import path from 'node:path';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DependencyNode {
  /** Relative path from source root, e.g. 'button/internal.tsx' */
  path: string;
  /** What kind of module this is */
  kind: 'component' | 'hook' | 'utility' | 'context' | 'type-only' | 'unknown';
  /** Modules this module imports (relative paths within the source root) */
  imports: string[];
  /** Number of other modules that import this one */
  importedBy: number;
}

export interface DependencyGraph {
  nodes: Map<string, DependencyNode>;
  /** Shared modules: imported by 2+ component directories */
  sharedModules: string[];
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Build a dependency graph from a React source directory.
 *
 * Scans all .ts/.tsx files, extracts import declarations, classifies
 * each module by heuristics, and computes shared modules.
 */
export function buildDependencyGraph(sourceDir: string): DependencyGraph {
  const absSourceDir = path.resolve(sourceDir);
  const files = collectSourceFiles(absSourceDir);

  // Parse all files into SourceFile ASTs
  const parsed = new Map<string, ts.SourceFile>();
  for (const absPath of files) {
    const relPath = path.relative(absSourceDir, absPath);
    const content = fs.readFileSync(absPath, 'utf-8');
    const sf = ts.createSourceFile(
      relPath,
      content,
      ts.ScriptTarget.Latest,
      true,
      absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    parsed.set(relPath, sf);
  }

  // Build nodes: classify + extract imports
  const nodes = new Map<string, DependencyNode>();
  const importedByCount = new Map<string, Set<string>>();

  for (const [relPath, sf] of parsed) {
    const imports = extractImports(sf, relPath, absSourceDir, parsed);
    const kind = classifyModule(sf);

    nodes.set(relPath, {
      path: relPath,
      kind,
      imports,
      importedBy: 0, // computed below
    });

    // Track who imports what
    for (const imp of imports) {
      if (!importedByCount.has(imp)) {
        importedByCount.set(imp, new Set());
      }
      importedByCount.get(imp)!.add(relPath);
    }
  }

  // Fill importedBy counts
  for (const [target, importers] of importedByCount) {
    const node = nodes.get(target);
    if (node) {
      node.importedBy = importers.size;
    }
  }

  // Compute shared modules: imported by 2+ distinct component directories
  const sharedModules = computeSharedModules(nodes, importedByCount);

  return { nodes, sharedModules };
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

/** Recursively collect all .ts/.tsx files, skipping test/build dirs. */
function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  const SKIP_DIRS = new Set([
    '__tests__', '__integ__', '__mocks__', 'node_modules',
    'dist', 'build', 'test-classes', 'test-utils',
  ]);

  function walk(current: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
        // Skip test files, declaration files, and scss/css type files
        if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
        if (entry.name.endsWith('.d.ts')) continue;
        if (entry.name.includes('.css.')) continue;
        if (entry.name.endsWith('.scss')) continue;
        results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/** File extensions to try when resolving imports. */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

/**
 * Extract import targets from a source file, resolving relative paths
 * to actual files within the source directory. External (node_modules)
 * imports are excluded.
 */
function extractImports(
  sf: ts.SourceFile,
  relPath: string,
  absSourceDir: string,
  knownFiles: Map<string, ts.SourceFile>,
): string[] {
  const imports: string[] = [];
  const fileDir = path.dirname(path.join(absSourceDir, relPath));

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;

    // Skip type-only imports — they don't create runtime dependencies
    if (stmt.importClause?.isTypeOnly) continue;

    const specifier = (stmt.moduleSpecifier as ts.StringLiteral).text;

    // Only resolve relative imports within the source tree
    if (!specifier.startsWith('.')) continue;

    const resolved = resolveImport(specifier, fileDir, absSourceDir, knownFiles);
    if (resolved && resolved !== relPath) {
      imports.push(resolved);
    }
  }

  // Deduplicate
  return [...new Set(imports)];
}

/**
 * Resolve a relative import specifier to a relative file path within
 * the source root. Returns null if the target is outside the source
 * tree or can't be found.
 */
function resolveImport(
  specifier: string,
  fromDir: string,
  absSourceDir: string,
  knownFiles: Map<string, ts.SourceFile>,
): string | null {
  const absTarget = path.resolve(fromDir, specifier);

  // If outside source dir, skip
  if (!absTarget.startsWith(absSourceDir)) return null;

  // Try direct match with extensions
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = path.relative(absSourceDir, absTarget + ext);
    if (knownFiles.has(candidate)) return candidate;
  }

  // Try /index with extensions (directory import)
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = path.relative(absSourceDir, path.join(absTarget, 'index' + ext));
    if (knownFiles.has(candidate)) return candidate;
  }

  // Try exact match (already has extension)
  const exact = path.relative(absSourceDir, absTarget);
  if (knownFiles.has(exact)) return exact;

  return null;
}

// ---------------------------------------------------------------------------
// Module classification
// ---------------------------------------------------------------------------

/**
 * Classify a module by analyzing its AST.
 *
 * Priority order: context > component > hook > type-only > utility > unknown
 */
function classifyModule(sf: ts.SourceFile): DependencyNode['kind'] {
  let hasCreateContext = false;
  let hasJSXReturn = false;
  let hasForwardRef = false;
  let hasUseExport = false;
  let hasRuntimeExport = false;
  let hasTypeExport = false;
  let hasFunctionExport = false;

  function visit(node: ts.Node) {
    // Detect createContext calls
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'createContext') {
        hasCreateContext = true;
      }
      if (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.name) && callee.name.text === 'createContext') {
        hasCreateContext = true;
      }
    }

    // Detect React.forwardRef
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.name) && callee.name.text === 'forwardRef') {
        hasForwardRef = true;
      }
      if (ts.isIdentifier(callee) && callee.text === 'forwardRef') {
        hasForwardRef = true;
      }
    }

    // Detect JSX returns in functions
    if ((ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
      if (functionReturnsJSX(node, sf)) {
        hasJSXReturn = true;
      }
    }

    // Detect exported functions starting with "use"
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      const isExported = hasExportModifier(node);
      if (name.startsWith('use') && isExported) {
        hasUseExport = true;
      }
      if (isExported) {
        hasRuntimeExport = true;
        hasFunctionExport = true;
      }
    }

    // Detect `export default function useXxx`
    if (ts.isFunctionDeclaration(node) && node.name) {
      if (node.name.text.startsWith('use') && hasExportModifier(node)) {
        hasUseExport = true;
      }
    }

    // Detect exported arrow/variable functions starting with "use"
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const name = decl.name.text;
          if (name.startsWith('use')) {
            hasUseExport = true;
          }
          if (decl.initializer &&
              (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
            hasFunctionExport = true;
          }
          hasRuntimeExport = true;
        }
      }
    }

    // Track non-exported variable/function declarations for runtime vs type-only check
    if (ts.isVariableStatement(node) && !hasExportModifier(node)) {
      // Non-exported runtime code exists
      for (const decl of node.declarationList.declarations) {
        if (decl.initializer) {
          hasRuntimeExport = true; // has runtime code (even if not exported)
        }
      }
    }

    // Track type-only exports
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      if (hasExportModifier(node)) {
        hasTypeExport = true;
      }
    }

    // Track export assignments (export default)
    if (ts.isExportAssignment(node)) {
      hasRuntimeExport = true;
    }

    // Track class declarations
    if (ts.isClassDeclaration(node) && hasExportModifier(node)) {
      hasRuntimeExport = true;
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sf, visit);

  // Classification priority
  if (hasCreateContext) return 'context';
  if (hasForwardRef || hasJSXReturn) return 'component';
  if (hasUseExport) return 'hook';

  // Type-only: exports only types/interfaces, no runtime code
  if (hasTypeExport && !hasRuntimeExport && !hasFunctionExport) return 'type-only';

  // Utility: exports functions but not components/hooks/contexts
  if (hasFunctionExport || hasRuntimeExport) return 'utility';

  // Files with only type exports
  if (hasTypeExport) return 'type-only';

  return 'unknown';
}

/** Check if a function body contains JSX return statements. */
function functionReturnsJSX(
  node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
  sf: ts.SourceFile,
): boolean {
  // Arrow with expression body (concise)
  if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
    return isJSXExpression(node.body);
  }

  const body = ts.isArrowFunction(node) ? node.body : node.body;
  if (!body || !ts.isBlock(body)) return false;

  let found = false;

  function checkReturn(n: ts.Node) {
    if (found) return;
    if (ts.isReturnStatement(n) && n.expression) {
      if (isJSXExpression(n.expression)) {
        found = true;
        return;
      }
      // Check for parenthesized JSX: return ( <div> ... )
      if (ts.isParenthesizedExpression(n.expression) && isJSXExpression(n.expression.expression)) {
        found = true;
        return;
      }
    }
    // Don't recurse into nested functions
    if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return;
    ts.forEachChild(n, checkReturn);
  }

  ts.forEachChild(body, checkReturn);
  return found;
}

/** Check if a node is a JSX element or fragment. */
function isJSXExpression(node: ts.Node): boolean {
  return ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxFragment(node);
}

/** Check if a node has the `export` modifier (or `export default`). */
function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!modifiers) return false;
  return modifiers.some(
    m => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword,
  );
}

// ---------------------------------------------------------------------------
// Shared module computation
// ---------------------------------------------------------------------------

/**
 * Compute shared modules: modules imported by 2+ distinct component
 * directories. A "component directory" is the top-level directory
 * containing at least one component-classified file.
 */
function computeSharedModules(
  nodes: Map<string, DependencyNode>,
  importedByMap: Map<string, Set<string>>,
): string[] {
  const shared: string[] = [];

  for (const [target, importers] of importedByMap) {
    // Get unique component directories that import this target
    const componentDirs = new Set<string>();
    for (const importer of importers) {
      const importerNode = nodes.get(importer);
      // Only count importers from component directories
      const topDir = getTopLevelDir(importer);
      // Check if any file in this top-level dir is a component
      if (topDir && isComponentDir(topDir, nodes)) {
        componentDirs.add(topDir);
      }
    }

    if (componentDirs.size >= 2) {
      shared.push(target);
    }
  }

  return shared.sort();
}

/** Get the top-level directory from a relative path (e.g. 'button/internal.tsx' → 'button'). */
function getTopLevelDir(relPath: string): string | null {
  const parts = relPath.split(path.sep);
  if (parts.length < 2) return null;
  return parts[0];
}

/** Check if a top-level directory contains at least one component file. */
function isComponentDir(topDir: string, nodes: Map<string, DependencyNode>): boolean {
  for (const [relPath, node] of nodes) {
    if (relPath.startsWith(topDir + path.sep) && node.kind === 'component') {
      return true;
    }
  }
  return false;
}
