# UI revamp plan

Status: proposed design and implementation plan, 2026-09-29. This is a Phase 6 refinement requested by Shivam. Production UI has not changed. The current authority remains `docs/05-ui-design.md` until the proposed changes below are incorporated during implementation.

## Outcome

An operator should be able to identify the current problem, the evidence supporting it, and the next permitted action without scanning execution logs. The interface should guide attention through case summary, system comparison, findings, decision, and verification.

Keep the ledger-green identity, IBM Plex type, real product data, and accessible status labels. Give primary actions a consistent location and stronger emphasis. Use fewer enclosing borders, more deliberate spacing, and larger controls.

## Findings from the current implementation

- `ui/Button.tsx`: default buttons are 32px high with 13px labels; small buttons are 28px high. These heights are not automatically WCAG failures, but they offer limited prominence for major actions.
- `features/investigation/Investigation.tsx` and `features/resolution/ResolutionSection.tsx`: investigation and manual resolution can both render filled primary buttons in different sections of the same case.
- `features/cases/CasePage.tsx`: manual resolution follows the case details and lifecycle. Important decisions require scanning a long page.
- `features/investigation/Investigation.tsx`: execution trace, findings, and raw evidence have similar visual weight. Run IDs and model counters occupy the section header.
- `features/simulator/ScenarioRow.tsx`: each scenario has an equally weighted Generate action; success produces ID lists with small case links. Choosing a scenario and opening its result need clearer emphasis.
- The saved Case screenshot supports these hierarchy concerns. This is a source and screenshot review, not a fresh usability or live-browser audit.

## Design direction

Use a brighter working surface within the warm canvas, clear dark text, a distinct navigation region, and green reserved mainly for the main action and selection. Status indicators combine words with shape or placement. Success green is a small status treatment; primary green is a filled interactive control.

Proposed token changes are design choices, not WCAG requirements:

| Role | Proposed value | Application |
| --- | --- | --- |
| Canvas | `#F5F2EA` | Keep the current warm page background |
| Surface | `#FFFEFB` | Main working panels |
| Inset surface | `#EEEAE0` | Table headers, secondary regions |
| Primary text | `#202923` | Headings, labels, values |
| Secondary text | `#536159` | Descriptions and metadata |
| Primary action | `#1E5A4C` | Main permitted action |
| Primary hover | `#16473C` | Hover feedback |
| Decorative rule | `#DDD6C8` | Nonessential separators |
| Control boundary | `#748279` | Inputs and outlined controls requiring a visible boundary |
| Danger | `#9E3524` | Destructive actions and errors |

Calculated contrast: surface text on primary 7.94:1; primary text on surface 14.84:1; secondary text on canvas 5.83:1; control boundary on surface 4.00:1; danger text on surface 6.97:1. These calculations cover these pairs only. Hover, pressed, selected, error, status, and focus combinations still need verification in implementation.

## Action hierarchy

Aim for one dominant action per active task area. A dialog or drawer can own the primary action while it is open. Read-only pages do not need an invented primary button. Navigation should remain links, even when visually styled as a call to action.

| Level | Appearance | Examples |
| --- | --- | --- |
| Primary | Solid ledger green, bright text, 40px minimum height | Start investigation; Generate scenario; submit the reviewed decision |
| Secondary | Surface fill, dark text, visible neutral border | Resolve manually; Cancel; alternate task path |
| Tertiary | Text with full hit area and a subtle hover background | Show technical details; Clear filters; Copy ID |
| Destructive | Red text and outline for entry; filled red for the final destructive confirmation | Reset demo data |

Use 14px medium-weight labels, 16px horizontal padding, and 8-12px gaps within action groups. Use 44px targets for primary controls in touch layouts, and 32px compact desktop controls where density justifies them. Preserve at least WCAG's target-size minimum or its permitted spacing exceptions.

Use explicit hover, pressed, focus-visible, disabled, and pending tokens rather than reducing the whole button's opacity. Pending labels name the operation, keep the button width stable, announce progress, and prevent duplicate submission. Unavailable actions show a reason. A visual hierarchy must never imply that approval is the correct decision before evidence is reviewed.

## Case page and state-dependent actions

