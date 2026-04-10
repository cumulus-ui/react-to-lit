/**
 * Parser tests against real Cloudscape component source.
 *
 * Tests parse Badge (Pattern A: single file), Spinner (Pattern B: wrapper + internal),
 * and StatusIndicator (Pattern B: wrapper + internal with conditionals).
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { parseComponent } from '../../src/parser/index.js';

const CLOUDSCAPE_SRC = path.resolve(
  import.meta.dirname,
  '../../vendor/cloudscape-source/src',
);

describe('parseComponent', () => {
  // -------------------------------------------------------------------------
  // Badge — Pattern A: single index.tsx, no hooks
  // -------------------------------------------------------------------------
  describe('Badge', () => {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'badge'), {
      prefix: 'cs',
    });

    it('should derive the correct component name', () => {
      expect(ir.name).toBe('Badge');
    });

    it('should derive the correct tag name', () => {
      expect(ir.tagName).toBe('cs-badge');
    });

    it('should extract the color prop with default', () => {
      const colorProp = ir.props.find((p) => p.name === 'color');
      expect(colorProp).toBeDefined();
      expect(colorProp!.category).toBe('attribute');
      expect(colorProp!.default).toBe("'grey'");
    });

    it('should detect children as a slot', () => {
      const childrenProp = ir.props.find((p) => p.name === 'children');
      expect(childrenProp).toBeDefined();
      expect(childrenProp!.category).toBe('slot');
    });

    it('should skip Cloudscape internal props', () => {
      const internalProps = ir.props.filter(
        (p) => p.name.startsWith('__') || p.name === 'nativeAttributes',
      );
      expect(internalProps).toHaveLength(0);
    });

    it('should have no state (no useState calls)', () => {
      expect(ir.state).toHaveLength(0);
    });

    it('should have no effects (no useEffect calls)', () => {
      expect(ir.effects).toHaveLength(0);
    });

    it('should have no refs', () => {
      expect(ir.refs).toHaveLength(0);
    });

    it('should have a template', () => {
      expect(ir.template).toBeDefined();
      expect(ir.template.kind).toBeDefined();
    });

    it('should not use forwardRef', () => {
      expect(ir.forwardRef).toBe(false);
    });

    it('should report sourceFiles', () => {
      expect(ir.sourceFiles).toContain('index.tsx');
    });
  });

  // -------------------------------------------------------------------------
  // Spinner — Pattern B: wrapper + internal, no hooks
  // -------------------------------------------------------------------------
  describe('Spinner', () => {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'spinner'), {
      prefix: 'cs',
    });

    it('should derive the correct component name', () => {
      expect(ir.name).toBe('Spinner');
    });

    it('should derive the correct tag name', () => {
      expect(ir.tagName).toBe('cs-spinner');
    });

    it('should extract size prop with default', () => {
      const sizeProp = ir.props.find((p) => p.name === 'size');
      expect(sizeProp).toBeDefined();
      expect(sizeProp!.default).toBe("'normal'");
    });

    it('should extract variant prop with default', () => {
      const variantProp = ir.props.find((p) => p.name === 'variant');
      expect(variantProp).toBeDefined();
      expect(variantProp!.default).toBe("'normal'");
    });

    it('should have no state', () => {
      expect(ir.state).toHaveLength(0);
    });

    it('should have no effects', () => {
      expect(ir.effects).toHaveLength(0);
    });

    it('should have template with child elements', () => {
      expect(ir.template).toBeDefined();
      // Spinner should render spans inside a root element
      expect(ir.template.children.length).toBeGreaterThan(0);
    });

    it('should report both source files', () => {
      expect(ir.sourceFiles).toContain('index.tsx');
      expect(ir.sourceFiles).toContain('internal.tsx');
    });
  });

  // -------------------------------------------------------------------------
  // StatusIndicator — Pattern B with conditionals and sub-components
  // -------------------------------------------------------------------------
  describe('StatusIndicator', () => {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'status-indicator'), {
      prefix: 'cs',
    });

    it('should derive the correct component name', () => {
      expect(ir.name).toBe('StatusIndicator');
    });

    it('should derive the correct tag name', () => {
      expect(ir.tagName).toBe('cs-status-indicator');
    });

    it('should extract type prop with default', () => {
      const typeProp = ir.props.find((p) => p.name === 'type');
      expect(typeProp).toBeDefined();
      expect(typeProp!.default).toBe("'success'");
    });

    it('should extract wrapText prop as boolean', () => {
      const wrapTextProp = ir.props.find((p) => p.name === 'wrapText');
      expect(wrapTextProp).toBeDefined();
      expect(wrapTextProp!.litType).toBe('Boolean');
      expect(wrapTextProp!.default).toBe('true');
    });

    it('should detect children as a slot', () => {
      const childrenProp = ir.props.find((p) => p.name === 'children');
      expect(childrenProp).toBeDefined();
      expect(childrenProp!.category).toBe('slot');
    });

    it('should have pure utility helpers (no JSX helpers)', () => {
      // JSX-containing helpers like typeToIcon are now filtered out
      // Only pure utility functions should remain
      for (const h of ir.helpers) {
        expect(h.source).not.toMatch(/<[A-Z]/);
      }
    });

    it('should have a template with component references', () => {
      // The template should reference InternalIcon and/or InternalSpinner
      const hasComponentRef = findComponentNodes(ir.template);
      expect(hasComponentRef).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Helper to recursively check for component nodes in the template
// ---------------------------------------------------------------------------
function findComponentNodes(
  node: import('../../src/ir/types.js').TemplateNodeIR,
): boolean {
  if (node.kind === 'component') return true;
  for (const child of node.children) {
    if (findComponentNodes(child)) return true;
  }
  if (node.condition?.alternate) {
    if (findComponentNodes(node.condition.alternate)) return true;
  }
  return false;
}
