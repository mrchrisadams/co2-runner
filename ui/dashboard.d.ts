// ui/dashboard.d.ts — type declaration for the raw-text import of
// ui/dashboard.js (imported by ui/components.ts with `{ type: "text" }`).
// TypeScript needs this so `tsc --noEmit` resolves the .js specifier to a
// string module rather than reporting TS7016.

declare const dashboardJs: string;
export default dashboardJs;
