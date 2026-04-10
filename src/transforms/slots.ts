/**
 * Slot detection transform.
 *
 * Converts React children/ReactNode props rendered as JSX children
 * into <slot> elements in the template.
 */
import type { ComponentIR, TemplateNodeIR } from '../ir/types.js';

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

/**
 * Detect slot usage in the template and convert expression nodes
 * that reference slot props into <slot> elements.
 */
export function transformSlots(ir: ComponentIR): ComponentIR {
  // Collect slot prop names
  const slotProps = new Set<string>();
  for (const prop of ir.props) {
    if (prop.category === 'slot') {
      slotProps.add(prop.name);
    }
  }

  if (slotProps.size === 0) return ir;

  // Transform template
  const template = transformTemplateSlots(ir.template, slotProps);

  return { ...ir, template };
}

// ---------------------------------------------------------------------------
// Template slot transformation
// ---------------------------------------------------------------------------

function transformTemplateSlots(
  node: TemplateNodeIR,
  slotProps: Set<string>,
): TemplateNodeIR {
  // Check if this expression node references a slot prop
  if (node.kind === 'expression' && node.expression) {
    const trimmed = node.expression.trim();
    if (slotProps.has(trimmed)) {
      // children → <slot></slot>
      if (trimmed === 'children') {
        return {
          kind: 'slot',
          attributes: [],
          children: [],
        };
      }
      // named slot → <slot name="propName"></slot>
      return {
        kind: 'slot',
        tag: 'slot',
        attributes: [{ name: 'name', value: trimmed, kind: 'static' }],
        children: [],
      };
    }
  }

  // Recurse into children
  const transformedChildren = node.children.map((child) =>
    transformTemplateSlots(child, slotProps),
  );

  return {
    ...node,
    children: transformedChildren,
    condition: node.condition
      ? {
          ...node.condition,
          alternate: node.condition.alternate
            ? transformTemplateSlots(node.condition.alternate, slotProps)
            : undefined,
        }
      : undefined,
  };
}
