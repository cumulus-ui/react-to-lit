/**
 * Controller emitter — generates Lit ReactiveController source from behavioral hooks.
 *
 * Given a HookAnalysis (from shared-pattern-analyzer) and the hook's source file,
 * produces a TypeScript class implementing ReactiveController with the correct
 * interface, property types, and lifecycle method scaffolding.
 *
 * MVP: generates a structural scaffold with correct interface and lifecycle mapping.
 * Complex body logic is deferred with TODO comments pointing to the source.
 */
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

import type { HookAnalysis } from '../shared-pattern-analyzer.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emit a Lit ReactiveController TypeScript class from a behavioral hook analysis.
 *
 * @param hookAnalysis - Classification result from shared-pattern-analyzer
 * @param hookSourcePath - Absolute or relative path to the hook source file
 * @param sourceDir - Root source directory (for resolving relative paths)
 * @returns Generated TypeScript source string
 */
export function emitController(
  hookAnalysis: HookAnalysis,
  hookSourcePath: string,
  sourceDir: string,
): string {
  const absPath = path.isAbsolute(hookSourcePath)
    ? hookSourcePath
    : path.join(path.resolve(sourceDir), hookSourcePath);

  let sourceContent: string;
  try {
    sourceContent = fs.readFileSync(absPath, 'utf-8');
  } catch {
    // If source is unreadable, emit a minimal scaffold from analysis metadata
    return emitMinimalController(hookAnalysis);
  }

  const sf = ts.createSourceFile(
    path.basename(absPath),
    sourceContent,
    ts.ScriptTarget.Latest,
    true,
    absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const hookInfo = extractHookInfo(sf);
  const className = deriveControllerName(hookAnalysis.path);

  return assembleController(className, hookInfo, hookAnalysis);
}

// ---------------------------------------------------------------------------
// Hook source analysis
// ---------------------------------------------------------------------------

interface HookParam {
  name: string;
  type: string;
}

interface HookInfo {
  /** Exported function name (e.g. 'useControllable') */
  functionName: string;
  /** Type parameters on the hook function */
  typeParams: string[];
  /** Parameters of the hook function */
  params: HookParam[];
  /** Local interfaces/types defined in the file */
  localTypes: string[];
  /** useState calls: [variableName, setterName, initializer] */
  stateVars: Array<{ name: string; setter: string; initializer: string }>;
  /** useEffect dependency arrays — used to decide lifecycle placement */
  effectDeps: Array<{ hasEmptyDeps: boolean; hasDeps: boolean; hasCleanup: boolean }>;
  /** useRef usages */
  refVars: Array<{ name: string; initializer: string }>;
  /** useCallback / useMemo usages */
  memoVars: Array<{ name: string; kind: 'callback' | 'memo' }>;
  /** Return type / structure hint */
  returnHint: string;
}

function extractHookInfo(sf: ts.SourceFile): HookInfo {
  const info: HookInfo = {
    functionName: '',
    typeParams: [],
    params: [],
    localTypes: [],
    stateVars: [],
    effectDeps: [],
    refVars: [],
    memoVars: [],
    returnHint: '',
  };

  for (const stmt of sf.statements) {
    // Collect local interfaces and type aliases
    if (ts.isInterfaceDeclaration(stmt)) {
      info.localTypes.push(stmt.getText(sf));
    }
    if (ts.isTypeAliasDeclaration(stmt)) {
      info.localTypes.push(stmt.getText(sf));
    }

    // Find exported hook function
    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      info.functionName = stmt.name.text;

      if (stmt.typeParameters) {
        info.typeParams = stmt.typeParameters.map(tp => tp.getText(sf));
      }

      info.params = stmt.parameters.map(p => ({
        name: p.name.getText(sf),
        type: p.type ? p.type.getText(sf) : 'unknown',
      }));

      if (stmt.type) {
        info.returnHint = stmt.type.getText(sf);
      }

      // Walk body for React hook calls
      if (stmt.body) {
        visitHookBody(stmt.body, sf, info);
      }
    }
  }

  return info;
}

function visitHookBody(block: ts.Block, sf: ts.SourceFile, info: HookInfo): void {
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callName = getCallName(node);

      if (callName === 'useState') {
        extractUseState(node, sf, info);
      } else if (callName === 'useEffect' || callName === 'useLayoutEffect') {
        extractUseEffect(node, info);
      } else if (callName === 'useRef') {
        extractUseRef(node, sf, info);
      } else if (callName === 'useCallback') {
        extractUseMemo(node, sf, info, 'callback');
      } else if (callName === 'useMemo') {
        extractUseMemo(node, sf, info, 'memo');
      }
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(block, visit);
}

