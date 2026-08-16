# ADR 001: HTML Syntax Highlighting in Template Literals

## Status
Accepted

## Context
The UI components in `ui/components.ts` are implemented as template strings. Without specialized highlighting, the HTML, CSS, and JavaScript within these strings are treated as plain text, which reduces readability and increases the likelihood of syntax errors.

Converting to TSX would provide better tooling but introduces a dependency on a JSX runtime (e.g., Preact) and requires a more complex build/render pipeline, which is unnecessary for the current simple dashboard.

## Decision
We will use the `/* html */` magic comment prefix before template literals that contain HTML content. 

This convention is supported by modern editors (including Zed) via Tree-sitter to trigger injected language highlighting, providing an "IDE-like" experience for HTML without leaving the TypeScript file or adding runtime overhead.

## Consequences
- **Positive**: Immediate improvement in readability and syntax highlighting.
- **Positive**: Zero runtime impact and no new dependencies.
- **Positive**: Keeps the UI layer simple and framework-free.
- **Negative**: Highlighting is dependent on the editor's support for the magic comment convention.
