/**
 * Plugin that removes react-transition-group wrappers from generated Lit output.
 *
 * CSSTransition and TransitionGroup are React-specific animation wrappers
 * that toggle CSS classes on enter/exit. In Lit, the same CSS transitions
 * apply natively — the wrapper elements are unnecessary.
 */

import type { Plugin } from './index.js';

export function cssTransition(options?: { version?: string }): Plugin {
  return {
    package: 'react-transition-group',
    supportedVersions: options?.version ?? '>=4.0.0 <5.0.0',
    imports: ['CSSTransition', 'TransitionGroup'],

    transform(code: string, _componentName: string): string {
      let result = code;

      // Strip import lines for react-transition-group
      // Matches: import { CSSTransition } from 'react-transition-group';
      //          import { TransitionGroup } from 'react-transition-group';
      //          import { CSSTransition, TransitionGroup } from 'react-transition-group';
      result = result.replace(
        /import\s+(?:type\s+)?{[^}]*}\s+from\s+['"]react-transition-group['"];?\n?/g,
        '',
      );

      // Strip <CSSTransition ...> opening tags (self-closing or normal)
      // The tag may span multiple lines and have various attributes
      result = result.replace(/<CSSTransition\b[^>]*\/?>/g, '');

      // Strip </CSSTransition> closing tags
      result = result.replace(/<\/CSSTransition>/g, '');

      // Strip <TransitionGroup ...> opening tags
      result = result.replace(/<TransitionGroup\b[^>]*\/?>/g, '');

      // Strip </TransitionGroup> closing tags
      result = result.replace(/<\/TransitionGroup>/g, '');

      // Also handle Lit template versions: <el-csstransition> and <el-transitiongroup>
      result = result.replace(/<el-csstransition\b[^>]*\/?>/g, '');
      result = result.replace(/<\/el-csstransition>/g, '');
      result = result.replace(/<el-transitiongroup\b[^>]*\/?>/g, '');
      result = result.replace(/<\/el-transitiongroup>/g, '');

      // Clean up any resulting blank lines (collapse multiple to one)
      result = result.replace(/\n{3,}/g, '\n\n');

      return result;
    },
  };
}
