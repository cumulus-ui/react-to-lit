/**
 * Component reference resolution transform.
 *
 * Resolves React component references in templates using a registry.
 * Registry entries can be:
 *   - string: simple tag replacement ('el-icon')
 *   - '__UNWRAP__': keep children, discard wrapper
 *   - function: (node) => TemplateNodeIR — full template replacement
 */
import type { TemplateNodeIR, AttributeIR } from '../ir/types.js';
import { UNWRAP_COMPONENTS, shouldUnwrapComponent } from '../cloudscape-config.js';
import { toTagName } from '../naming.js';

// React builtins that are ALWAYS unwrapped regardless of config
const REACT_BUILTINS = ['Fragment', 'React.Fragment', 'Suspense', 'StrictMode', 'Profiler'];


// ---------------------------------------------------------------------------
// Registry types
// ---------------------------------------------------------------------------

/**
 * A registry entry can be:
 * - A string tag name for simple replacement
 * - '__UNWRAP__' to remove the wrapper and keep children
 * - A function that receives the original node and returns a replacement
 */
export type RegistryEntry =
  | string
  | ((node: TemplateNodeIR) => TemplateNodeIR);

export type ComponentRegistry = Record<string, RegistryEntry>;

// ---------------------------------------------------------------------------
// Helper: extract a prop value from a node's attributes
// ---------------------------------------------------------------------------

function getAttr(node: TemplateNodeIR, name: string): string | undefined {
  const attr = node.attributes.find(
    (a) => a.name === name || a.name === `.${name}`,
  );
  if (!attr) return undefined;
  if (typeof attr.value === 'string') return attr.value;
  return attr.value.expression;
}

// ---------------------------------------------------------------------------
// Config-aware unwrap check
// ---------------------------------------------------------------------------

/**
 * Check if a component name should be unwrapped, using an optional custom set.
 * Falls back to the default UNWRAP_COMPONENTS when no set is provided.
 *
 * React builtins (Fragment, Suspense, StrictMode, Profiler) and Context
 * wrappers (.Provider, .Consumer) are ALWAYS unwrapped regardless of config.
 */