The state map below is a presentation rule over existing API and permission data, not a new authorization system. Preserve `can(role, ...)`, `resolutionView.canPropose`, active-run checks, `canDecide`, and server rejection handling. Loading and failed permission queries must not expose enabled actions.

| State | Dominant action or status | Supporting action |
| --- | --- | --- |
| Open; investigation permitted | Start investigation | Resolve manually in the same action area |
| Investigation active | Current step and progress; no duplicate start | View investigation details; preserve existing manual eligibility |
| Awaiting approval | Review approval link | Show required role, requester, and restrictions |
| Approval review; eligible actor | Review the proposal, choose a decision, submit with a specific label | Reject and Escalate remain visible; preserve required comments and four-eyes checks |
| Approval review; restricted actor | Clear reason they cannot decide | Read-only proposal and evidence |
| Failed or escalated | Recovery based on actual available operations | Resolve manually or retry investigation only if existing API state permits it |
| Resolved | Verification outcome and changed systems | Back to Exceptions; view attempt details; no invented re-run action |
| Viewer | Read-only status and evidence | No mutation controls |

Desktop layout:

1. Header: case ID, concise problem title, amount, status, age, assignee. Move rule codes and raw IDs into secondary details.
2. State matrix: retain all five systems and the gateway reference marker. Highlight the specific disagreements. Clearly distinguish the original detection reason from the current state.
3. Main workspace: roughly two-thirds findings and resolution, one-third next action and policy context. Put the major action in a stable location in the right rail.
4. Findings: concise existing diagnosis, cited evidence, proposed actions, and expected outcomes. Keep grounding warnings and dropped findings visible in the relevant context.
5. Supporting information: collapsible investigation trace and lifecycle. Evidence references open or reveal the corresponding evidence with keyboard focus, and return focus when closed.
6. Resolved view: promote real validator results and the actual resolution history. Do not fabricate before/after data absent from the DTOs.

On narrower screens, place the action area after the summary, then matrix and findings. At 200% zoom and narrow widths, use one column. Permit local horizontal scrolling for genuinely two-dimensional tables, not the whole page. Sticky rails must stop when they cannot fit; overlays and sticky elements must never obscure focus.

## Page-by-page flow

| Page | User's task | Planned emphasis |
| --- | --- | --- |
| Landing | Understand the product and enter the demo | Real Case visual, one Open demo link, secondary source link |
| Sign in | Choose a demo role or use credentials | Explain role capabilities; distinguish demo entry from the credential form |
| Overview | Find work requiring attention | Prioritised exceptions and approvals; linked figures with clear destinations |
| Exceptions | Choose a case | Strong case/problem column, aligned amounts and ages, readable filters, explicit case links; preserve filter state on return |
| Case | Diagnose and resolve | State matrix, cited diagnosis, state-aware action area, verification |
| Approvals | Evaluate a proposed operation | Amount, action, requester, policy reasons and evidence before the decision controls |
| Payments | Inspect a payment across systems | Scannable statuses, obvious payment links, focused lifecycle drawer |
| Simulator | Generate and inspect a chosen scenario | Select one scenario, expose advanced inputs on demand, one Generate action; present opened cases as clear links; isolate reset controls |
| Agent runs | Understand execution | Outcome and duration before raw IDs; expandable detailed steps and usage |
| Audit / Policy | Inspect records and rules | Search/filter/read workflows with low-emphasis supporting actions |

Do not introduce bulk actions, exports, next-case fetching, or new business behavior merely to fill the new layout. Use operations already supported by the product.

## Spacing, typography, borders, and feedback

- Spacing scale: 4 / 8 / 12 / 16 / 24 / 32 / 48px. Use 8px for related controls, 16px within a group, 24px panel padding, and 32px between major sections.
- Proposed type: 28px page heading, 18-20px section heading, 15px narrative text with 1.5 line-height, 14px controls and tables, 12-13px secondary metadata. Keep Plex Mono for amounts, IDs, and timestamps, rather than whole paragraphs.
- Proposed radii: 6px controls, 8px drawers/dialogs and major panels, square table cells. Revise the current 0-4px ceiling in `docs/05-ui-design.md` when implementing.
- Prefer headings and spacing over a box around every section. Keep subtle table row rules; use a stronger boundary on interactive controls. Retain modest shadow only for floating overlays.
- Standard table row target: 44px, with compact desktop rows only where useful. Right-align numbers and keep tabular numerals.
- Keep motion limited to useful color/focus feedback. Maintain reduced-motion support if any new transitions are introduced. Smooth flow comes from predictable placement and immediate feedback.
- Preserve skeletons, useful empty states, inline errors, retry, realtime status announcements, and focus restoration. No auto-scrolling to new events while someone is reading.

