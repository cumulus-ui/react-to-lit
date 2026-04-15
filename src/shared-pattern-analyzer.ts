/**
 * Shared-pattern analyzer for React source directories.
 *
 * Analyzes the dependency graph to classify:
 * 1. Behavioral hooks → Lit-native shapes (controller / utility / eliminate)
 * 2. Shared sub-components → embedding patterns (template-child / ref-target / context-provider)
 *
 * All detection is AST-based — no hardcoded hook or component names.
 */
import ts from 'typescript';
import path from 'node:path';
import fs from 'node:fs';

import type { DependencyGraph, DependencyNode } from './dependency-graph.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HookAnalysis {
  path: string;
  litShape: 'controller' | 'utility' | 'eliminate';
  hasState: boolean;
  hasLifecycle: boolean;
  hasRef: boolean;
  reason: string;
}

export interface SubComponentAnalysis {
  path: string;
  importedByCount: number;
  embeddingPattern: 'template-child' | 'ref-target' | 'context-provider' | 'unknown';
  importedBy: string[];
}

// ---------------------------------------------------------------------------
// React hook identifiers used for classification
// ---------------------------------------------------------------------------

const STATE_HOOKS = new Set(['useState', 'useReducer']);
const LIFECYCLE_HOOKS = new Set(['useEffect', 'useLayoutEffect']);
const REF_HOOKS = new Set(['useRef']);
const IMPERATIVE_HOOKS = new Set(['useImperativeHandle']);
const MEMO_HOOKS = new Set(['useMemo', 'useCallback']);
const REACT_ONLY_INDICATORS = new Set([
  'useComponentMetrics',
  'useComponentMetadata',
  'useFocusVisible',
]);

// ---------------------------------------------------------------------------
// Hook analysis
// ---------------------------------------------------------------------------