function shouldUnwrapComponentWithConfig(name: string, unwrapSet?: Set<string>): boolean {
  const set = unwrapSet ?? UNWRAP_COMPONENTS;
  if (set.has(name)) return true;
  // React builtins always unwrap (universal, not library-specific)
  if (REACT_BUILTINS.includes(name)) return true;
  // Any Xxx.Provider or Xxx.Consumer is a React Context wrapper
  if (name.endsWith('.Provider') || name.endsWith('.Consumer')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// AbstractSwitch template builder
//
// Replaces <AbstractSwitch> with the shared CSS class contract:
//   span.abstract-switch--wrapper
//     span.abstract-switch--label-wrapper
//       span.abstract-switch--control.{controlClassName}
//         input.abstract-switch--native-input (visually hidden)
//         span.abstract-switch--outline
//       span.abstract-switch--content
//         span.abstract-switch--label > <slot>
//         span.abstract-switch--description (conditional)
// ---------------------------------------------------------------------------

function buildAbstractSwitch(node: TemplateNodeIR): TemplateNodeIR {
  const controlClassName = getAttr(node, 'controlClassName') ?? "''";
  const disabled = getAttr(node, 'disabled') ?? 'false';
  const readOnly = getAttr(node, 'readOnly') ?? 'false';
  const controlId = getAttr(node, 'controlId');
  const ariaLabel = getAttr(node, 'ariaLabel');
  const ariaLabelledby = getAttr(node, 'ariaLabelledby');
  const ariaDescribedby = getAttr(node, 'ariaDescribedby');

  // Collect event handlers from the original node
  const eventAttrs = node.attributes.filter((a) => a.kind === 'event');

  const inputAttrs: AttributeIR[] = [
    { name: 'type', value: 'checkbox', kind: 'static' },
    { name: 'class', value: 'abstract-switch--native-input', kind: 'static' },
    { name: 'checked', value: { expression: 'this.checked' }, kind: 'boolean' },
    { name: 'disabled', value: { expression: disabled }, kind: 'boolean' },
  ];
  if (controlId) inputAttrs.push({ name: 'id', value: { expression: controlId }, kind: 'attribute' });
  if (ariaLabel) inputAttrs.push({ name: 'aria-label', value: { expression: ariaLabel }, kind: 'attribute' });
  if (ariaLabelledby) inputAttrs.push({ name: 'aria-labelledby', value: { expression: ariaLabelledby }, kind: 'attribute' });
  if (ariaDescribedby) inputAttrs.push({ name: 'aria-describedby', value: { expression: ariaDescribedby }, kind: 'attribute' });
  if (readOnly !== 'false') {
    inputAttrs.push({ name: 'aria-disabled', value: { expression: `${readOnly} && !${disabled} ? 'true' : undefined` }, kind: 'attribute' });
  }

  // Build control class expression — handle clsx in controlClassName
  let controlClassExpr: string;
  if (controlClassName.includes('clsx(') || controlClassName.includes('styles')) {
    controlClassExpr = `{ 'abstract-switch--control': true }`;
  } else {
    controlClassExpr = `{ 'abstract-switch--control': true, [${controlClassName}]: true }`;
  }

  return {
    kind: 'element',
    tag: 'span',
    attributes: [
      {
        name: 'class',
        value: { expression: "classMap({ 'root': true, 'abstract-switch--wrapper': true })" },
        kind: 'classMap',
      },
      ...eventAttrs,
    ],
    children: [
      {
        kind: 'element',
        tag: 'span',
        attributes: [{ name: 'class', value: 'abstract-switch--label-wrapper', kind: 'static' }],
        children: [
          // Control area
          {
            kind: 'element',
            tag: 'span',
            attributes: [{
              name: 'class',
              value: { expression: `classMap(${controlClassExpr})` },
              kind: 'classMap',
            }],
            children: [
              // Native input
              { kind: 'element', tag: 'input', attributes: inputAttrs, children: [] },
              // Outline
              {
                kind: 'element',
                tag: 'span',
                attributes: [{ name: 'class', value: 'abstract-switch--outline', kind: 'static' }],
                children: [],
              },
            ],
          },
          // Content area
          {
            kind: 'element',
            tag: 'span',
            attributes: [{ name: 'class', value: 'abstract-switch--content', kind: 'static' }],
            children: [
              {
                kind: 'element',
                tag: 'span',
                attributes: [{ name: 'class', value: 'abstract-switch--label', kind: 'static' }],
                children: [{ kind: 'slot', attributes: [], children: [] }],
              },
            ],
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Default Cloudscape registry
// ---------------------------------------------------------------------------

export const cloudscapeComponentRegistry: ComponentRegistry = {
  // Template replacements — function-based
  'AbstractSwitch': buildAbstractSwitch,

  // React-only wrappers → unwrap (keep children)
  // Generated from the shared UNWRAP_COMPONENTS set in cloudscape-config.ts
  ...Object.fromEntries([...UNWRAP_COMPONENTS].map(name => [name, '__UNWRAP__' as const])),
};

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

export function resolveComponentReferences(
  node: TemplateNodeIR,
  registry: ComponentRegistry = cloudscapeComponentRegistry,
  unwrapComponents?: Set<string>,
): { template: TemplateNodeIR; sideEffectImports: Set<string> } {
  const imports = new Set<string>();
  const transformed = resolveNode(node, registry, imports, unwrapComponents);
  return { template: transformed, sideEffectImports: imports };
}

// ---------------------------------------------------------------------------
// Recursive resolution
// ---------------------------------------------------------------------------

function resolveNode(
  node: TemplateNodeIR,
  registry: ComponentRegistry,
  imports: Set<string>,
  unwrapComponents?: Set<string>,
): TemplateNodeIR {
  let resolvedNode = node;

  if (node.kind === 'component' && node.tag) {
    const entry = registry[node.tag];

    if (typeof entry === 'function') {
      // Function-based replacement
      resolvedNode = entry(node);
    } else if (entry === '__UNWRAP__') {
      // Unwrap: fragment with children
      resolvedNode = {
        kind: 'fragment',
        attributes: [],
        children: node.children,
        condition: node.condition,
        loop: node.loop,
      };
    } else if (typeof entry === 'string') {
      // Simple tag replacement
      resolvedNode = {
        ...node,
        kind: 'element',
        tag: entry,
      };
      const componentPath = deriveImportPath(entry);
      if (componentPath) imports.add(componentPath);
    } else if (shouldUnwrapComponentWithConfig(node.tag, unwrapComponents)) {
      // Dynamic pattern match (e.g., any Xxx.Provider not explicitly listed)
      resolvedNode = {
        kind: 'fragment',
        attributes: [],
        children: node.children,
        condition: node.condition,
        loop: node.loop,
      };
    } else {
      // Unknown component — auto-derive a custom element tag name
      // e.g., InternalStatusIcon → el-internal-status-icon
      const autoTag = toTagName(node.tag);
      resolvedNode = {
        ...node,
        kind: 'element',
        tag: autoTag,
      };
      const componentPath = deriveImportPath(autoTag);
      if (componentPath) imports.add(componentPath);
    }
  }

  // Recurse into children
  const transformedChildren = resolvedNode.children.map((child) =>
    resolveNode(child, registry, imports, unwrapComponents),
  );

  return {
    ...resolvedNode,
    children: transformedChildren,
    condition: resolvedNode.condition
      ? {
          ...resolvedNode.condition,
          alternate: resolvedNode.condition.alternate
            ? resolveNode(resolvedNode.condition.alternate, registry, imports, unwrapComponents)
            : undefined,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Import path derivation
// ---------------------------------------------------------------------------

function deriveImportPath(tagName: string): string | null {
  // Tag format: el-{kebab-name} → strip 'el-' prefix to get component path
  if (tagName.startsWith('el-')) {
    const componentName = tagName.slice(3); // strip 'el-'
    return `../${componentName}/index.js`;
  }
  const parts = tagName.split('-');
  if (parts.length < 2) return null;
  const componentName = parts.slice(1).join('-');
  return `../${componentName}/index.js`;
}
