/**
 * Hook extraction from React component function bodies.
 *
 * Walks the function body for React hook calls (useState, useEffect, useRef, etc.)
 * and custom hooks, producing the appropriate IR nodes.
 */
import ts from 'typescript';
import type {
  StateIR,
  EffectIR,
  RefIR,
  ComputedIR,
  HandlerIR,
  PublicMethodIR,
  ControllerIR,
  ContextIR,
} from '../ir/types.js';
import { getNodeText } from './program.js';
import { lookupHook, type HookRegistry } from '../hooks/registry.js';
import { SKIP_PREFIXES } from '../cloudscape-config.js';
import { collectBindingNames } from './utils.js';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface HookExtractionResult {
  state: StateIR[];
  effects: EffectIR[];
  refs: RefIR[];
  computedValues: ComputedIR[];
  handlers: HandlerIR[];
  publicMethods: PublicMethodIR[];
  controllers: ControllerIR[];
  contexts: ContextIR[];
  /** Hook calls that were skipped (for logging) */
  skipped: Array<{ name: string; reason: string }>;
  /** Hook calls that were not recognized */
  unknown: string[];
  /** Variable names from skipped/unknown hooks that must be preserved */
  preservedVars: string[];
}

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------

export function extractHooks(
  body: ts.Block | ts.Expression,
  sourceFile: ts.SourceFile,
  hookRegistry: HookRegistry,
): HookExtractionResult {
  const result: HookExtractionResult = {
    state: [],
    effects: [],
    refs: [],
    computedValues: [],
    handlers: [],
    publicMethods: [],
    controllers: [],
    contexts: [],
    skipped: [],
    unknown: [],
    preservedVars: [],
  };

  if (!ts.isBlock(body)) return result;

  for (const stmt of body.statements) {
    // Variable declarations: const [x, setX] = useState(init)
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer && ts.isCallExpression(decl.initializer)) {
          processHookCall(decl, decl.initializer, sourceFile, hookRegistry, result);
        }
      }
      continue;
    }

    // Expression statements: useEffect(() => { ... }, [deps])
    if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
      processHookCall(null, stmt.expression, sourceFile, hookRegistry, result);
      continue;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Hook call processing
// ---------------------------------------------------------------------------

function processHookCall(
  decl: ts.VariableDeclaration | null,
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  hookRegistry: HookRegistry,
  result: HookExtractionResult,
): void {
  const hookName = getHookName(call);
  if (!hookName) return;

  // Standard React hooks
  switch (hookName) {
    case 'useState':
      if (decl) processUseState(decl, call, sourceFile, result);
      return;
    case 'useEffect':
      processUseEffect(call, sourceFile, result, false);
      return;
    case 'useLayoutEffect':
      processUseEffect(call, sourceFile, result, true);
      return;
    case 'useRef':
      if (decl) processUseRef(decl, call, sourceFile, result);
      return;
    case 'useMemo':
      if (decl) processUseMemo(decl, call, sourceFile, result);
      return;
    case 'useCallback':
      if (decl) processUseCallback(decl, call, sourceFile, result);
      return;
    case 'useImperativeHandle':
      processUseImperativeHandle(call, sourceFile, result);
      return;
  }

  // Custom hooks — look up in registry
  const mapping = lookupHook(hookRegistry, hookName);
  if (mapping) {
    switch (mapping.action) {
      case 'skip':
        result.skipped.push({ name: hookName, reason: mapping.reason ?? 'configured to skip' });
        if (decl) collectPreservedVars(decl, result.preservedVars);
        return;
      case 'controller':
        if (mapping.controller && decl) {
          processControllerHook(decl, call, sourceFile, mapping.controller, result);
          // Preserve the destructured return bindings (e.g., [expanded, setExpanded])
          // so the identifier rewriter can map them to class members.
          collectPreservedVars(decl, result.preservedVars);
        } else {
          result.skipped.push({ name: hookName, reason: 'controller mapping incomplete' });
          if (decl) collectPreservedVars(decl, result.preservedVars);
        }
        return;
      case 'context':
        if (mapping.context && decl) {
          processContextHook(decl, mapping.context, result);
        } else {
          result.skipped.push({ name: hookName, reason: 'context mapping incomplete' });
          if (decl) collectPreservedVars(decl, result.preservedVars);
        }
        return;
      case 'utility':
        // Utility hooks: preserve result variables (same as skip)
        if (decl) collectPreservedVars(decl, result.preservedVars);
        return;
      case 'inline':
        return;
      default:
        result.unknown.push(hookName);
        if (decl) collectPreservedVars(decl, result.preservedVars);
        return;
    }
  }

  // Unknown hook — auto-skip and preserve result variables
  result.unknown.push(hookName);
  if (decl) collectPreservedVars(decl, result.preservedVars);
}

// ---------------------------------------------------------------------------
// Standard hook processors
// ---------------------------------------------------------------------------