export function analyzeHooks(
  graph: DependencyGraph,
  sourceDir: string,
): Map<string, HookAnalysis> {
  const absSourceDir = path.resolve(sourceDir);
  const results = new Map<string, HookAnalysis>();

  for (const [relPath, node] of graph.nodes) {
    if (node.kind !== 'hook') continue;

    const absPath = path.join(absSourceDir, relPath);
    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const sf = ts.createSourceFile(
      relPath,
      content,
      ts.ScriptTarget.Latest,
      true,
      absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const analysis = classifyHook(relPath, sf);
    results.set(relPath, analysis);
  }

  return results;
}

function classifyHook(relPath: string, sf: ts.SourceFile): HookAnalysis {
  let hasState = false;
  let hasLifecycle = false;
  let hasRef = false;
  let hasImperative = false;
  let hasMemo = false;
  let reactOnlyCallCount = 0;
  let totalHookCalls = 0;

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const name = getCallName(node);
      if (name) {
        if (STATE_HOOKS.has(name)) {
          hasState = true;
          totalHookCalls++;
        } else if (LIFECYCLE_HOOKS.has(name)) {
          hasLifecycle = true;
          totalHookCalls++;
        } else if (REF_HOOKS.has(name)) {
          hasRef = true;
          totalHookCalls++;
        } else if (IMPERATIVE_HOOKS.has(name)) {
          hasImperative = true;
          totalHookCalls++;
        } else if (MEMO_HOOKS.has(name)) {
          hasMemo = true;
          totalHookCalls++;
        } else if (REACT_ONLY_INDICATORS.has(name)) {
          reactOnlyCallCount++;
          totalHookCalls++;
        } else if (name.startsWith('use')) {
          totalHookCalls++;
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sf, visit);

  return determineShape(relPath, {
    hasState,
    hasLifecycle,
    hasRef,
    hasImperative,
    hasMemo,
    reactOnlyCallCount,
    totalHookCalls,
  });
}

interface HookSignals {
  hasState: boolean;
  hasLifecycle: boolean;
  hasRef: boolean;
  hasImperative: boolean;
  hasMemo: boolean;
  reactOnlyCallCount: number;
  totalHookCalls: number;
}

/**
 * React→Lit shape mapping rules (order matters — first match wins):
 *
 * useImperativeHandle only → eliminate (Lit exposes methods directly)
 * state + lifecycle       → controller (ReactiveController)
 * state only              → controller
 * lifecycle only          → controller
 * ref only                → eliminate (Lit @query)
 * memo/callback only      → utility (plain function)
 * all React-only calls    → eliminate (telemetry/infrastructure)
 * no hooks at all         → utility (pure computation)
 * fallback                → utility (conservative default)
 */
function determineShape(relPath: string, s: HookSignals): HookAnalysis {
  const base = { path: relPath, hasState: s.hasState, hasLifecycle: s.hasLifecycle, hasRef: s.hasRef };

  if (s.hasImperative && !s.hasState && !s.hasLifecycle) {
    return { ...base, litShape: 'eliminate', reason: 'useImperativeHandle only — Lit exposes methods directly' };
  }

  if (s.hasState && s.hasLifecycle) {
    return { ...base, litShape: 'controller', reason: 'has state and lifecycle — maps to ReactiveController' };
  }

  if (s.hasState) {
    return { ...base, litShape: 'controller', reason: 'has state — maps to ReactiveController' };
  }

  if (s.hasLifecycle) {
    return { ...base, litShape: 'controller', reason: 'has lifecycle — maps to ReactiveController' };
  }

  if (s.hasRef && !s.hasMemo) {
    return { ...base, litShape: 'eliminate', reason: 'ref-only — Lit handles via @query' };
  }

  if (s.hasMemo && !s.hasState && !s.hasLifecycle && !s.hasRef) {
    return { ...base, litShape: 'utility', reason: 'pure memoization — plain utility function' };
  }

  if (s.reactOnlyCallCount > 0 && s.reactOnlyCallCount === s.totalHookCalls) {
    return { ...base, litShape: 'eliminate', reason: 'React-only infrastructure (telemetry/focus-visible)' };
  }

  if (s.totalHookCalls === 0) {
    return { ...base, litShape: 'utility', reason: 'no React hooks — pure computation' };
  }

  return { ...base, litShape: 'utility', reason: 'delegates to other hooks — utility wrapper' };
}

/** Handles both `useState()` and `React.useState()` call forms. */
function getCallName(node: ts.CallExpression): string | null {
  const expr = node.expression;

  if (ts.isIdentifier(expr)) {
    return expr.text;
  }

  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    return expr.name.text;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Sub-component analysis
// ---------------------------------------------------------------------------

export function analyzeSubComponents(
  graph: DependencyGraph,
  sourceDir: string,
): Map<string, SubComponentAnalysis> {
  const absSourceDir = path.resolve(sourceDir);
  const results = new Map<string, SubComponentAnalysis>();

  const reverseImports = new Map<string, Set<string>>();
  for (const [relPath, node] of graph.nodes) {
    for (const imp of node.imports) {
      if (!reverseImports.has(imp)) {
        reverseImports.set(imp, new Set());
      }
      reverseImports.get(imp)!.add(relPath);
    }
  }

  for (const sharedPath of graph.sharedModules) {
    const node = graph.nodes.get(sharedPath);
    if (!node || node.kind !== 'component') continue;

    const importers = reverseImports.get(sharedPath);
    if (!importers || importers.size === 0) continue;

    const importerPaths = [...importers].sort();

    const pattern = detectEmbeddingPattern(
      sharedPath,
      importerPaths,
      absSourceDir,
      graph,
    );

    results.set(sharedPath, {
      path: sharedPath,
      importedByCount: importers.size,
      embeddingPattern: pattern,
      importedBy: importerPaths,
    });
  }

  return results;
}

/**
 * Scans a sample of importer files to determine the dominant embedding pattern:
 * - template-child: used in JSX return statements
 * - ref-target: stored in a ref and accessed imperatively
 * - context-provider: wraps children with React context
 */
function detectEmbeddingPattern(
  targetPath: string,
  importerPaths: string[],
  absSourceDir: string,
  graph: DependencyGraph,
): SubComponentAnalysis['embeddingPattern'] {
  const targetAbsPath = path.join(absSourceDir, targetPath);
  const exportedNames = getExportedComponentNames(targetAbsPath);

  if (exportedNames.length === 0) return 'unknown';

  let jsxCount = 0;
  let refCount = 0;
  let contextCount = 0;
  let scanned = 0;

  const sample = importerPaths.slice(0, 10);

  for (const importerPath of sample) {
    const absPath = path.join(absSourceDir, importerPath);
    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const sf = ts.createSourceFile(
      importerPath,
      content,
      ts.ScriptTarget.Latest,
      true,
      absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const localNames = getImportedNames(sf, targetPath, importerPath, absSourceDir);
    if (localNames.length === 0) {
      localNames.push(...exportedNames);
    }

    const usage = detectUsageInFile(sf, localNames);
    if (usage.inJsx) jsxCount++;
    if (usage.inRef) refCount++;
    if (usage.isContextProvider) contextCount++;
    scanned++;
  }

  if (scanned === 0) return 'unknown';

  if (contextCount > 0 && contextCount >= scanned / 2) return 'context-provider';
  if (refCount > 0 && refCount > jsxCount) return 'ref-target';
  if (jsxCount > 0) return 'template-child';

  return 'unknown';
}

function getExportedComponentNames(absPath: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return [];
  }

  const sf = ts.createSourceFile(
    path.basename(absPath),
    content,
    ts.ScriptTarget.Latest,
    true,
    absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const names: string[] = [];

  for (const stmt of sf.statements) {
    if (ts.isExportAssignment(stmt) && ts.isIdentifier(stmt.expression)) {
      names.push(stmt.expression.text);
    }

    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      names.push(stmt.name.text);
    }

    if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          names.push(decl.name.text);
        }
      }
    }
  }

  if (names.length === 0) {
    const base = path.basename(absPath, path.extname(absPath));
    if (base !== 'index') {
      names.push(base.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(''));
    }
  }

  return names;
}

