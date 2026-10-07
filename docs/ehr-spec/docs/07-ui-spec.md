# UI spec: screens, elements and navigation

`spec/ui/*.yaml` describes every screen in `spec/screens.yaml` as something you can build:
its route, its layout pattern, its named regions and elements, the views it opens (drawers, modals, panes),
and every navigation edge in and out. It is the bridge between the structural spec (screens, flows, states)
and the wireframes (`Clinic EHR Wireframes` canvas).

Precedence: `02-invariants.md` > `states.yaml` > `flows.yaml` > `screens.yaml` > **`ui/*.yaml`** > wireframes.
If the wireframe and the UI spec disagree, the UI spec wins and the wireframe is out of date.

## Files

| File | Holds |
|---|---|
| `spec/ui/patterns.yaml` | Reusable layouts (app shell, chart context, encounter workspace, list-detail, inbox, drawer, modal…). Regions and the elements every screen of that pattern gets for free. |
| `spec/ui/nav.yaml` | Global navigation: left rail, top bar, command bar, role defaults, and the back/up/close rules. |
| `spec/ui/<module>.yaml` | One entry per screen in that module. |
| `docs/06-navigation.md` | Generated. Mermaid diagrams of every navigation edge, plus incoming links per screen. Do not edit. |
| `docs/08-backend-needs.md` | Generated. Per screen: data it reads, actions it writes, and server logic it depends on. Use it to map the UI to your existing APIs. Do not edit. |

Run `npm run validate` (checks) and `npm run ui-docs` (regenerates the two docs).

## Screen entry

```yaml
screens:
  encounter.orders:                 # must exist in spec/screens.yaml
    route: /patient/:patientId/encounter/:encounterId/orders
    pattern: encounter-workspace    # from patterns.yaml; inherits its regions
    up: encounter.note              # where "Up"/breadcrumb goes; null for roots
    wireframe: Orders.dc.html       # artboard on the canvas, if drawn
    flows: ["flow:encounter/04"]    # flow steps this screen carries out
    regions:                        # named areas, top-to-bottom, left-to-right
      cart:
        - {id: order-card, type: card, bind: "ServiceRequest[] this encounter", each: true, cols: [...]}
    views:                          # sub-screens on the same route
      add:
        container: drawer           # drawer | modal | blocking-modal | pane | sheet
        regions: {...}
    states: [missing-dx, duplicate]  # edge states the screen must render (plus pattern defaults)
```

Overlays that are not routes (`global.command-bar`, `global.notifications`) use `route: null` and `container`.

## Element

One line each, flow style:

```yaml
{id: sign-orders, type: button, label: "Sign orders", primary: true,
 tr: "order:pended->signed", be: logic, inv: [INV-SAFE-01, INV-ID-03], when: "no blockers"}
```

| Key | Meaning |
|---|---|
| `id` | Unique within the screen (including its views). Use it as the `data-testid` and in code: `encounter.orders/sign-orders`. |
| `type` | Control vocabulary below. |
| `label` | Visible text. Status text comes from `states.yaml` labels, never from here. |
| `bind` | What it shows: `Entity.field`, `Entity[] <scope>`, `states:<machine>` for a status chip, or `derived:<name>` for a computed value. Entity names come from the glossary. |
| `go` | Navigation target: `<screen-id>`, `<screen-id>#<view>`, `back`, or `external:<what>`. |
| `opens` | Views the server may open as a result (an alert, a 2FA step), e.g. `[encounter.rx#alert]`. |
| `tr` | State transition it triggers, `<machine>:<from>-><to>`. Must exist in `states.yaml`. |
| `does` | Plain-language effect when it is not navigation or a transition. |
| `be` | Backend dependency: `ui` (none), `crud` (read/write existing data), `logic` (server rules, matching, checks, external networks). Defaults: `ui` with no bind/does/tr, `crud` with bind or does, `logic` with tr. Set `logic` explicitly where the server must decide something. |
| `inv` | Invariants this element enforces or displays. |
| `when` | Visibility or enabled condition. |
| `each` | `true` when the element repeats per item. `cols` lists the elements inside each row or card. |
| `primary` | The one primary action in a region. |

**Types:** `heading text link button icon-button menu toggle tab tabs search input select date textarea checkbox radio
table list card chip status-chip stat stat-filter alert banner meter chart timeline stepper avatar image placeholder
editor signature upload`.

## Navigation model

- **Routes** are deep-linkable. Browser back pops history.
- **Up** (`up:`) is the structural parent. Breadcrumbs and the "back to list" link use it.
- **Views** open on top of their screen. Closing (✕, Esc, Cancel, or success) returns to the underlying view and keeps its scroll and filters.
- **Chart context** (ADR-001): any patient link opens `/patient/:id/...` as a chart tab. Closing the last chart tab returns to the last non-chart route.
- **Encounter section tabs** are sibling routes. Leaving the encounter keeps the draft (autosave).
- **Blocking modals** cannot be dismissed by clicking outside. The user must pick an action.

Every screen must be reachable from a role home, the rail, or the command bar, and every non-root screen must declare `up`. The validator checks both.

## Using it to build

1. Build the patterns first (shell, chart context, encounter workspace, list-detail, drawer, modal). Most screens are a pattern plus a few elements.
2. Build screens slice by slice (`05-build-slices.md`). For each screen, read its entry, its flow steps and its invariants.
3. Before building a screen, check `08-backend-needs.md` against your existing APIs. Elements whose need isn't met yet are hidden behind a feature check, not faked.