function processUseState(
  decl: ts.VariableDeclaration,
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  result: HookExtractionResult,
): void {
  // const [name, setName] = useState(initialValue)
  if (!ts.isArrayBindingPattern(decl.name)) return;

  const elements = decl.name.elements;
  if (elements.length < 1) return;

  const nameElement = elements[0];
  if (!ts.isBindingElement(nameElement) || !ts.isIdentifier(nameElement.name)) return;

  // Setter is optional — const [value] = useState(0) is valid read-only state
  const setterName = elements.length >= 2
    && ts.isBindingElement(elements[1])
    && ts.isIdentifier(elements[1].name)
    ? elements[1].name.text
    : `set${nameElement.name.text.charAt(0).toUpperCase()}${nameElement.name.text.slice(1)}`;

  const initialValue = call.arguments.length > 0
    ? getNodeText(call.arguments[0], sourceFile)
    : 'undefined';

  // Extract type from generic: useState<boolean>(false) → 'boolean'
  let type: string | undefined;
  if (call.typeArguments && call.typeArguments.length > 0) {
    type = getNodeText(call.typeArguments[0], sourceFile);
  }

  result.state.push({
    name: nameElement.name.text,
    initialValue,
    setter: setterName,
    type,
  });
}

function processUseEffect(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  result: HookExtractionResult,
  isLayout: boolean,
): void {
  if (call.arguments.length < 1) return;

  const effectFn = call.arguments[0];
  if (!ts.isArrowFunction(effectFn) && !ts.isFunctionExpression(effectFn)) return;

  const body = ts.isBlock(effectFn.body)
    ? getNodeText(effectFn.body, sourceFile)
    : `{ return ${getNodeText(effectFn.body, sourceFile)}; }`;

  // Parse deps
  let deps: string[] | 'none' | 'empty';
  if (call.arguments.length < 2) {
    deps = 'none';
  } else {
    const depsArg = call.arguments[1];
    if (ts.isArrayLiteralExpression(depsArg)) {
      if (depsArg.elements.length === 0) {
        deps = 'empty';
      } else {
        deps = depsArg.elements.map((e) => getNodeText(e, sourceFile));
      }
    } else {
      deps = 'none';
    }
  }

  // Detect cleanup return
  let cleanup: string | undefined;
  if (ts.isBlock(effectFn.body)) {
    const returnStmt = Array.from(effectFn.body.statements).reverse().find(ts.isReturnStatement);
    if (returnStmt?.expression) {
      if (ts.isArrowFunction(returnStmt.expression) || ts.isFunctionExpression(returnStmt.expression)) {
        cleanup = getNodeText(returnStmt.expression.body, sourceFile);
      }
    }
  }

  result.effects.push({ body, deps, cleanup, isLayout });
}

function processUseRef(
  decl: ts.VariableDeclaration,
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  result: HookExtractionResult,
): void {
  if (!ts.isIdentifier(decl.name)) return;

  const name = decl.name.text;
  const initialValue = call.arguments.length > 0
    ? getNodeText(call.arguments[0], sourceFile)
    : 'undefined';

  // Check generic type: useRef<HTMLInputElement>(null)
  let type: string | undefined;
  let isDom = false;
  if (call.typeArguments && call.typeArguments.length > 0) {
    type = getNodeText(call.typeArguments[0], sourceFile);
    isDom = isDomElementType(type);
  } else {
    // Infer from initial value — null usually means DOM ref
    isDom = initialValue === 'null';
  }

  result.refs.push({ name, type, initialValue, isDom });
}

function processUseMemo(
  decl: ts.VariableDeclaration,
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  result: HookExtractionResult,
): void {
  if (!ts.isIdentifier(decl.name)) return;
  if (call.arguments.length < 1) return;

  const factory = call.arguments[0];
  if (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) return;

  const expression = getNodeText(factory.body, sourceFile);

  let deps: string[] = [];
  if (call.arguments.length >= 2 && ts.isArrayLiteralExpression(call.arguments[1])) {
    deps = call.arguments[1].elements.map((e) => getNodeText(e, sourceFile));
  }

  result.computedValues.push({
    name: decl.name.text,
    expression,
    deps,
  });
}

function processUseCallback(
  decl: ts.VariableDeclaration,
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  result: HookExtractionResult,
): void {
  if (!ts.isIdentifier(decl.name)) return;
  if (call.arguments.length < 1) return;

  const callback = call.arguments[0];
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return;

  const params = callback.parameters.map((p) => getNodeText(p, sourceFile)).join(', ');
  const body = ts.isBlock(callback.body)
    ? getNodeText(callback.body, sourceFile)
    : `{ return ${getNodeText(callback.body, sourceFile)}; }`;

  result.handlers.push({
    name: decl.name.text,
    params,
    body,
  });
}

