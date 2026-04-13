/**
 * Unit tests for prop classification logic in parser/props.ts.
 *
 * Tests the classifyProp function directly to verify correct
 * categorization of React prop types into Lit equivalents.
 */
import { describe, it, expect } from 'vitest';
import { classifyProp } from '../../src/parser/props.js';

describe('classifyProp', () => {
  // -------------------------------------------------------------------------
  // Slot detection (#19)
  // -------------------------------------------------------------------------

  describe('slot classification', () => {
    it('classifies children as slot regardless of type', () => {
      const result = classifyProp('children', 'ReactNode');
      expect(result.category).toBe('slot');
    });

    it('classifies bare ReactNode prop as slot', () => {
      const result = classifyProp('description', 'ReactNode');
      expect(result.category).toBe('slot');
    });

    it('classifies ReactNode | null as slot', () => {
      const result = classifyProp('header', 'ReactNode | null');
      expect(result.category).toBe('slot');
    });

    it('classifies ReactElement as slot', () => {
      const result = classifyProp('icon', 'ReactElement');
      expect(result.category).toBe('slot');
    });

    it('classifies pure function returning ReactNode as property, not slot', () => {
      const result = classifyProp('renderItem', '(item: T) => ReactNode');
      expect(result.category).toBe('property');
      expect(result.attribute).toBe(false);
    });

    it('classifies ReactNode | function union as property, not slot (#19)', () => {
      const result = classifyProp('content', 'ReactNode | ((item: T) => ReactNode)');
      expect(result.category).toBe('property');
      expect(result.attribute).toBe(false);
    });

    it('classifies function | ReactNode union as property, not slot (#19)', () => {
      const result = classifyProp('fallback', '(() => ReactNode) | ReactNode');
      expect(result.category).toBe('property');
      expect(result.attribute).toBe(false);
    });

    it('classifies ReactNode | (() => ReactNode) | null union as property (#19)', () => {
      const result = classifyProp('content', 'ReactNode | (() => ReactNode) | null');
      expect(result.category).toBe('property');
      expect(result.attribute).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Event detection
  // -------------------------------------------------------------------------

  describe('event classification', () => {
    it('classifies onChange as event', () => {
      const result = classifyProp('onChange', 'NonCancelableEventHandler<ChangeDetail>');
      expect(result.category).toBe('event');
    });

    it('classifies onFollow as event', () => {
      const result = classifyProp('onFollow', 'CancelableEventHandler<FollowDetail>');
      expect(result.category).toBe('event');
      expect(result.eventCancelable).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Basic type detection
  // -------------------------------------------------------------------------

  describe('basic type classification', () => {
    it('classifies boolean prop as attribute', () => {
      const result = classifyProp('disabled', 'boolean');
      expect(result.category).toBe('attribute');
      expect(result.litType).toBe('Boolean');
    });

    it('classifies string prop as attribute', () => {
      const result = classifyProp('label', 'string');
      expect(result.category).toBe('attribute');
      expect(result.litType).toBe('String');
    });

    it('classifies number prop as attribute', () => {
      const result = classifyProp('count', 'number');
      expect(result.category).toBe('attribute');
      expect(result.litType).toBe('Number');
    });

    it('classifies array type as property', () => {
      const result = classifyProp('items', 'ReadonlyArray<T>');
      expect(result.category).toBe('property');
      expect(result.litType).toBe('Array');
    });
  });
});
