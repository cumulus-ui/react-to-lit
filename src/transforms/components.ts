/**
 * Component reference resolution transform.
 *
 * When the template references React components like <InternalIcon>,
 * replace them with custom element tags: <cs-icon>.
 */
import type { TemplateNodeIR } from '../ir/types.js';

// ---------------------------------------------------------------------------
// Default component registry (Cloudscape)
// ---------------------------------------------------------------------------

export type ComponentRegistry = Record<string, string>;

export const cloudscapeComponentRegistry: ComponentRegistry = {
  'InternalIcon': 'cs-icon',
  'Icon': 'cs-icon',
  'InternalSpinner': 'cs-spinner',
  'Spinner': 'cs-spinner',
  'InternalButton': 'cs-button',
  'Button': 'cs-button',
  'InternalInput': 'cs-input',
  'Input': 'cs-input',
  'InternalCheckbox': 'cs-checkbox',
  'Checkbox': 'cs-checkbox',
  'InternalStatusIndicator': 'cs-status-indicator',
  'StatusIndicator': 'cs-status-indicator',
  'InternalLink': 'cs-link',
  'Link': 'cs-link',
  'InternalAlert': 'cs-alert',
  'Alert': 'cs-alert',
  'InternalLiveRegion': 'cs-live-region',
  'LiveRegion': 'cs-live-region',
  'Tooltip': 'cs-tooltip',
  'InternalStatusIcon': 'cs-status-icon',
  'AbstractSwitch': 'cs-abstract-switch', // Placeholder — handled by abstract-switch transform
  'CheckboxIcon': 'cs-checkbox-icon',
};

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

/**
 * Resolve component references in the template tree.
 * Returns the transformed template and a set of side-effect imports needed.
 */
export function resolveComponentReferences(
  node: TemplateNodeIR,
  registry: ComponentRegistry = cloudscapeComponentRegistry,
): { template: TemplateNodeIR; sideEffectImports: Set<string> } {
  const imports = new Set<string>();
  const transformed = resolveNode(node, registry, imports);
  return { template: transformed, sideEffectImports: imports };
}

// ---------------------------------------------------------------------------
// Recursive resolution
// ---------------------------------------------------------------------------

function resolveNode(
  node: TemplateNodeIR,
  registry: ComponentRegistry,
  imports: Set<string>,
): TemplateNodeIR {
  let resolvedNode = node;

  // If this is a component node, try to resolve it
  if (node.kind === 'component' && node.tag) {
    const resolved = registry[node.tag];
    if (resolved) {
      resolvedNode = {
        ...node,
        kind: 'element', // Now it's a custom element, not a React component
        tag: resolved,
      };

      // Add side-effect import for the component
      const componentPath = deriveImportPath(resolved);
      if (componentPath) {
        imports.add(componentPath);
      }
    }
  }

  // Recurse into children
  const transformedChildren = resolvedNode.children.map((child) =>
    resolveNode(child, registry, imports),
  );

  return {
    ...resolvedNode,
    children: transformedChildren,
    condition: resolvedNode.condition
      ? {
          ...resolvedNode.condition,
          alternate: resolvedNode.condition.alternate
            ? resolveNode(resolvedNode.condition.alternate, registry, imports)
            : undefined,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Import path derivation
// ---------------------------------------------------------------------------

/**
 * Derive the import path for a custom element tag.
 * cs-icon → ../icon/index.js
 */
function deriveImportPath(tagName: string): string | null {
  // Strip prefix: cs-icon → icon
  const parts = tagName.split('-');
  if (parts.length < 2) return null;

  // Remove the prefix (first part)
  const componentName = parts.slice(1).join('-');
  return `../${componentName}/index.js`;
}
