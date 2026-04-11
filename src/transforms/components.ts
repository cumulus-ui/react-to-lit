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
  if (controlId) inputAttrs.push({ name: 'id', value: { expression: controlId }, kind: 'property' });
  if (ariaLabel) inputAttrs.push({ name: 'aria-label', value: { expression: ariaLabel }, kind: 'property' });
  if (ariaLabelledby) inputAttrs.push({ name: 'aria-labelledby', value: { expression: ariaLabelledby }, kind: 'property' });
  if (ariaDescribedby) inputAttrs.push({ name: 'aria-describedby', value: { expression: ariaDescribedby }, kind: 'property' });
  if (readOnly !== 'false') {
    inputAttrs.push({ name: 'aria-disabled', value: { expression: `${readOnly} && !${disabled} ? 'true' : undefined` }, kind: 'property' });
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
  'AnalyticsFunnel': '__UNWRAP__',
  'AnalyticsFunnelStep': '__UNWRAP__',
  'AnalyticsFunnelSubStep': '__UNWRAP__',
  'AppLayoutToolbarPublicContext.Provider': '__UNWRAP__',
  'BuiltInErrorBoundary': '__UNWRAP__',
  'ButtonContext.Provider': '__UNWRAP__',
  'CSSTransition': '__UNWRAP__',
  'CollectionLabelContext.Provider': '__UNWRAP__',
  'CollectionPreferencesMetadata.Provider': '__UNWRAP__',
  'ColumnWidthsProvider': '__UNWRAP__',
  'ContainerHeaderContextProvider': '__UNWRAP__',
  'DropdownContext.Provider': '__UNWRAP__',
  'DropdownContextProvider': '__UNWRAP__',
  'ErrorBoundariesContext.Provider': '__UNWRAP__',
  'ExpandableSectionContainer': '__UNWRAP__',
  'FocusLock': '__UNWRAP__',
  'FormFieldContext.Provider': '__UNWRAP__',
  'FormWithAnalytics': '__UNWRAP__',
  'FunnelNameSelectorContext.Provider': '__UNWRAP__',
  'GridNavigationProvider': '__UNWRAP__',
  'InfoLinkLabelContext.Provider': '__UNWRAP__',
  'InternalIconContext.Provider': '__UNWRAP__',
  'InternalModalAsFunnel': '__UNWRAP__',
  'KeyboardNavigationProvider': '__UNWRAP__',
  'LinkDefaultVariantContext.Provider': '__UNWRAP__',
  'ListComponent': '__UNWRAP__',
  'ModalContext.Provider': '__UNWRAP__',
  'ModalWithAnalyticsFunnel': '__UNWRAP__',
  'Portal': '__UNWRAP__',
  'React.Fragment': '__UNWRAP__',
  'ResetContextsForModal': '__UNWRAP__',
  'SingleTabStopNavigationProvider': '__UNWRAP__',
  'StickyHeaderContext.Provider': '__UNWRAP__',
  'TableComponentsContextProvider': '__UNWRAP__',
  'TokenInlineContext.Provider': '__UNWRAP__',
  'Transition': '__UNWRAP__',
  'TransitionGroup': '__UNWRAP__',
  'VisualContext': '__UNWRAP__',
  'WidthsContext.Provider': '__UNWRAP__',
  'WithNativeAttributes': '__UNWRAP__',
};

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

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
