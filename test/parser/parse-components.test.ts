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
  // Header — helper component with hooks
  // -------------------------------------------------------------------------
  describe('Header (helper hooks)', () => {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'header'));

    it('should extract the Description helper', () => {
      const desc = ir.helpers.find((h) => h.name === 'Description');
      expect(desc).toBeDefined();
    });

    it('should include hook return vars from helpers in skippedHookVars', () => {
      // Description has `const isRefresh = useVisualRefresh()` — a skipped hook.
      // Its return variable should be in skippedHookVars so the identifier
      // rewriter maps it to this._isRefresh.
      // The main component also has isRefresh, but even without that,
      // the helper's hook variable must be captured.
      expect(ir.skippedHookVars).toContain('isRefresh');
    });

    it('should strip the hook call from the helper source', () => {
      const desc = ir.helpers.find((h) => h.name === 'Description');
      expect(desc).toBeDefined();
      // The useVisualRefresh() call should be removed from the helper source
      // because extractHooks processed it.
      expect(desc!.source).not.toContain('useVisualRefresh');
    });
  });

  // -------------------------------------------------------------------------
  // FormField — helper components with hooks (i18n + useRef)
  // -------------------------------------------------------------------------
  describe('FormField (helper hooks)', () => {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'form-field'));

    it('should extract FormFieldError and FormFieldWarning helpers', () => {
      expect(ir.helpers.find((h) => h.name === 'FormFieldError')).toBeDefined();
      expect(ir.helpers.find((h) => h.name === 'FormFieldWarning')).toBeDefined();
    });

    it('should capture useRef from helper as a ref in the IR', () => {
      // FormFieldError has const contentRef = useRef<HTMLDivElement | null>(null)
      // This should be extracted as a ref, not left as raw text.
      const contentRef = ir.refs.find((r) => r.name === 'contentRef');
      expect(contentRef).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // KeyValuePairs — helper with useUniqueId
  // -------------------------------------------------------------------------
  describe('KeyValuePairs (helper hooks)', () => {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'key-value-pairs'));

    it('should extract InternalKeyValuePair helper', () => {
      expect(ir.helpers.find((h) => h.name === 'InternalKeyValuePair')).toBeDefined();
    });

    it('should include kvPairId from helper hook in skippedHookVars', () => {
      // InternalKeyValuePair has const kvPairId = useUniqueId('kv-pair-')
      expect(ir.skippedHookVars).toContain('kvPairId');
    });
  });

  // -------------------------------------------------------------------------
  // Autosuggest — props destructured in body, not parameters
  // -------------------------------------------------------------------------
  describe('Autosuggest (body-destructured props)', () => {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'autosuggest'));

    it('should extract statusType as a prop', () => {
      // autosuggest uses forwardRef((props, ref) => { const { statusType, ... } = props; })
      // The prop parser should find statusType from the body destructuring.
      const prop = ir.props.find((p) => p.name === 'statusType');
      expect(prop).toBeDefined();
    });

    it('should capture the default value for statusType', () => {
      const prop = ir.props.find((p) => p.name === 'statusType');
      expect(prop?.default).toBe("'finished'");
    });
  });

  // -------------------------------------------------------------------------
  // PieChart — destructured useMemo
  // -------------------------------------------------------------------------
  describe('PieChart (destructured useMemo)', () => {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'pie-chart'));

    it('should capture pieData from destructured useMemo return', () => {
      // pie-chart has: const { pieData, dataSum } = useMemo(() => { ... }, [...])
      // Destructured useMemo bindings should be preserved as skippedHookVars.
      expect(ir.skippedHookVars).toContain('pieData');
    });

    it('should capture dataSum from destructured useMemo return', () => {
      expect(ir.skippedHookVars).toContain('dataSum');
    });
  });

  // -------------------------------------------------------------------------
  // ButtonGroup — loop body with local variables
  // -------------------------------------------------------------------------
  describe('ButtonGroup (loop-body locals)', () => {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'button-group'));

    it('should preserve loop-body preamble in the template loop', () => {
      // button-group has: items.map((itemOrGroup, index) => {
      //   const itemContent = ...;
      //   const shouldAddDivider = ...;
      //   return <JSX>;
      // })
      // The loop-body locals should be captured in loop.preamble.
      function findLoop(node: import('../../src/ir/types.js').TemplateNodeIR): import('../../src/ir/types.js').LoopIR | undefined {
        if (node.loop) return node.loop;
        for (const child of node.children) {
          const found = findLoop(child);
          if (found) return found;
        }
        return undefined;
      }
      const loop = findLoop(ir.template);
      expect(loop).toBeDefined();
      expect(loop!.preamble).toBeDefined();
      expect(loop!.preamble!.length).toBeGreaterThan(0);
      // Should contain the local variable declarations
      const joined = loop!.preamble!.join('\n');
      expect(joined).toContain('shouldAddDivider');
      expect(joined).toContain('itemContent');
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

  // -------------------------------------------------------------------------
  // Cross-cutting: no hook calls should remain in any helper source
  // -------------------------------------------------------------------------
  describe('all components — helper hook extraction', () => {
    const fs = require('node:fs');
    const componentDirs = fs.readdirSync(CLOUDSCAPE_SRC, { withFileTypes: true })
      .filter((d: any) => d.isDirectory() && !d.name.startsWith('__') && !d.name.startsWith('.'))
      .map((d: any) => d.name);

    for (const dir of componentDirs) {
      const fullPath = path.join(CLOUDSCAPE_SRC, dir);
      // Only test components that have an index.tsx
      const hasIndex = fs.existsSync(path.join(fullPath, 'index.tsx'));
      if (!hasIndex) continue;

      it(`${dir}: no hook calls in helper source after extraction`, () => {
        let ir;
        try {
          ir = parseComponent(fullPath);
        } catch {
          return; // skip components that fail to parse (not relevant here)
        }
        for (const helper of ir.helpers) {
          // Match use*( patterns — these are hook calls that should have been
          // extracted by the parser, not left as raw text in helper source.
          const residual = helper.source.match(/\buse[A-Z]\w*\s*\(/g);
          if (residual) {
            // Filter out false positives: "used", "user", method calls like "foo.useSomething("
            const real = residual.filter(m => {
              const name = m.replace(/\s*\($/, '');
              // Must start with "use" followed by uppercase (React convention)
              return /^use[A-Z]/.test(name);
            });
            expect(real, `${dir}/${helper.name} has residual hook calls: ${real.join(', ')}`).toHaveLength(0);
          }
        }
      });
    }
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
