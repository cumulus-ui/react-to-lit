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
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'badge'));

    it('should derive the correct component name', () => {
      expect(ir.name).toBe('Badge');
    });

    it('should derive the correct tag name', () => {
      expect(ir.tagName).toBe('el-badge');
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
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'spinner'));

    it('should derive the correct component name', () => {
      expect(ir.name).toBe('Spinner');
    });

    it('should derive the correct tag name', () => {
      expect(ir.tagName).toBe('el-spinner');
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

    it('should have template with content', () => {
      expect(ir.template).toBeDefined();
      // After JSX transform, template is an expression containing html``
      expect(ir.template.kind).toBeDefined();
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
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'status-indicator'));

    it('should derive the correct component name', () => {
      expect(ir.name).toBe('StatusIndicator');
    });

    it('should derive the correct tag name', () => {
      expect(ir.tagName).toBe('el-status-indicator');
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

    it('should not have raw JSX in helpers (after transformer)', () => {
      // After JSX transform, helpers should not contain JSX syntax
      // (they may contain html`` tagged templates which is correct)
      for (const h of ir.helpers) {
        expect(h.source).not.toMatch(/\bclassName\s*[={]/);
      }
    });

    it('should have a template', () => {
      expect(ir.template).toBeDefined();
      expect(ir.template.kind).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // TopNavigation — preamble variable promotion
  // -------------------------------------------------------------------------
  describe('TopNavigation (preamble var promotion)', () => {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'top-navigation'));

    it('should promote isNarrowViewport to computed values', () => {
      const cv = ir.computedValues.find((c) => c.name === 'isNarrowViewport');
      expect(cv).toBeDefined();
      expect(cv!.expression).toContain("breakpoint === 'default'");
    });

    it('should promote isMediumViewport to computed values', () => {
      const cv = ir.computedValues.find((c) => c.name === 'isMediumViewport');
      expect(cv).toBeDefined();
      expect(cv!.expression).toContain("breakpoint === 'xxs'");
    });

    it('should remove promoted vars from bodyPreamble', () => {
      const hasNarrow = ir.bodyPreamble.some((s) => s.includes('isNarrowViewport'));
      expect(hasNarrow).toBe(false);
    });

    it('should not include promoted var names in localVariables', () => {
      expect(ir.localVariables.has('isNarrowViewport')).toBe(false);
      expect(ir.localVariables.has('isMediumViewport')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Dropdown — local type declaration preservation
  // -------------------------------------------------------------------------
  describe('Dropdown (type preservation)', () => {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'dropdown'));

    it('should preserve DropdownContainerProps type declaration', () => {
      const hasType = ir.fileTypeDeclarations.some(
        (t) => t.includes('DropdownContainerProps'),
      );
      expect(hasType).toBe(true);
    });

    it('should preserve TransitionContentProps type declaration', () => {
      const hasType = ir.fileTypeDeclarations.some(
        (t) => t.includes('TransitionContentProps'),
      );
      expect(hasType).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // List — render callback props (function returning ReactNode object)
  // -------------------------------------------------------------------------
  describe('List', () => {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'list'));

    it('should classify renderItem as a property, not a slot', () => {
      const renderItem = ir.props.find((p) => p.name === 'renderItem');
      expect(renderItem).toBeDefined();
      expect(renderItem!.category).toBe('property');
    });

    it('should mark renderItem as non-attribute (function prop)', () => {
      const renderItem = ir.props.find((p) => p.name === 'renderItem');
      expect(renderItem).toBeDefined();
      expect(renderItem!.attribute).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Wizard — zero-param expression-body arrow handler extraction
  // -------------------------------------------------------------------------
  describe('Wizard', () => {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'wizard'));

    it('should extract zero-param expression-body arrows as handlers', () => {
      // `const onPreviousClick = () => navigationEvent(...)` should be a handler
      const handler = ir.handlers.find((h) => h.name === 'onPreviousClick');
      expect(handler).toBeDefined();
      expect(handler!.body).toContain('return');
    });
  });

  // -------------------------------------------------------------------------
  // TagEditor — entry file as implementation when secondary has only helpers
  // -------------------------------------------------------------------------
  describe('TagEditor', () => {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'tag-editor'));

    it('should parse the tag-editor component', () => {
      // tag-editor has a complex structure: index.tsx has the main forwardRef
      // component, internal.tsx has TagControl and UndoButton helpers.
      expect(ir.name).toBeDefined();
      expect(ir.props.length).toBeGreaterThan(0);
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
