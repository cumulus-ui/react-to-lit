/**
 * Plugin system for react-to-lit.
 *
 * Plugins handle third-party React libraries that need special treatment
 * during compilation. Each plugin declares which npm package and imports
 * it handles, then provides a string-based transform that runs on the
 * emitted component code.
 */

// ---------------------------------------------------------------------------
// Plugin interface
// ---------------------------------------------------------------------------

export interface Plugin {
  /** npm package this plugin handles (e.g. 'react-transition-group') */
  package: string;
  /** semver range of supported versions */
  supportedVersions: string;
  /** Named imports this plugin handles (e.g. ['CSSTransition', 'TransitionGroup']) */
  imports: string[];
  /** Transform the generated component source code. Applied after emission. */
  transform: (code: string, componentName: string) => string;
}
