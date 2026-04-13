/**
 * Unit tests for emitter/lifecycle.ts — lifecycle method emission.
 */
import { describe, it, expect } from 'vitest';
import { emitLifecycle } from '../../src/emitter/lifecycle.js';
import type { EffectIR } from '../../src/ir/types.js';
import type { DeferredInit } from '../../src/emitter/properties.js';

describe('emitLifecycle', () => {
  describe('expression-body cleanup return stripping', () => {
    it('strips return () => expr; from willUpdate body', () => {
      const effects: EffectIR[] = [{
        body: `{
          this._onKeyDown = this._model.handlers.onDocumentKeyDown;
          document.addEventListener('keydown', this._onKeyDown);
          return () => document.removeEventListener('keydown', this._onKeyDown);
        }`,
        deps: ['model.handlers.onDocumentKeyDown'],
        cleanup: "document.removeEventListener('keydown', this._onKeyDown)",
      }];
      const result = emitLifecycle(effects);
      // Should NOT contain `return () =>` in willUpdate
      expect(result).not.toMatch(/return\s+\(\)\s*=>/);
      // Should still contain the addEventListener
      expect(result).toContain('addEventListener');
      // Should have disconnectedCallback with cleanup
      expect(result).toContain('disconnectedCallback');
      expect(result).toContain('removeEventListener');
    });

    it('strips return () => clearTimeout(ref) from willUpdate', () => {
      const effects: EffectIR[] = [{
        body: `{
          this._debounceTimeoutRef = setTimeout(() => {
            this._debouncedCharacterCountText = this.characterCountText;
          }, 300);
          return () => clearTimeout(this._debounceTimeoutRef);
        }`,
        deps: ['characterCountText'],
        cleanup: 'clearTimeout(this._debounceTimeoutRef)',
      }];
      const result = emitLifecycle(effects);
      expect(result).not.toMatch(/return\s+\(\)\s*=>/);
      expect(result).toContain('setTimeout');
    });

    it('still strips block-body cleanup returns', () => {
      const effects: EffectIR[] = [{
        body: `{
          const handler = () => console.log('tick');
          const id = setInterval(handler, 1000);
          return () => {
            clearInterval(id);
            console.log('cleaned');
          };
        }`,
        deps: 'empty',
        cleanup: 'clearInterval(id); console.log("cleaned");',
      }];
      const result = emitLifecycle(effects);
      // connectedCallback should NOT have the return
      expect(result).not.toMatch(/return\s+\(\)\s*=>/);
      expect(result).toContain('setInterval');
    });
  });

  describe('deferred initializations', () => {
    it('emits firstUpdated with deferred inits when no layout effects', () => {
      const effects: EffectIR[] = [];
      const deferred: DeferredInit[] = [
        { assignment: 'this._isPersistentlyDismissed = !!(this.persistenceConfig && this.persistenceConfig.uniqueKey);' },
      ];
      const result = emitLifecycle(effects, deferred);
      expect(result).toContain('firstUpdated');
      expect(result).toContain('this._isPersistentlyDismissed');
    });

    it('merges deferred inits with layout mount effects in firstUpdated', () => {
      const effects: EffectIR[] = [{
        body: 'console.log("mounted");',
        deps: 'empty',
        isLayout: true,
      }];
      const deferred: DeferredInit[] = [
        { assignment: 'this._value = this.defaultValue;' },
      ];
      const result = emitLifecycle(effects, deferred);
      expect(result).toContain('firstUpdated');
      expect(result).toContain('this._value = this.defaultValue');
      expect(result).toContain('console.log("mounted")');
    });

    it('does not emit firstUpdated when no deferred inits and no layout effects', () => {
      const effects: EffectIR[] = [];
      const result = emitLifecycle(effects, []);
      expect(result).not.toContain('firstUpdated');
    });
  });
});
