/**
 * Shared template tree walker.
 *
 * Provides a generic visitor pattern for TemplateNodeIR trees.
 * Each transform provides only its node-level logic; the walker
 * handles structural recursion (children, condition.alternate, loop).
 *
 * This replaces 10+ hand-rolled recursive walkers across the codebase,
 * and fixes inconsistencies where some walkers missed condition.alternate
 * or loop.iterable.
 */
import type { TemplateNodeIR, AttributeIR } from './ir/types.js';

// ---------------------------------------------------------------------------
// Visitor interface
// ---------------------------------------------------------------------------

/**
 * A visitor transforms a single node's own fields (tag, attributes,
 * expression, condition expression, loop iterable). The walker handles
 * recursion into children and condition.alternate automatically.
 *
 * Return `undefined` to keep the original value unchanged.
 */
export interface TemplateVisitor {
  /** Transform the node's tag. */
  tag?: (tag: string, node: TemplateNodeIR) => string | undefined;

  /** Transform an attribute. Return null to remove it, undefined to keep. */
  attribute?: (attr: AttributeIR, node: TemplateNodeIR) => AttributeIR | null | undefined;

  /** Transform an attribute's expression value. */
  attributeExpression?: (expr: string, attr: AttributeIR, node: TemplateNodeIR) => string | undefined;

  /** Transform the node's inline expression. */
  expression?: (expr: string, node: TemplateNodeIR) => string | undefined;

  /** Transform the condition expression. */
  conditionExpression?: (expr: string, node: TemplateNodeIR) => string | undefined;

  /** Transform the loop iterable expression. */
  loopIterable?: (expr: string, node: TemplateNodeIR) => string | undefined;

  /**
   * Transform the entire node after attribute/expression processing.
   * Receives the node with updated attributes/expressions but before
   * children are recursed. Return undefined to keep, or a new node.
   */
  node?: (node: TemplateNodeIR) => TemplateNodeIR | undefined;
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

/**
 * Walk a template tree, applying the visitor to each node.
 * Handles all structural recursion: children, condition.alternate, loop.
 */
export function walkTemplate(
  root: TemplateNodeIR,
  visitor: TemplateVisitor,
): TemplateNodeIR {
  return walkNode(root, visitor);
}

function walkNode(node: TemplateNodeIR, visitor: TemplateVisitor): TemplateNodeIR {
  let result = { ...node };

  // Tag
  if (visitor.tag && result.tag) {
    const newTag = visitor.tag(result.tag, result);
    if (newTag !== undefined) result = { ...result, tag: newTag };
  }

  // Attributes
  if (visitor.attribute || visitor.attributeExpression) {
    const newAttrs: AttributeIR[] = [];
    for (const attr of result.attributes) {
      let processed: AttributeIR | null | undefined = attr;

      // Full attribute transform
      if (visitor.attribute) {
        processed = visitor.attribute(attr, result);
        if (processed === null) continue; // remove
        if (processed === undefined) processed = attr; // keep original
      }

      // Expression-only transform
      if (visitor.attributeExpression && typeof processed.value !== 'string') {
        const newExpr = visitor.attributeExpression(processed.value.expression, processed, result);
        if (newExpr !== undefined) {
          processed = { ...processed, value: { expression: newExpr } };
        }
      }

      newAttrs.push(processed);
    }
    result = { ...result, attributes: newAttrs };
  }

  // Expression
  if (visitor.expression && result.expression) {
    const newExpr = visitor.expression(result.expression, result);
    if (newExpr !== undefined) result = { ...result, expression: newExpr };
  }

  // Condition expression
  if (result.condition) {
    let condition = { ...result.condition };

    if (visitor.conditionExpression) {
      const newExpr = visitor.conditionExpression(condition.expression, result);
      if (newExpr !== undefined) condition = { ...condition, expression: newExpr };
    }

    // Recurse into alternate
    if (condition.alternate) {
      condition = { ...condition, alternate: walkNode(condition.alternate, visitor) };
    }

    result = { ...result, condition };
  }

  // Loop iterable
  if (result.loop && visitor.loopIterable) {
    const newIterable = visitor.loopIterable(result.loop.iterable, result);
    if (newIterable !== undefined) {
      result = { ...result, loop: { ...result.loop, iterable: newIterable } };
    }
  }

  // Full node transform (after attributes/expressions, before children)
  if (visitor.node) {
    const newNode = visitor.node(result);
    if (newNode !== undefined) result = newNode;
  }

  // Recurse into children
  if (result.children.length > 0) {
    result = { ...result, children: result.children.map((c: TemplateNodeIR) => walkNode(c, visitor)) };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Query helpers (non-mutating walkers)
// ---------------------------------------------------------------------------

/**
 * Check if any node in the template tree matches a predicate.
 */
export function someInTemplate(
  root: TemplateNodeIR,
  predicate: (node: TemplateNodeIR) => boolean,
): boolean {
  if (predicate(root)) return true;
  for (const child of root.children) {
    if (someInTemplate(child, predicate)) return true;
  }
  if (root.condition?.alternate && someInTemplate(root.condition.alternate, predicate)) return true;
  return false;
}

/**
 * Check if any attribute expression in the template contains a string.
 */
export function templateHasExpression(
  root: TemplateNodeIR,
  search: string,
): boolean {
  return someInTemplate(root, (node) => {
    for (const attr of node.attributes) {
      if (typeof attr.value !== 'string' && attr.value.expression.includes(search)) return true;
    }
    if (node.expression?.includes(search)) return true;
    return false;
  });
}
