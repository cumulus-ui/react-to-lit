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
  // Core components
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
  'CheckboxIcon': 'cs-checkbox-icon',
  'InternalBox': 'cs-box',
  'InternalHeader': 'cs-header',
  'InternalSelect': 'cs-select',
  'InternalAutosuggest': 'cs-autosuggest',
  'InternalMultiselect': 'cs-multiselect',
  'InternalTokenGroup': 'cs-token-group',
  'InternalFileDropzone': 'cs-file-dropzone',
  'InternalFormField': 'cs-form-field',
  'InternalExpandableSection': 'cs-expandable-section',
  'InternalColumnLayout': 'cs-column-layout',
  'InternalTextarea': 'cs-textarea',
  'InternalDateInput': 'cs-date-input',
  'InternalTimeInput': 'cs-time-input',
  'InternalPopover': 'cs-popover',
  'InternalToggle': 'cs-toggle',
  'InternalRadioGroup': 'cs-radio-group',
  'InternalBreadcrumbGroup': 'cs-breadcrumb-group',
  'InternalCalendar': 'cs-calendar',
  'InternalButtonDropdown': 'cs-button-dropdown',
  'InternalSpaceBetween': 'cs-space-between',
  'InternalTable': 'cs-table',
  'InternalCards': 'cs-cards',
  'InternalContainer': 'cs-container',
  'InternalContainerAsSubstep': 'cs-container',
  'InternalItemCard': 'cs-item-card',
  'InternalGrid': 'cs-grid',
  'InternalTabs': 'cs-tabs',
  'InternalPagination': 'cs-pagination',

  // Sub-components / shared internals
  'AbstractSwitch': 'cs-abstract-switch',
  'ToggleIcon': 'cs-toggle-icon',
  'RadioIcon': 'cs-radio-icon',

  // React-only wrapper components → unwrap (keep children)
  'BuiltInErrorBoundary': '__UNWRAP__',
  'CSSTransition': '__UNWRAP__',
  'AnalyticsFunnelSubStep': '__UNWRAP__',
  'AnalyticsFunnelStep': '__UNWRAP__',
  'FocusLock': '__UNWRAP__',
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
    if (resolved === '__UNWRAP__') {
      // Unwrap: replace with a fragment containing the children
      resolvedNode = {
        kind: 'fragment',
        attributes: [],
        children: node.children,
        condition: node.condition,
        loop: node.loop,
      };
    } else if (resolved) {
      resolvedNode = {
        ...node,
        kind: 'element',
        tag: resolved,
      };

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
