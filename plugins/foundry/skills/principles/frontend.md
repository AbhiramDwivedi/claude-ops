# frontend pack

Use this pack for any change that touches code running in a browser or another UI runtime: components, client state, styles, routing, the client bundle. It extends the core pack and assumes a component-based UI, whatever the framework. Examples use JSX names where a name helps; the rules apply the same way to Vue, Svelte or web components.

## Rules

1. A variant of a component is built by composing children or slots; no new boolean prop switches between two layouts.
   Test: no prop added in the diff (`is*`, `show*`, `mode`, `variant`) selects between two different render trees inside one component.
2. Data flows down through props and changes flow up through callbacks or events; a component never mutates a prop.
   Test: no component in the diff assigns to a field of a prop or calls a mutating method (`push`, `splice`, `sort`) on one.
3. State lives in the lowest component that all its readers share.
   Test: no store or context entry in the diff is read by only one component.
4. A value that can be derived from props or other state is computed during render and never stored as its own state.
   Test: no state in the diff is set only from another state or prop inside an effect or watcher.
5. Server data goes through one fetching layer that owns caching and refetching; components don't copy responses into a global store.
   Test: no fetch or HTTP client call in a component file outside the fetching layer, and no store action in the diff saves a response verbatim.
6. Every view that depends on fetched data renders a loading state, an empty state and an error state.
   Test: each new data-dependent component in the diff has a visible branch for loading, empty and error.
7. App code imports design-system components only from the design system's public entry point.
   Test: grep the diff for imports into the design system's internal paths (`/src/`, `/internal/`, a file inside a component folder); there are none.
8. The design system knows nothing about the app: no routes, API calls, feature flags or domain types.
   Test: design-system files in the diff import nothing from app modules and make no network calls.
9. Colors, spacing, type sizes and radii come from design tokens.
   Test: grep the diff's styles for raw hex or rgb colors and literal pixel sizes outside the token files; there are none.
10. Every interactive element is a native control (`button`, `a`, `input`, `select`) or has a role, a tab stop, a keyboard handler and a visible focus style.
   Test: no click handler on a `div` or `span` in the diff lacks `role`, `tabIndex` and a key handler, and no style in the diff removes the focus outline without a replacement.
11. Every image, icon-only button and form field has an accessible name.
   Test: each new `img` has `alt`, each icon-only button has `aria-label` or visible text, and each input has a linked `label`.
12. An automated accessibility check (WCAG 2.2 AA, including color contrast) runs in CI over the changed pages and blocks on violations.
   Test: the CI config runs an accessibility checker such as axe over the pages the diff touches, and the step fails the build on any violation.
13. Each route has a performance budget in a checked-in config, and CI fails the build when a route exceeds it.
   Test: a budget file (bundle size per route, or Core Web Vitals thresholds) exists in the repo and a CI step reads it.
14. A new client-side dependency fits the route budgets from rule 13, and code not needed for the first screen loads through a dynamic import.
   Test: a diff that adds a dependency to the client lockfile raises no limit in the budget file, and each route and dialog the diff adds loads through a dynamic `import()`.

## Notes

Rules 3 and 4 apply core's cohesion rule to UI state. Rules 7 and 8 apply core's interfaces-at-the-edge rule to the design system. Drop rule 12 or 13 only with a reason in the architecture doc, for example an internal tool with no public users.