function processUseImperativeHandle(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  result: HookExtractionResult,
): void {
  // useImperativeHandle(ref, () => ({ focus() { ... }, select() { ... } }), [deps])
  if (call.arguments.length < 2) return;

  const factory = call.arguments[1];
  if (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) return;

  // The factory should return an object literal
  let objectLiteral: ts.ObjectLiteralExpression | undefined;

  if (ts.isBlock(factory.body)) {
    // Look for return statement
    const returnStmt = factory.body.statements.find(ts.isReturnStatement);
    if (returnStmt?.expression && ts.isObjectLiteralExpression(returnStmt.expression)) {
      objectLiteral = returnStmt.expression;
    }
  } else if (ts.isParenthesizedExpression(factory.body)) {
    if (ts.isObjectLiteralExpression(factory.body.expression)) {
      objectLiteral = factory.body.expression;
    }
  } else if (ts.isObjectLiteralExpression(factory.body)) {
    objectLiteral = factory.body;
  }

  if (!objectLiteral) return;

  for (const prop of objectLiteral.properties) {
    if (ts.isMethodDeclaration(prop) && ts.isIdentifier(prop.name)) {
      const name = prop.name.text;
      const params = prop.parameters.map((p) => getNodeText(p, sourceFile)).join(', ');
      const body = prop.body ? getNodeText(prop.body, sourceFile) : '{}';

      result.publicMethods.push({ name, params, body });
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      // focus shorthand — just delegates
      result.publicMethods.push({
        name: prop.name.text,
        params: '',
        body: '{}',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Custom hook processors
// ---------------------------------------------------------------------------

function processControllerHook(
  decl: ts.VariableDeclaration,
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  controller: { className: string; importPath: string },
  result: HookExtractionResult,
): void {
  // const [value, setValue] = useControllable(controlledValue, handler, default)
  // → ControllerIR
  let fieldName: string;
  if (ts.isArrayBindingPattern(decl.name)) {
    // Take the first element name and prefix with _
    const first = decl.name.elements[0];
    if (ts.isBindingElement(first) && ts.isIdentifier(first.name)) {
      fieldName = `_${first.name.text}Ctrl`;
    } else {
      fieldName = '_ctrl';
    }
  } else if (ts.isIdentifier(decl.name)) {
    fieldName = `_${decl.name.text}`;
  } else {
    fieldName = '_ctrl';
  }

  // useControllable(controlledValue, handler, defaultValue, { componentName, ... })
  // → ControllableController(this, { defaultValue: defaultValue })
  // The controller only needs the defaultValue; the controlled/uncontrolled
  // distinction is handled differently in web components.
  const defaultValueArg = call.arguments.length >= 3
    ? getNodeText(call.arguments[2], sourceFile)
    : 'undefined';

  const constructorArgs = `defaultValue: ${defaultValueArg}`;

  result.controllers.push({
    className: controller.className,
    importPath: controller.importPath,
    constructorArgs,
    fieldName,
  });
}

function processContextHook(
  decl: ts.VariableDeclaration,
  contextConfig: NonNullable<import('../hooks/registry.js').HookMapping['context']>,
  result: HookExtractionResult,
): void {
  // const { ariaDescribedby, ariaLabelledby } = useFormFieldContext(rest)
  // → ContextIR (consumer)
  let fieldName: string;
  if (ts.isObjectBindingPattern(decl.name)) {
    // Use a conventional field name
    fieldName = `_${contextConfig.contextName.replace('Context', 'Ctx')}`;
  } else if (ts.isIdentifier(decl.name)) {
    fieldName = `_${decl.name.text}`;
  } else {
    fieldName = '_ctx';
  }

  result.contexts.push({
    fieldName,
    contextImport: contextConfig.contextImport,
    contextName: contextConfig.contextName,
    type: contextConfig.type,
    role: 'consumer',
    defaultValue: contextConfig.defaultValue,
  });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Extract variable names from a hook call's variable declaration and add
 * them to the preservedVars list. Handles simple identifiers, object
 * destructuring, and array destructuring patterns.
 */
function collectPreservedVars(decl: ts.VariableDeclaration, preservedVars: string[]): void {
  const names = new Set<string>();
  collectBindingNames(decl.name, names);
  // Filter out Cloudscape infrastructure variables (e.g. __internalRootRef)
  for (const name of names) {
    if (!SKIP_PREFIXES.some(prefix => name.startsWith(prefix))) {
      preservedVars.push(name);
    }
  }
}

function getHookName(call: ts.CallExpression): string | null {
  const callee = call.expression;

  // Direct call: useState(...)
  if (ts.isIdentifier(callee)) {
    const name = callee.text;
    // Must start with 'use' to be a hook
    if (name.startsWith('use')) return name;
    return null;
  }

  // Namespaced call: React.useState(...)
  if (ts.isPropertyAccessExpression(callee)) {
    if (ts.isIdentifier(callee.expression) && callee.expression.text === 'React') {
      const name = callee.name.text;
      if (name.startsWith('use')) return name;
    }
  }

  return null;
}

/**
 * Check if a type name refers to an HTML DOM element.
 */
function isDomElementType(typeName: string): boolean {
  return (
    typeName.startsWith('HTML') ||
    typeName === 'Element' ||
    typeName === 'SVGElement' ||
    typeName === 'Node'
  );
}
