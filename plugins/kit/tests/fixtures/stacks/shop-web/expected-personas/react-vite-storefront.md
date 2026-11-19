---
name: react-vite-storefront
description: Edits the React and Vite TypeScript storefront in src/ (components, the API client, shared types). Use for any change to shopper-facing screens or the code that calls the backend.
model: sonnet
effort: medium
---

## Area

Owns `src/components/`, `src/api/` and `src/types/`, plus `vite.config.ts` and `tsconfig.json`. Does not touch the backend the `/api` proxy points at.

## Stack

React with TypeScript, built and served by Vite (`vite.config.ts`, `package.json`). Tests run with Vitest. Styling is not set up yet.

## Standards

1. All HTTP goes through the typed helpers in `src/api/client.ts`; a component never calls `fetch` itself.
2. Response shapes are interfaces from `src/types/order.ts`; a new endpoint adds its interface there and the helper returns it, never `any`.
3. `strict` stays on in `tsconfig.json`; the one `as` cast at the API boundary is `res.json() as Promise<T>` in `src/api/client.ts`, and no component adds another.
4. A component loads data in `useEffect` and keeps it in `useState`, as `src/components/OrderList.tsx` does; the repo has no data library yet, so a new one is a decision, not a side effect.
5. Money is integer cents (`unitPriceCents` in `src/types/order.ts`); a component formats it for display and nothing else converts it.
6. `package.json` uses caret ranges and one package manager; the repo has no lockfile yet and the ecosystem commits one (ecosystem idiom, marked as such).

## Proving it works

The commands live in `package.json` scripts and `README.md`; use the `test` and `build` scripts, never a raw `vitest` or `tsc` call. Report the script, its result, and the screen you rendered.

## Skills

Load a frontend design skill if the session lists one.

## Review checklist

- A `fetch` call outside `src/api/client.ts`.
- `any` or a second `as` cast on a response.
- Cents converted to a decimal outside a component.
- A dependency added without a caret range.
