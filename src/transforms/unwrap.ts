/**
 * WithNativeAttributes unwrapping transform.
 *
 * Cloudscape wraps every root element in <WithNativeAttributes tag="span" ...>.
 * This transform replaces the wrapper with a plain element using the tag prop value.
 */
import type { TemplateNodeIR, AttributeIR } from '../ir/types.js';
import { REMOVE_ATTRS } from '../cloudscape-config.js';
import { walkTemplate } from '../template-walker.js';

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

/**
 * Recursively unwrap WithNativeAttributes nodes in the template tree.
 *
 * @param node - The template node to process
 * @param removeAttrs - Optional set of attribute names to strip. Falls back to the
 *   default REMOVE_ATTRS from cloudscape-config when omitted.
 */
export function unwrapWithNativeAttributes(
  node: TemplateNodeIR,
  removeAttrs?: string[],
): TemplateNodeIR {
  return walkTemplate(node, {
    node: (n) => {
      if (n.kind === 'component' && n.tag === 'WithNativeAttributes') {
        return unwrapNode(n, removeAttrs);
      }
      return undefined; // keep as-is
    },
  });
}

// ---------------------------------------------------------------------------
// Unwrap logic
// ---------------------------------------------------------------------------

function unwrapNode(node: TemplateNodeIR, removeAttrs?: string[]): TemplateNodeIR {
  // Extract the tag prop value
  const tagAttr = node.attributes.find((a) => a.name === 'tag');
  const tag = tagAttr
    ? (typeof tagAttr.value === 'string' ? tagAttr.value : 'div')
    : 'div';

  // Filter out WithNativeAttributes-specific props
  const attrsToRemove = removeAttrs ?? REMOVE_ATTRS;
  const skipAttrs = new Set([...attrsToRemove, 'tag']);

  const keptAttrs: AttributeIR[] = [];
  for (const attr of node.attributes) {
    if (skipAttrs.has(attr.name)) continue;
    if (attr.kind === 'spread') continue;
    if (attr.name === 'ref' || attr.name === '.ref') continue;
    keptAttrs.push(attr);
  }

  return {
    kind: 'element',
    tag,
    attributes: keptAttrs,
    children: node.children, // walkTemplate handles child recursion
    condition: node.condition,
    loop: node.loop,
  };
}