function extractUseState(node: ts.CallExpression, sf: ts.SourceFile, info: HookInfo): void {
  const parent = node.parent;
  // Match: const [x, setX] = useState(init)  OR  React.useState(init)
  if (ts.isVariableDeclaration(parent) && ts.isArrayBindingPattern(parent.name)) {
    const elements = parent.name.elements;
    const name = elements.length > 0 && ts.isBindingElement(elements[0])
      ? elements[0].name.getText(sf) : '_state';
    const setter = elements.length > 1 && ts.isBindingElement(elements[1])
      ? elements[1].name.getText(sf) : '_setState';
    const initializer = node.arguments.length > 0
      ? node.arguments[0].getText(sf) : 'undefined';

    info.stateVars.push({ name, setter, initializer });
  }
}

function extractUseEffect(node: ts.CallExpression, info: HookInfo): void {
  const callback = node.arguments[0];
  const depsArg = node.arguments[1];

  let hasEmptyDeps = false;
  let hasDeps = false;
  let hasCleanup = false;

  if (depsArg && ts.isArrayLiteralExpression(depsArg)) {
    hasEmptyDeps = depsArg.elements.length === 0;
    hasDeps = depsArg.elements.length > 0;
  }

  if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
    const body = callback.body;
    if (ts.isBlock(body)) {
      // Check for return statement (cleanup function)
      for (const stmt of body.statements) {
        if (ts.isReturnStatement(stmt) && stmt.expression) {
          hasCleanup = true;
        }
      }
    }
  }

  info.effectDeps.push({ hasEmptyDeps, hasDeps, hasCleanup });
}

function extractUseRef(node: ts.CallExpression, sf: ts.SourceFile, info: HookInfo): void {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    const name = parent.name.text;
    const initializer = node.arguments.length > 0
      ? node.arguments[0].getText(sf) : 'null';
    info.refVars.push({ name, initializer });
  }
}

function extractUseMemo(
  node: ts.CallExpression,
  sf: ts.SourceFile,
  info: HookInfo,
  kind: 'callback' | 'memo',
): void {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    info.memoVars.push({ name: parent.name.text, kind });
  }
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

function assembleController(
  className: string,
  hookInfo: HookInfo,
  analysis: HookAnalysis,
): string {
  const sections: string[] = [];

  // --- Imports ---
  sections.push(`import { type ReactiveController, type ReactiveControllerHost } from 'lit';`);
  sections.push('');

  // --- Local types (stripped of React-specific imports) ---
  for (const typeDecl of hookInfo.localTypes) {
    sections.push(stripReactFromType(typeDecl));
    sections.push('');
  }

  // --- Options interface ---
  const optionsInterface = buildOptionsInterface(className, hookInfo);
  if (optionsInterface) {
    sections.push(optionsInterface);
    sections.push('');
  }

  // --- Type params ---
  const typeParamStr = hookInfo.typeParams.length > 0
    ? `<${hookInfo.typeParams.join(', ')}>`
    : '';

  // --- Class declaration ---
  sections.push(`export class ${className}${typeParamStr} implements ReactiveController {`);
  sections.push(`  private host: ReactiveControllerHost;`);
  sections.push('');

  // --- State properties ---
  for (const sv of hookInfo.stateVars) {
    sections.push(`  private ${sv.name} = ${cleanInitializer(sv.initializer)};`);
  }

  // --- Ref properties ---
  for (const rv of hookInfo.refVars) {
    sections.push(`  private ${rv.name} = ${cleanInitializer(rv.initializer)};`);
  }

  if (hookInfo.stateVars.length > 0 || hookInfo.refVars.length > 0) {
    sections.push('');
  }

  // --- Constructor ---
  const optionsParam = optionsInterface
    ? `, options: ${className}Options${typeParamStr}`
    : '';
  sections.push(`  constructor(host: ReactiveControllerHost${optionsParam}) {`);
  sections.push(`    this.host = host;`);
  sections.push(`    host.addController(this);`);

  if (optionsInterface) {
    sections.push(`    // TODO: initialize from options — translate from ${analysis.path}`);
  }

  sections.push(`  }`);
  sections.push('');

  // --- Lifecycle methods ---
  const hasConnected = hookInfo.effectDeps.some(e => e.hasEmptyDeps);
  const hasUpdated = hookInfo.effectDeps.some(e => e.hasDeps);
  const hasDisconnected = hookInfo.effectDeps.some(e => e.hasCleanup);

  if (hasConnected || analysis.hasLifecycle) {
    sections.push(`  hostConnected(): void {`);
    sections.push(`    // TODO: translate useEffect(fn, []) from ${analysis.path}`);
    sections.push(`  }`);
    sections.push('');
  }

  if (hasUpdated || analysis.hasLifecycle) {
    sections.push(`  hostUpdated(): void {`);
    sections.push(`    // TODO: translate useEffect(fn, [deps]) from ${analysis.path}`);
    sections.push(`  }`);
    sections.push('');
  }

  if (hasDisconnected) {
    sections.push(`  hostDisconnected(): void {`);
    sections.push(`    // TODO: translate useEffect cleanup from ${analysis.path}`);
    sections.push(`  }`);
    sections.push('');
  }

  // --- State setters (trigger host re-render) ---
  for (const sv of hookInfo.stateVars) {
    const capitalName = sv.name.charAt(0).toUpperCase() + sv.name.slice(1);
    sections.push(`  private set${capitalName}(value: typeof this.${sv.name}): void {`);
    sections.push(`    this.${sv.name} = value;`);
    sections.push(`    this.host.requestUpdate();`);
    sections.push(`  }`);
    sections.push('');
  }

  // --- Public API stub from return hint ---
  if (hookInfo.returnHint) {
    sections.push(`  // Return type: ${hookInfo.returnHint}`);
    sections.push(`  // TODO: expose public API matching the hook return value`);
    sections.push('');
  }

  // --- Close class ---
  sections.push('}');

  return sections.join('\n') + '\n';
}

