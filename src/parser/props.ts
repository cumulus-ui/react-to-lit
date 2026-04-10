/**
 * Props extraction from React component interfaces.
 *
 * Reads the props type (from the function signature or interfaces.ts),
 * classifies each prop, and produces PropIR entries.
 */
import ts from 'typescript';
import type { PropIR } from '../ir/types.js';
import { getNodeText } from './program.js';
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
): PropIR[] {
  const props: PropIR[] = [];

  // Get the destructured prop names from the function parameters
  const destructuredProps = getDestructuredProps(component.parameters, sourceFile);

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
): Map<string, PropInfo> {
  const result = new Map<string, PropInfo>();
  if (parameters.length === 0) return result;

  const firstParam = parameters[0];

  // Handle: function Foo({ color = 'grey', ...rest }: BadgeProps)
  if (ts.isObjectBindingPattern(firstParam.name)) {
    const typeAnnotation = firstParam.type;

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

      // Try to resolve type from the props interface — for now use a placeholder
      const typeText = resolvePropertyType(propName, typeAnnotation, sourceFile);

      result.set(propName, { typeText, default: defaultValue });
    }
  }

  return result;
}

function resolvePropertyType(
  _propName: string,
  typeAnnotation: ts.TypeNode | undefined,
  _sourceFile: ts.SourceFile,
): string {
  // For MVP, we derive types from defaults and naming conventions.
  // Full type resolution from the interface will be added when we integrate
  // with ts.TypeChecker.
  return typeAnnotation ? 'unknown' : 'unknown';
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

  // Boolean props
  if (isBooleanProp(name, typeText, defaultValue)) {
    return {
      name,
      type: 'boolean',
      default: defaultValue,
      category: 'attribute',
      attribute: toKebabCase(name),
      litType: 'Boolean',
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

function isSlotProp(name: string, _typeText: string): boolean {
  // 'children' is always a slot
  if (name === 'children') return true;
  // Other props typed as ReactNode will be detected during type resolution
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
