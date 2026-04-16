import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  warnOnce,
  _resetWarnOnce,
  getIsRtl,
  findUpUntil,
  nodeContains,
  getLogicalBoundingClientRect,
  KeyCode,
} from '../../src/shims/component-toolkit.js';

describe('component-toolkit shims', () => {
  describe('warnOnce', () => {
    beforeEach(() => _resetWarnOnce());

    it('warns on first call', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      warnOnce('Alert', 'something broke');
      expect(spy).toHaveBeenCalledWith('[Alert] something broke');
      spy.mockRestore();
    });

    it('suppresses duplicate warnings', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      warnOnce('Alert', 'dup');
      warnOnce('Alert', 'dup');
      warnOnce('Alert', 'dup');
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('allows different messages', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      warnOnce('A', 'one');
      warnOnce('B', 'two');
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    });
  });

  describe('KeyCode', () => {
    it('has expected keyboard constants', () => {
      expect(KeyCode.enter).toBe(13);
      expect(KeyCode.space).toBe(32);
      expect(KeyCode.tab).toBe(9);
      expect(KeyCode.escape).toBe(27);
      expect(KeyCode.up).toBe(38);
      expect(KeyCode.down).toBe(40);
      expect(KeyCode.left).toBe(37);
      expect(KeyCode.right).toBe(39);
      expect(KeyCode.home).toBe(36);
      expect(KeyCode.end).toBe(35);
      expect(KeyCode.pageUp).toBe(33);
      expect(KeyCode.pageDown).toBe(34);
      expect(KeyCode.backspace).toBe(8);
    });
  });

  describe('getIsRtl', () => {
    it('is a function', () => {
      expect(typeof getIsRtl).toBe('function');
    });
  });

  describe('findUpUntil', () => {
    it('is a function', () => {
      expect(typeof findUpUntil).toBe('function');
    });
  });

  describe('nodeContains', () => {
    it('returns false for null inputs', () => {
      expect(nodeContains(null, null)).toBe(false);
      expect(nodeContains(null, {} as Node)).toBe(false);
      expect(nodeContains({} as Node, null)).toBe(false);
    });
  });

  describe('getLogicalBoundingClientRect', () => {
    it('is a function', () => {
      expect(typeof getLogicalBoundingClientRect).toBe('function');
    });
  });
});