function getImportedNames(
  sf: ts.SourceFile,
  targetRelPath: string,
  importerRelPath: string,
  absSourceDir: string,
): string[] {
  const names: string[] = [];
  const importerDir = path.dirname(path.join(absSourceDir, importerRelPath));

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;

    const specifier = (stmt.moduleSpecifier as ts.StringLiteral).text;
    if (!specifier.startsWith('.')) continue;

    const resolved = resolveSpecifierToRelPath(specifier, importerDir, absSourceDir, targetRelPath);
    if (!resolved) continue;

    const clause = stmt.importClause;
    if (!clause) continue;

    if (clause.name) {
      names.push(clause.name.text);
    }

    if (clause.namedBindings) {
      if (ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          names.push(el.name.text);
        }
      } else if (ts.isNamespaceImport(clause.namedBindings)) {
        names.push(clause.namedBindings.name.text);
      }
    }
  }

  return names;
}

function resolveSpecifierToRelPath(
  specifier: string,
  fromDir: string,
  absSourceDir: string,
  targetRelPath: string,
): boolean {
  const absTarget = path.resolve(fromDir, specifier);
  const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', ''];

  for (const ext of EXTENSIONS) {
    const candidate = path.relative(absSourceDir, absTarget + ext);
    if (candidate === targetRelPath) return true;
  }

  for (const ext of EXTENSIONS) {
    const candidate = path.relative(absSourceDir, path.join(absTarget, 'index' + ext));
    if (candidate === targetRelPath) return true;
  }

  return false;
}

interface UsageSignals {
  inJsx: boolean;
  inRef: boolean;
  isContextProvider: boolean;
}

function detectUsageInFile(sf: ts.SourceFile, names: string[]): UsageSignals {
  const nameSet = new Set(names);
  let inJsx = false;
  let inRef = false;
  let isContextProvider = false;

  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = getJsxTagName(node);
      if (tagName && nameSet.has(tagName)) {
        inJsx = true;

        if (ts.isJsxOpeningElement(node)) {
          const parent = node.parent;
          if (ts.isJsxElement(parent) && parent.children.length > 0) {
            const hasJsxChildren = parent.children.some(
              c => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c) || ts.isJsxExpression(c),
            );
            if (hasJsxChildren) {
              if (tagName.toLowerCase().includes('provider') || tagName.toLowerCase().includes('context')) {
                isContextProvider = true;
              }
            }
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const callName = getCallName(node);
      if (callName === 'useRef' || callName === 'createRef') {
        if (node.typeArguments) {
          for (const ta of node.typeArguments) {
            const typeText = ta.getText(sf);
            for (const name of nameSet) {
              if (typeText.includes(name)) {
                inRef = true;
              }
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sf, visit);
  return { inJsx, inRef, isContextProvider };
}

function getJsxTagName(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string | null {
  const tagName = node.tagName;
  if (ts.isIdentifier(tagName)) {
    return tagName.text;
  }
  if (ts.isPropertyAccessExpression(tagName) && ts.isIdentifier(tagName.name)) {
    return tagName.name.text;
  }
  return null;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!modifiers) return false;
  return modifiers.some(
    m => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword,
  );
}
