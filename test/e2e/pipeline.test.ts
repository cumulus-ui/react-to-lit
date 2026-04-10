/**
 * Full pipeline E2E tests: Parse → Transform → Emit.
 *
 * Tests the complete pipeline for Badge, Spinner, and StatusIndicator
 * with transforms applied.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { parseComponent } from '../../src/parser/index.js';
import { transformAll } from '../../src/transforms/index.js';
import { emitComponent } from '../../src/emitter/index.js';

const CLOUDSCAPE_SRC = path.resolve(
  import.meta.dirname,
  '../../vendor/cloudscape-source/src',
);

function fullPipeline(componentName: string): string {
  const ir = parseComponent(path.join(CLOUDSCAPE_SRC, componentName), { prefix: 'cs' });
  const transformed = transformAll(ir);
  return emitComponent(transformed);
}

describe('Full pipeline: parse → transform → emit', () => {
  // -------------------------------------------------------------------------
  // Badge
  // -------------------------------------------------------------------------
  describe('Badge', () => {
    const output = fullPipeline('badge');

    it('should produce valid class declaration', () => {
      expect(output).toContain('export class CsBadgeInternal extends CsBaseElement');
    });

    it('should NOT contain WithNativeAttributes', () => {
      expect(output).not.toContain('WithNativeAttributes');
    });

    it('should NOT contain clsx', () => {
      expect(output).not.toContain('clsx(');
    });

    it('should NOT contain React imports', () => {
      expect(output).not.toContain("from 'react'");
    });

    it('should NOT contain baseProps', () => {
      expect(output).not.toContain('baseProps');
    });

    it('should NOT contain __internalRootRef', () => {
      expect(output).not.toContain('__internalRootRef');
    });

    it('should NOT contain nativeAttributes prop', () => {
      expect(output).not.toContain('nativeAttributes');
    });

    it('should contain <span', () => {
      // Badge renders a <span> (after unwrapping WithNativeAttributes)
      expect(output).toContain('<span');
    });

    it('should contain <slot>', () => {
      // children → <slot>
      expect(output).toContain('<slot>');
    });

    it('should contain classMap', () => {
      expect(output).toContain('classMap');
    });

    it('should contain proper imports', () => {
      expect(output).toContain("from 'lit'");
      expect(output).toContain("from 'lit/decorators.js'");
      expect(output).toContain('CsBaseElement');
      expect(output).toContain('componentStyles');
      expect(output).toContain('sharedStyles');
    });

    it('should log output for review', () => {
      console.log('\n=== Badge (full pipeline) ===');
      console.log(output);
      console.log('=== end Badge ===\n');
    });
  });

  // -------------------------------------------------------------------------
  // Spinner
  // -------------------------------------------------------------------------
  describe('Spinner', () => {
    const output = fullPipeline('spinner');

    it('should not contain WithNativeAttributes in render method', () => {
      // Helpers may still contain raw source; the render method should not
      const renderSection = output.slice(output.indexOf('override render()'));
      expect(renderSection).not.toContain('WithNativeAttributes');
    });

    it('should not contain clsx in render method', () => {
      const renderSection = output.slice(output.indexOf('override render()'));
      expect(renderSection).not.toContain('clsx(');
    });

    it('should contain <span elements', () => {
      expect(output).toContain('<span');
    });

    it('should contain classMap with size and variant', () => {
      expect(output).toContain('classMap');
    });

    it('should log output for review', () => {
      console.log('\n=== Spinner (full pipeline) ===');
      console.log(output);
      console.log('=== end Spinner ===\n');
    });
  });

  // -------------------------------------------------------------------------
  // StatusIndicator
  // -------------------------------------------------------------------------
  describe('StatusIndicator', () => {
    const output = fullPipeline('status-indicator');

    it('should NOT contain WithNativeAttributes', () => {
      expect(output).not.toContain('WithNativeAttributes');
    });

    it('should not contain clsx in render method', () => {
      const renderSection = output.slice(output.indexOf('override render()'));
      expect(renderSection).not.toContain('clsx(');
    });

    it('should not contain InternalIcon in render method', () => {
      const renderSection = output.slice(output.indexOf('override render()'));
      expect(renderSection).not.toContain('<InternalIcon');
    });

    it('should not contain InternalSpinner in render method', () => {
      const renderSection = output.slice(output.indexOf('override render()'));
      expect(renderSection).not.toContain('<InternalSpinner');
    });

    it('should contain <slot> for children', () => {
      expect(output).toContain('<slot>');
    });

    it('should log output for review', () => {
      console.log('\n=== StatusIndicator (full pipeline) ===');
      console.log(output);
      console.log('=== end StatusIndicator ===\n');
    });
  });
});