## Implementation sequence

1. **Foundation:** update the relevant UI spec and record the design decision; introduce semantic control/surface tokens, button states, input sizing, typography, spacing, and responsive shell rules. Keep the present component API where practical; `quiet` can remain the implementation name for tertiary.
2. **Case prototype in the app:** consolidate presentation of permitted actions, reorganise findings/evidence/trace, preserve all mutations and guards. Verify open, investigating, pending approval, restricted, failed, and resolved states.
3. **Daily workflow:** update Exceptions, Approvals, and payment drawers. Preserve URL filters, keyboard row navigation, sorting, pagination, and focus.
4. **Demo and overview:** update the Simulator selection/result flow, Overview priorities, sign-in clarity, and the landing page's real product visual.
5. **Consistency and validation:** apply the pattern to runs/audit/policy; check responsive states, keyboard navigation, accessible contrast, pending/error/empty states, and screenshot consistency.

Start with the foundation and Case page. Validate the real manual path, AUTO resolution, manager approval, and failed-investigation recovery before spreading the pattern to every screen. No backend, policy, executor, or database changes are required for this plan.

## Acceptance criteria

- A first-time reviewer can identify the problem and next permitted action within about five seconds in a small usability trial. This is a proposed evaluation target, not a measured result.
- Each active task has a clear action hierarchy; no two filled primary actions compete within the same task area.
- Major case actions are easy to locate at 1280px and 1440px desktop widths. At 390px and 200% zoom, content reflows, table overflow stays local, and controls remain reachable.
- Normal text contrast meets 4.5:1; required control boundaries and state indicators meet 3:1 against adjacent colors. Status meaning never relies on color alone.
- Pointer targets satisfy WCAG 2.2 AA sizing/spacing; important touch controls aim for 44px.
- Keyboard users can open a case, follow evidence, use dialogs, return to their place, and finish permitted flows. Focus is visible and never hidden beneath sticky UI.
- Existing approval restrictions and pending-operation protections still hold. No permission decision is inferred from button styling or a client-only state map.
- Run `corepack pnpm --filter @payops/web typecheck`, the affected existing interaction tests, and lint for changed files. Add focused tests for any changed action/role gating and evidence focus behavior. Run the full web suite at integration, then a real browser pass over the changed flows and a Lighthouse accessibility check.

## Supporting guidance

These sources inform the proposal; the exact PayOps palette, dimensions, and layouts above are our design choices.

- [Carbon: button usage](https://carbondesignsystem.com/components/button/usage/) supports limiting competing primary actions, giving temporary flows their own action hierarchy, and keeping destructive actions distinct. Its specific secondary/tertiary naming differs from the three-level PayOps proposal.
- [NN/g: progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/) supports revealing detailed information when needed while keeping the main task understandable.
- [W3C: text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) and [non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) define the relevant contrast criteria. Decorative separators do not all need 3:1.
- [W3C: target size minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) specifies a 24-by-24 CSS-pixel target or applicable exceptions. Our proposed 40/44px major controls go beyond that minimum.

## Visual study

Open [UI-REVAMP-PREVIEW.html](UI-REVAMP-PREVIEW.html) locally. It contains illustrative Case states and a button comparison. It is an independent design study with sample data, not a connected product screen or a production implementation. Its simulated controls do not call APIs. The production version should continue using the bundled Plex fonts; the standalone study uses local font fallbacks.

Preview validation: headless Chrome checked state switching, disabled running action, viewer presentation, review-dialog opening, resolved verification visibility, and no page-wide overflow at 390px. Desktop and mobile screenshots were inspected. This does not establish production accessibility or validate actual business flows.
