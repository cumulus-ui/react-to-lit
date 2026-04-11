/**
 * Props extraction from React component interfaces.
 *
 * Reads the props type (from the function signature or interfaces.ts),
 * classifies each prop, and produces PropIR entries.
 */
import ts from 'typescript';
import path from 'node:path';
import fs from 'node:fs';
import type { PropIR } from '../ir/types.js';
import { getNodeText, parseFile } from './program.js';
import type { RawComponent } from './component.js';
import { SKIP_PROPS, SKIP_PREFIXES } from '../cloudscape-config.js';

// ---------------------------------------------------------------------------
// Event handler type names
// ---------------------------------------------------------------------------

const NON_CANCELABLE_EVENT_TYPES = new Set([
  'NonCancelableEventHandler',
]);

const CANCELABLE_EVENT_TYPES = new Set([
  'CancelableEventHandler',
]);

// ---------------------------------------------------------------------------
// React types that indicate a slot
// ---------------------------------------------------------------------------

const SLOT_TYPE_NAMES = new Set([
  'ReactNode',
  'ReactElement',
]);

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------

/**
 * Extract props from the component's props interface/type.
 *
 * Strategy:
 * 1. Build type map from published .d.ts (authoritative, complete) or vendor interfaces.ts
 * 2. Get destructured defaults from React source (for default values only)
 * 3. Emit ALL props from the type map, merging defaults where available
 *
 * This ensures we get complete prop coverage even when the React component
 * doesn't destructure all props in its function signature.
 */
export function extractProps(
  component: RawComponent,
  sourceFile: ts.SourceFile,
  componentDir?: string,
  declarationsDir?: string,
  componentName?: string,
): PropIR[] {
  // Build type map — prefer published .d.ts, fall back to vendor interfaces.ts
  let interfaceTypeMap = new Map<string, string>();
  if (declarationsDir && componentName) {
    const dtsMap = buildDtsTypeMap(declarationsDir, componentName);
    if (dtsMap.size > 0) {
      interfaceTypeMap = dtsMap;
    }
  }
  if (interfaceTypeMap.size === 0 && componentDir) {
    interfaceTypeMap = buildInterfaceTypeMap(componentDir);
  }

  // Get destructured prop names and defaults from the function parameters
  const destructuredProps = getDestructuredProps(component.parameters, sourceFile, interfaceTypeMap);

  // Merge defaults (index defaults take priority as they're the public API)
  const mergedDefaults = new Map([
    ...component.defaultsFromInternal,
    ...component.defaultsFromIndex,
  ]);
  // Also include destructured defaults
  for (const [name, info] of destructuredProps) {
    if (info.default && !mergedDefaults.has(name)) {
      mergedDefaults.set(name, info.default);
    }
  }

  // Emit props from the FULL type map (not just destructured ones)
  const props: PropIR[] = [];
  const seen = new Set<string>();

  if (interfaceTypeMap.size > 0) {
    // Primary: emit all props from the type map
    for (const [propName, typeText] of interfaceTypeMap) {
      if (shouldSkipProp(propName)) continue;
      if (seen.has(propName)) continue;
      seen.add(propName);

      const defaultValue = mergedDefaults.get(propName);
      props.push(classifyProp(propName, typeText, defaultValue));
    }
  } else {
    // Fallback: emit only destructured props (old behavior)
    for (const [propName, propInfo] of destructuredProps) {
      if (shouldSkipProp(propName)) continue;
      if (seen.has(propName)) continue;
      seen.add(propName);

      const defaultValue = mergedDefaults.get(propName) ?? propInfo.default;
      props.push(classifyProp(propName, propInfo.typeText, defaultValue));
    }
  }

  return props;
}

// ---------------------------------------------------------------------------
// Destructured props analysis
// ---------------------------------------------------------------------------

interface PropInfo {
  typeText: string;
  default?: string;
}

