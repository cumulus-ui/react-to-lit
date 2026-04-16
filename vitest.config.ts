import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@cloudscape-design/component-toolkit': path.resolve(
        import.meta.dirname,
        '../components/node_modules/@cloudscape-design/component-toolkit'
      ),
      '@cloudscape-design/collection-hooks': path.resolve(
        import.meta.dirname,
        '../components/node_modules/@cloudscape-design/collection-hooks'
      ),
      'date-fns': path.resolve(
        import.meta.dirname,
        '../components/node_modules/date-fns'
      ),
      'd3-shape': path.resolve(
        import.meta.dirname,
        '../components/node_modules/d3-shape'
      ),
      'ace-builds': path.resolve(
        import.meta.dirname,
        '../components/node_modules/ace-builds'
      ),
      '@floating-ui/dom': path.resolve(
        import.meta.dirname,
        '../components/node_modules/@floating-ui/dom'
      ),
      '@cumulus-ui/design-tokens': path.resolve(
        import.meta.dirname,
        '../components/node_modules/@cumulus-ui/design-tokens'
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
