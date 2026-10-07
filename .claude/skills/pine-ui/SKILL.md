---
name: pine-ui
description: Use whenever building or editing UI in this EHR codebase (pages, components, forms, tables, dialogs). Enforces the Pine design system on Tailwind v4 + shadcn/ui.
---

# Pine UI

Pine is the EHR's design system: white, square, dark-inked, color rationed. The theme lives in `pine-theme.css`; the full guide and live specimen are `pine-design-guide.md` and `pine-design-guide.html`. Read the guide's relevant section when a rule below isn't enough.

## Build with

- shadcn/ui components from `components/ui/*`. Reuse them; do not hand-roll a dialog, menu, select, tabs, tooltip, calendar or table.
- TanStack Table (shadcn Data Table) for lists, react-hook-form + zod (shadcn `Form`) for forms, `Sonner` for toasts.
- Icons: `lucide-react`, `size={18}` `strokeWidth={1.75}`, 16px in tags and error lines.

## Tokens only

Use only Pine utilities. The default Tailwind palette, radii and shadows are removed, so off-system classes produce no CSS.

- Color: `surface`, `canvas`, `surface-hover|muted|active`, `ink`, `ink-2`, `ink-3`, `line`, `line-strong`, `pine-50|100|200|600|700|800`, `on-primary`, `focus`, `danger*`, `caution*`, `scrim`.
- Type: `text-display|h1|h2|h3|body-lg|body|label|small|caption`. Add `tabular-nums` to vitals, doses, dates, IDs.
- Size: `h-control-sm|md|lg`, `h-row-compact|row-default`, `w-sidebar`, `w-dialog-sm`. Spacing scale: 1, 2, 3, 4, 6, 8, 12.
- Shape: `rounded-none` (default; write nothing), `rounded-xs` checkbox only, `rounded-full` avatars only.
- Elevation: `shadow-overlay` on dialogs, menus, popovers, toasts. `shadow-sticky` on a sticky header once scrolled. Nothing else.
- Motion: `duration-fast` (hover, exit), `duration-base` (enter), `duration-slow` (sheets), `ease-standard`.

## Rules

1. **60/30/10.** White dominates. One `pine-600` filled button per view; everything else secondary or ghost. Never tint icons, headings, stats or card headers green.
2. **No light grey text.** Text is `ink` or `ink-2`. `ink-3` only for placeholders and disabled.
3. **Semantic color is clinical only.** `danger` / `caution` for critical results, allergies, interactions, invalid fields, destructive confirms. No success green, no info blue. Always pair with a word or icon.
4. **Headings:** page = breadcrumbs + `text-h1`, no subtitle. Card title `text-h3`. Dialog title `text-h2`.
5. **Cards:** `bg-surface p-6` on `bg-canvas`. No border, no shadow, never nested, two to four per page. A list of records is one card with a table.
6. **Separators:** only the `border-ink` rule under table headers and `border-line` between rows. Group with space and headings elsewhere.
7. **States:** a color step, never movement. Primary hover `pine-700`, press `pine-800`. Secondary/ghost hover `surface-hover`, press `surface-active`. Selected `bg-pine-50 text-pine-700`. Focus is the global 2px `focus` outline.
8. **Motion:** overlays fade + `slide-in-from-bottom-1`, `duration-base` in, `duration-fast` out. No zoom, scale, bounce or `transition-all`.
9. **Confirm** destructive, irreversible, legally binding or outbound actions (sign, send Rx, discontinue, delete, submit claim, void) with shadcn `AlertDialog`. Title = action + object as a question ("Discontinue metformin?"). One-sentence consequence. Buttons: ghost "Cancel", then the title's verb. `danger` only when removing or destroying.
10. **Flow:** breadcrumbs on every page below top level; patient banner (with allergies) pinned on patient pages; stepper for 3–5 step tasks, steps named with nouns.
11. **Copy:** sentence case, titles 1–4 words, buttons are verbs, no exclamation marks or emoji. "Note signed." not "Success!". Errors: what happened + what to do.

## Component recipes

```tsx
// Button variants (cva)
primary:   "bg-pine-600 text-on-primary hover:bg-pine-700 active:bg-pine-800"
secondary: "bg-surface text-ink shadow-[inset_0_0_0_1.5px_var(--color-ink)] hover:bg-surface-hover active:bg-surface-active" // default
ghost:     "text-ink hover:bg-surface-hover active:bg-surface-active"
danger:    "bg-danger text-on-primary hover:bg-danger-hover active:bg-danger-ink"
base:      "inline-flex items-center gap-2 h-control-md px-4 text-body font-semibold transition-colors duration-fast ease-standard disabled:bg-surface-active disabled:text-ink-3"

// Input / SelectTrigger
"h-control-md w-full border border-line-strong bg-surface px-3 text-body hover:border-ink-2 focus:outline-none focus:border-pine-600 focus:shadow-[inset_0_0_0_1px_var(--color-pine-600)] aria-invalid:border-danger"
// Label "text-label text-ink"  Hint "text-small text-ink-2"  Error "text-small text-danger-ink"

// Table
TableHead "h-9 text-label text-ink-2 border-b border-ink"
TableRow  "border-b border-line hover:bg-surface-hover data-[state=selected]:bg-pine-50"
TableCell "h-row-default px-3 first:pl-0 last:pr-0"   numeric: "text-right tabular-nums font-medium"

// Tag: "inline-flex h-[22px] items-center gap-1 px-2 text-caption"
// neutral bg-surface-muted text-ink · active bg-pine-50 text-pine-700 · caution bg-caution-bg text-caution-ink · critical bg-danger-bg text-danger-ink

// Overlay content
"bg-surface p-6 shadow-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-1 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 duration-base data-[state=closed]:duration-fast"
```

When adding a shadcn component, strip its `rounded-*`, `shadow-xs|sm`, `border` on cards/popovers, and `ring-[3px]` focus before use.

## Before you finish

Grep your diff and fix every hit:

- `rounded-` other than `rounded-none|xs|full`
- `shadow-` other than `shadow-overlay|sticky`; any `hover:shadow`
- `gray-|slate-|zinc-|neutral-|stone-|indigo|violet|purple|blue-|green-|emerald-|gradient`
- `scale-`, `-translate-y` on hover, `transition-all`
- more than one `variant="primary"` in a view
- `<Separator`, or `border-t`/`border-b` outside tables
- a `<p>` directly under an `h1` or card title acting as a subtitle
- sign / send / delete / discontinue / submit without `AlertDialog`
- text below 12px, or `text-ink-3` on anything but placeholders and disabled