function emitMinimalController(analysis: HookAnalysis): string {
  const className = deriveControllerName(analysis.path);
  const sections: string[] = [];

  sections.push(`import { type ReactiveController, type ReactiveControllerHost } from 'lit';`);
  sections.push('');
  sections.push(`/**`);
  sections.push(` * Controller scaffold for ${analysis.path}`);
  sections.push(` * Shape: ${analysis.litShape} — ${analysis.reason}`);
  sections.push(` */`);
  sections.push(`export class ${className} implements ReactiveController {`);
  sections.push(`  private host: ReactiveControllerHost;`);
  sections.push('');
  sections.push(`  constructor(host: ReactiveControllerHost) {`);
  sections.push(`    this.host = host;`);
  sections.push(`    host.addController(this);`);
  sections.push(`  }`);
  sections.push('');

  if (analysis.hasLifecycle) {
    sections.push(`  hostConnected(): void {`);
    sections.push(`    // TODO: translate lifecycle from ${analysis.path}`);
    sections.push(`  }`);
    sections.push('');
    sections.push(`  hostDisconnected(): void {`);
    sections.push(`    // TODO: translate cleanup from ${analysis.path}`);
    sections.push(`  }`);
    sections.push('');
  }

  sections.push('}');
  return sections.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a controller class name from a hook file path.
 * e.g. 'internal/hooks/use-controllable/index.ts' → 'ControllableController'
 */
export function deriveControllerName(hookPath: string): string {
  const base = path.basename(path.dirname(hookPath));
  // If parent dir is meaningful (not 'hooks' or 'src'), use it
  const dirName = base === 'hooks' || base === 'src' || base === '.'
    ? path.basename(hookPath, path.extname(hookPath))
    : base;

  // Strip 'use-' or 'use' prefix
  const stripped = dirName.replace(/^use-?/i, '');
  if (!stripped) return 'HookController';

  // kebab-case to PascalCase
  const pascal = stripped
    .split('-')
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');

  return `${pascal}Controller`;
}

function buildOptionsInterface(
  className: string,
  hookInfo: HookInfo,
): string | null {
  if (hookInfo.params.length <= 1) return null;

  const lines: string[] = [];
  const typeParamStr = hookInfo.typeParams.length > 0
    ? `<${hookInfo.typeParams.join(', ')}>`
    : '';

  lines.push(`export interface ${className}Options${typeParamStr} {`);
  for (const p of hookInfo.params) {
    // Skip the first param if it looks like a value/controlledValue arg
    lines.push(`  ${p.name}: ${cleanType(p.type)};`);
  }
  lines.push('}');
  return lines.join('\n');
}

/** Strip React.* prefixes and SyntheticEvent references from type text. */
function cleanType(typeText: string): string {
  return typeText
    .replace(/React\.\w+Event(?:<[^>]*>)?/g, 'Event')
    .replace(/React\.SetStateAction<([^>]+)>/g, '$1')
    .replace(/React\./g, '');
}

/** Clean an initializer expression — strip React.* prefixes. */
function cleanInitializer(init: string): string {
  return init
    .replace(/React\.useState\(([^)]*)\)\[0\]/g, '$1')
    .replace(/React\./g, '');
}

/** Strip React imports from a type declaration string. */
function stripReactFromType(typeDecl: string): string {
  return typeDecl
    .replace(/React\.\w+Event(?:<[^>]*>)?/g, 'Event')
    .replace(/React\./g, '');
}

function getCallName(node: ts.CallExpression): string | null {
  const expr = node.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    return expr.name.text;
  }
  return null;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!modifiers) return false;
  return modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
}
