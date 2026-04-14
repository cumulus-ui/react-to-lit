/**
 * End-to-end tests: Parse real Cloudscape components → Emit Lit TypeScript.
 *
 * Tests the full pipeline for simple components (Badge, Spinner, StatusIndicator).
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { parseComponent } from '../../src/parser/index.js';
import { emitComponent } from '../../src/emitter/index.js';

const CLOUDSCAPE_SRC = path.resolve(
  import.meta.dirname,
  '../../vendor/cloudscape-source/src',
);

describe('E2E: parse → emit', () => {
  // -------------------------------------------------------------------------
  // Badge
  // -------------------------------------------------------------------------
  describe('Badge', () => {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'badge'));
    const output = emitComponent(ir);

    it('should produce non-empty output', () => {
      expect(output.length).toBeGreaterThan(0);
    });

    it('should contain class declaration', () => {
      expect(output).toContain('export class CsBadgeInternal extends LitElement');
    });

    it('should contain static styles', () => {
      expect(output).toContain('static override styles');
      expect(output).toContain('sharedStyles');
      expect(output).toContain('componentStyles');
    });

    it('should contain @property for color', () => {
      expect(output).toContain('@property(');
      expect(output).toContain('color');
    });

    it('should contain render method', () => {
      expect(output).toContain('override render()');
      expect(output).toContain('html');
    });

    it('should import from lit', () => {
      expect(output).toContain("from 'lit'");
      expect(output).toContain("from 'lit/decorators.js'");
    });

    it('should import base element', () => {
      expect(output).toContain('LitElement');
    });

    it('should import styles', () => {
      expect(output).toContain("from './styles.js'");
    });

    it('should import prop types', () => {
      expect(output).toContain('BadgeProps');
    });

    it('should not contain React imports', () => {
      const code = output.replace(/\/\/.*$/gm, '');
      expect(code).not.toContain("from 'react'");
    });

    it('should log output for manual review', () => {
      console.log('\n--- Badge output ---');
      console.log(output);
      console.log('--- end Badge ---\n');
    });
  });

  // -------------------------------------------------------------------------
  // Spinner
  // -------------------------------------------------------------------------
  describe('Spinner', () => {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'spinner'));
    const output = emitComponent(ir);

    it('should contain class declaration', () => {
      expect(output).toContain('export class CsSpinnerInternal extends LitElement');
    });

    it('should contain properties for size and variant', () => {
      expect(output).toContain('size');
      expect(output).toContain('variant');
    });

    it('should contain render method with template', () => {
      expect(output).toContain('override render()');
      expect(output).toContain('html');
      expect(output).toContain('span');
    });

    it('should log output for manual review', () => {
      console.log('\n--- Spinner output ---');
      console.log(output);
      console.log('--- end Spinner ---\n');
    });
  });

  // -------------------------------------------------------------------------
  // StatusIndicator
  // -------------------------------------------------------------------------
  describe('StatusIndicator', () => {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'status-indicator'));
    const output = emitComponent(ir);

    it('should contain class declaration', () => {
      expect(output).toContain('export class CsStatusIndicatorInternal extends LitElement');
    });

    it('should contain type property', () => {
      expect(output).toContain('type');
      expect(output).toContain("'success'");
    });

    it('should contain wrapText boolean property', () => {
      expect(output).toContain('wrapText');
      expect(output).toContain('Boolean');
    });

    it('should contain render method', () => {
      expect(output).toContain('override render()');
    });

    it('should not contain JSX helpers', () => {
      // JSX-containing helpers are filtered out
      expect(output).not.toMatch(/<InternalIcon/);
    });

    it('should log output for manual review', () => {
      console.log('\n--- StatusIndicator output ---');
      console.log(output);
      console.log('--- end StatusIndicator ---\n');
    });
  });
});
