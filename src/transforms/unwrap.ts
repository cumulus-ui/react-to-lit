/**
 * WithNativeAttributes unwrapping transform.
 *
 * Cloudscape wraps every root element in <WithNativeAttributes tag="span" ...>.
 * This transform replaces the wrapper with a plain element using the tag prop value.
 */
import type { TemplateNodeIR, AttributeIR } from '../ir/types.js';
import { REMOVE_ATTRS } from '../cloudscape-config.js';

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

/**
 * Recursively unwrap WithNativeAttributes nodes in the template tree.
 */
export function unwrapWithNativeAttributes(node: TemplateNodeIR): TemplateNodeIR {
  // Check if this node IS a WithNativeAttributes component
  if (node.kind === 'component' && node.tag === 'WithNativeAttributes') {
    return unwrapNode(node);
  }

  // Recurse into children
  const transformedChildren = node.children.map(unwrapWithNativeAttributes);

  return {
    ...node,
    children: transformedChildren,
    condition: node.condition
      ? {
          ...node.condition,
          alternate: node.condition.alternate
            ? unwrapWithNativeAttributes(node.condition.alternate)
            : undefined,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Unwrap logic
// ---------------------------------------------------------------------------

function unwrapNode(node: TemplateNodeIR): TemplateNodeIR {
  // Extract the tag prop value
  const tagAttr = node.attributes.find((a) => a.name === 'tag');
  const tag = tagAttr
    ? (typeof tagAttr.value === 'string' ? tagAttr.value : 'div')
    : 'div';

  // Filter out WithNativeAttributes-specific props
  const skipAttrs = new Set([...REMOVE_ATTRS, 'tag']);

  const keptAttrs: AttributeIR[] = [];
  for (const attr of node.attributes) {
    // Skip WNA internal props
    if (skipAttrs.has(attr.name)) continue;
    // Skip spread of baseProps
    if (attr.kind === 'spread') continue;
    // Skip ref bindings to __internalRootRef
    if (attr.name === 'ref' || attr.name === '.ref') continue;

    keptAttrs.push(attr);
  }

  // Recurse into children
  const transformedChildren = node.children.map(unwrapWithNativeAttributes);

  return {
    kind: 'element',
    tag,
    attributes: keptAttrs,
    children: transformedChildren,
    condition: node.condition,
    loop: node.loop,
  };
}