function getDestructuredProps(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  sourceFile: ts.SourceFile,
  interfaceTypeMap: Map<string, string>,
): Map<string, PropInfo> {
  const result = new Map<string, PropInfo>();
  if (parameters.length === 0) return result;

  const firstParam = parameters[0];

  // Handle: function Foo({ color = 'grey', ...rest }: BadgeProps)
  if (ts.isObjectBindingPattern(firstParam.name)) {
    for (const element of firstParam.name.elements) {
      if (element.dotDotDotToken) continue; // Skip ...rest

      const name = ts.isIdentifier(element.name) ? element.name.text : '';
      if (!name) continue;

      // Get the property name (handles renamed destructuring like { prop: alias })
      const propName = element.propertyName
        ? ts.isIdentifier(element.propertyName) ? element.propertyName.text : name
        : name;

      const defaultValue = element.initializer
        ? getNodeText(element.initializer, sourceFile)
        : undefined;

      const typeText = interfaceTypeMap.get(propName) ?? 'unknown';

      result.set(propName, { typeText, default: defaultValue });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Prop classification
// ---------------------------------------------------------------------------

function classifyProp(
  name: string,
  typeText: string,
  defaultValue?: string,
): PropIR {
  // Event handlers: onChange, onFollow, onBlur, etc.
  if (isEventProp(name)) {
    return {
      name,
      type: typeText,
      default: defaultValue,
      category: 'event',
      eventDetail: extractEventDetailType(typeText),
      eventCancelable: isCancelableEventType(typeText),
    };
  }

  // Slot props: children, description (when typed as ReactNode)
  if (isSlotProp(name, typeText)) {
    return {
      name,
      type: typeText,
      default: defaultValue,
      category: 'slot',
    };
  }

  const typeInference = inferFromTypeString(typeText);

  // Boolean props
  if (typeInference?.litType === 'Boolean' || isBooleanProp(name, typeText, defaultValue)) {
    return {
      name,
      type: typeText !== 'unknown' ? typeText : 'boolean',
      default: defaultValue,
      category: 'attribute',
      attribute: toKebabCase(name),
      litType: 'Boolean',
    };
  }

  // Array/object props (from type inference, default values, or known names)
  if (typeInference?.litType === 'Array' || isArrayProp(name, defaultValue)) {
    return {
      name,
      type: typeText,
      default: defaultValue,
      category: 'property',
      attribute: false,
      litType: 'Array',
    };
  }

  if (isObjectProp(name, defaultValue)) {
    return {
      name,
      type: typeText,
      default: defaultValue,
      category: 'property',
      attribute: false,
      litType: 'Object',
    };
  }

  // Number props (from type or default values)
  if (typeInference?.litType === 'Number' || isNumberProp(defaultValue)) {
    return {
      name,
      type: typeText !== 'unknown' ? typeText : 'number',
      default: defaultValue,
      category: 'attribute',
      attribute: needsExplicitAttribute(name) ? toKebabCase(name) : undefined,
      litType: 'Number',
    };
  }

  // String/enum props (most common case)
  return {
    name,
    type: typeText,
    default: defaultValue,
    category: 'attribute',
    attribute: needsExplicitAttribute(name) ? toKebabCase(name) : undefined,
    litType: 'String',
  };
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

function isEventProp(name: string): boolean {
  return /^on[A-Z]/.test(name);
}

function isSlotProp(name: string, typeText: string): boolean {
  if (name === 'children') return true;
  if (typeText.includes('ReactNode') || typeText.includes('ReactElement')) return true;
  return false;
}

function isBooleanProp(_name: string, _typeText: string, defaultValue?: string): boolean {
  // Infer from default value only — type inference handles the rest
  return defaultValue === 'false' || defaultValue === 'true';
}

// ---------------------------------------------------------------------------
// Known array/object prop names (Cloudscape-specific but safe defaults)
// ---------------------------------------------------------------------------

function isArrayProp(_name: string, defaultValue?: string): boolean {
  // Detect from default value: [] or [...]
  if (defaultValue === '[]' || (defaultValue && defaultValue.startsWith('['))) return true;
  return false;
}

function isObjectProp(_name: string, defaultValue?: string): boolean {
  // Detect from default value: {} or {...}
  if (defaultValue === '{}' || (defaultValue && defaultValue.startsWith('{'))) return true;
  return false;
}

function isNumberProp(defaultValue?: string): boolean {
  if (!defaultValue) return false;
  // Match numeric literals: 0, 1, 100, -1, 3.14, etc.
  return /^-?\d+(\.\d+)?$/.test(defaultValue);
}

function isCancelableEventType(typeText: string): boolean {
  return typeText.includes('CancelableEventHandler')
    && !typeText.includes('NonCancelableEventHandler');
}

function extractEventDetailType(typeText: string): string | undefined {
  // NonCancelableEventHandler<AlertProps.ChangeDetail> → AlertProps.ChangeDetail
  // CancelableEventHandler<BaseKeyDetail> → BaseKeyDetail
  const match = typeText.match(/(?:Non)?CancelableEventHandler<(.+?)>/);
  return match?.[1] || undefined;
}

function shouldSkipProp(name: string): boolean {
  if (SKIP_PROPS.has(name)) return true;
  if (SKIP_PREFIXES.some((p) => name.startsWith(p))) return true;
  return false;
}

/**
 * Check if a prop name needs an explicit attribute mapping.
 * camelCase props need kebab-case HTML attributes.
 */
function needsExplicitAttribute(name: string): boolean {
  // Already lowercase = no explicit attribute needed
  if (name === name.toLowerCase()) return false;
  // aria-* props
  if (name.startsWith('aria')) return true;
  // camelCase props
  return /[A-Z]/.test(name);
}

/**
 * Convert camelCase to kebab-case.
 */
function toKebabCase(str: string): string {
  // Handle 'ariaLabel' → 'aria-label'
  if (str.startsWith('aria')) {
    return str.replace(/([A-Z])/g, '-$1').toLowerCase();
  }
  // Handle 'readOnly' → 'read-only', 'iconName' → 'icon-name'
  return str.replace(/([A-Z])/g, '-$1').toLowerCase();
}

// ---------------------------------------------------------------------------
// Type-string-based inference
// ---------------------------------------------------------------------------

function inferFromTypeString(typeStr: string): { litType: PropIR['litType'] } | null {
  if (!typeStr || typeStr === 'unknown') return null;

  const stripped = stripNullUndefined(typeStr).trim();
  if (!stripped) return null;

  if (stripped === 'boolean') return { litType: 'Boolean' };
  if (stripped === 'string') return { litType: 'String' };
  if (stripped === 'number') return { litType: 'Number' };

  if (isStringLiteralUnion(stripped)) return { litType: 'String' };
  if (isArrayType(stripped)) return { litType: 'Array' };

  return null;
}

function stripNullUndefined(typeStr: string): string {
  return typeStr
    .split('|')
    .map(p => p.trim())
    .filter(p => p !== 'null' && p !== 'undefined')
    .join(' | ');
}

function isStringLiteralUnion(typeStr: string): boolean {
  const parts = typeStr.split('|').map(p => p.trim());
  return parts.length > 0 && parts.every(p => /^'[^']*'$/.test(p) || /^"[^"]*"$/.test(p));
}

function isArrayType(typeStr: string): boolean {
  const t = typeStr.trim();
  return t.endsWith('[]') || t.startsWith('Array<') || t.startsWith('ReadonlyArray<') || t.startsWith('readonly ');
}

// ---------------------------------------------------------------------------
// Published .d.ts type map builder
// ---------------------------------------------------------------------------

/**
 * Build a type map from published declaration files (e.g., @cloudscape-design/components).
 * Reads interfaces.d.ts and extracts every property with its full type string.
 */
function buildDtsTypeMap(declarationsDir: string, componentName: string): Map<string, string> {
  const map = new Map<string, string>();

  const dtsPath = path.join(declarationsDir, componentName, 'interfaces.d.ts');
  if (!fs.existsSync(dtsPath)) return map;

  const dtsFile = parseFile(dtsPath);
  const pascal = componentName.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  const propsName = `${pascal}Props`;

  // Walk the file looking for the main interface (e.g., "export interface AlertProps extends ...")
  function visit(node: ts.Node) {
    if (ts.isInterfaceDeclaration(node) && node.name.text === propsName) {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name) && member.type) {
          map.set(member.name.text, getNodeText(member.type, dtsFile));
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(dtsFile);
  return map;
}

// ---------------------------------------------------------------------------
// Interface type map builder (vendor source fallback)
// ---------------------------------------------------------------------------

function buildInterfaceTypeMap(componentDir: string): Map<string, string> {
  const map = new Map<string, string>();

  const interfacesPath = findInterfacesFile(componentDir);
  if (!interfacesPath) return map;

  const interfaceFile = parseFile(interfacesPath);

  function visitInterface(node: ts.InterfaceDeclaration) {
    for (const member of node.members) {
      if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name) && member.type) {
        const name = member.name.text;
        const typeStr = getNodeText(member.type, interfaceFile);
        if (!map.has(name)) {
          map.set(name, typeStr);
        }
      }
    }
  }

  function visit(node: ts.Node) {
    if (ts.isInterfaceDeclaration(node)) {
      visitInterface(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(interfaceFile);
  return map;
}

function findInterfacesFile(componentDir: string): string | null {
  for (const name of ['interfaces.ts', 'interfaces.tsx']) {
    const p = path.join(componentDir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
