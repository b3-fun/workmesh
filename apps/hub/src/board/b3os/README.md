# B3OS console components, vendored

The board is a B3OS console surface built from the console's own component library. Everything in this folder except
the files listed under "Bullpen's own" is a verbatim copy, at the same path, of `b3-fun/b3os-beta`
`apps/web/src/` at **`65e00f860`** (origin/main, 2026-11-24). Paths mirror the source, so every relative import
resolves unchanged. Do not edit these files; take a newer copy instead:

```sh
git -C ~/Documents/b3/b3os-beta archive 65e00f860 apps/web/src | tar -x -C <tmp>
```

What came over is the import closure of these entries (85 files): the foundation kit's `page-reveal`, `attention`,
`charts/frame` (`InlineError`), `status`, `dialog`, `drawer`, `copy`, `empty-state`, `page-header`, `ticker`
(`Figure`, `FigureStrip`), `cards` (`RowCard`), `wait`; the signature `pixel-grid` and `animated-checkmark`; the
`switch` primitive; the console's `app/ui/primitives.tsx` and `app/ui/AuthCard.tsx`; the shell's `ThemeSwitch` and
`triggers`; `lib/theme-bootstrap.ts`; `ds/layout/page-column.tsx`; `ui/Icon.tsx`; and the stylesheets
`ds/core.css`, `styles/index.css` (with `theme.css`, `tokens.css`, `ds-theme.css`, `ds.css`, `recipes.css`,
`theme-vars.css`) and `styles/app.css`. The tokens are the console's, unchanged.

Also from the same commit: `apps/web/public/assets/fonts/*.woff2` (Inter Display, Open Runde) and the three brand
masks in `apps/web/public/brand/`, in `src/board/public/`.

## Bullpen's own

| File | Why |
|---|---|
| `api/client.ts` | Shim: `ApiError` and `describeError` as the console's, for Bullpen's hub (`{ error }` bodies, `cf-ray` as the request id). |
| `app/Shell.tsx` | Shim: the two names the auth card imports (`ThemeSwitch`, and `MockRibbon`, which draws nothing: no mock mode). |
| `content/site.ts` | Shim: `B3IQ_URL`. |
| `ds/lib/icons.tsx` | Shim: the eight licensed icons the vendored files name, re-exported from `vendor/`. |
| `vendor/nucleo-ui-outline-18/` | Those eight icon files and `Icon.js`, copied from the published `nucleo-ui-outline-18@1.4.0` package (licensed to Sean; no install script run, no key read or needed), with a `.d.ts` saying their types. |

The npm packages the vendored files import are pinned in `package.json` at the beta's versions (wouter, Radix, vaul,
NumberFlow, clsx, tailwind-merge, class-variance-authority, web-haptics, tw-animate-css, Geist).

Bullpen's board itself (`src/board/components`, `src/board/shell`) is drawn from these components and classes; the
design rules it follows are the console's (`apps/web/docs/design-rules.md` at the same commit).
