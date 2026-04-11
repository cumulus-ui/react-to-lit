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

// ---------------------------------------------------------------------------
// Props to skip (Cloudscape internal infrastructure)
// ---------------------------------------------------------------------------

const SKIP_PROPS = new Set([
  '__internalRootRef',
  '__injectAnalyticsComponentMetadata',
  '__animate',
  '__size',
  '__display',
  '__iconClass',
  '__focusable',
  '__title',
  '__emitPerformanceMarks',
  '__skipNativeAttributesWarnings',
  '__inheritFormFieldProps',
  'nativeAttributes',
  'nativeInputAttributes',
  'nativeButtonAttributes',
  'nativeAnchorAttributes',
  'analyticsAction',
  'analyticsMetadata',
  '__analyticsMetadata',
]);

/** Props that should be skipped if they start with these prefixes */
const SKIP_PREFIXES = ['__'];

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
 * Merges defaults from index.tsx and internal.tsx.
 */
export function extractProps(
  component: RawComponent,
  sourceFile: ts.SourceFile,
  componentDir?: string,
): PropIR[] {
  const props: PropIR[] = [];

  // Build interface type map from interfaces.ts if available
  const interfaceTypeMap = componentDir
    ? buildInterfaceTypeMap(componentDir)
    : new Map<string, string>();

  // Get the destructured prop names from the function parameters
  const destructuredProps = getDestructuredProps(component.parameters, sourceFile, interfaceTypeMap);

  // Merge defaults (index defaults take priority as they're the public API)
  const mergedDefaults = new Map([
    ...component.defaultsFromInternal,
    ...component.defaultsFromIndex,
  ]);

  for (const [propName, propInfo] of destructuredProps) {
    // Skip internal/infrastructure props
    if (shouldSkipProp(propName)) continue;

    // Override default if we have one from the outer wrapper
    const defaultValue = mergedDefaults.get(propName) ?? propInfo.default;

    const prop = classifyProp(propName, propInfo.typeText, defaultValue);
    props.push(prop);
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

function isBooleanProp(name: string, _typeText: string, defaultValue?: string): boolean {
  // Infer from default value
  if (defaultValue === 'false' || defaultValue === 'true') return true;

  // Common boolean prop names
  const booleanNames = new Set([
    'disabled', 'loading', 'checked', 'indeterminate', 'readOnly',
    'external', 'dismissible', 'wrapText', 'fullWidth', 'invalid',
    'warning', 'required', 'ariaRequired', 'expandable', 'expanded',
  ]);
  return booleanNames.has(name);
}

// ---------------------------------------------------------------------------
// Known array/object prop names (Cloudscape-specific but safe defaults)
// ---------------------------------------------------------------------------

const KNOWN_ARRAY_PROPS = new Set([
  'options', 'items', 'columns', 'selectedOptions', 'selectedItems',
  'filteringOptions', 'tokens', 'files', 'visibleColumns', 'columnDefinitions',
  'breadcrumbs', 'links', 'steps', 'tabs', 'tags', 'actions', 'pages',
  'segments', 'panes', 'tools', 'data', 'series', 'resources',
]);

const KNOWN_OBJECT_PROPS = new Set([
  'selectedOption', 'selectedItem', 'activeHref', 'ariaLabels',
  'i18nStrings', 'analyticsMetadata', 'filteringProperties',
]);

function isArrayProp(name: string, defaultValue?: string): boolean {
  // Detect from default value: [] or [...]
  if (defaultValue === '[]' || (defaultValue && defaultValue.startsWith('['))) return true;
  // Detect from known prop names
  return KNOWN_ARRAY_PROPS.has(name);
}

function isObjectProp(name: string, defaultValue?: string): boolean {
  // Detect from default value: {} or {...}
  if (defaultValue === '{}' || (defaultValue && defaultValue.startsWith('{'))) return true;
  // Detect from known prop names
  return KNOWN_OBJECT_PROPS.has(name);
}

function isNumberProp(defaultValue?: string): boolean {
  if (!defaultValue) return false;
  // Match numeric literals: 0, 1, 100, -1, 3.14, etc.
  return /^-?\d+(\.\d+)?$/.test(defaultValue);
}

function isCancelableEventType(_typeText: string): boolean {
  // Will be refined when we have full type resolution
  return false;
}

function extractEventDetailType(_typeText: string): string | undefined {
  return undefined;
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
// Interface type map builder
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
