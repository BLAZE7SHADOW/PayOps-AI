# 05 · Product UI and Design System

## 1. Direction

PayOps is an **internal operations tool** used for hours at a time by people reconciling money. It should feel like a well-made ledger: calm, dense, precise, printed-paper warm. Reference feel: Stripe Dashboard's tables, Linear's restraint, a bank statement's typography. It should not look like a landing-page template or an "AI app".

The signature of this product is the **state matrix**: one payment shown as five systems see it, side by side, with the disagreement marked. Every screen should make disagreement and evidence easy to see. The user should see the problem, cited cause, and next permitted action in that order. `docs/UI-REVAMP-PLAN.md` records the Phase 6 hierarchy and workflow pass (D055).

## 2. Tokens (the only colors allowed)

Defined once in `apps/web/src/styles/tokens.css` as CSS variables and mapped into Tailwind v4 `@theme`. The default Tailwind palette is disabled. No hex values in components.

| Token | Value | Use |
|---|---|---|
| `--paper` | `#F5F2EA` | app background (never pure white) |
| `--surface` | `#FFFEFB` | tables, panels and working surfaces |
| `--surface-sunk` | `#EEEAE0` | table header, code blocks, matrix header |
| `--rule` | `#DDD6C8` | 1px hairlines, all borders |
| `--rule-strong` | `#C4BBA9` | focused input border, selected row edge |
| `--control` | `#748279` | required input and outlined-button boundary |
| `--ink` | `#202923` | primary text |
| `--ink-2` | `#536159` | secondary text |
| `--ink-3` | `#8A8479` | placeholders, separators, chart marks only (3.3:1 on paper, so never for meaningful text; use `--ink-2`) |
| `--accent` | `#1E5A4C` | primary buttons, links, focus ring (ledger green) |
| `--accent-hover` | `#16473C` | primary action hover and pressed feedback |
| `--accent-weak` | `#DCE8E2` | selected row, active nav |
| `--ok` | `#2E6B3A` | PASS, matched |
| `--warn` | `#94660F` | PARTIAL, pending, awaiting approval |
| `--bad` | `#9E3524` | FAIL, mismatch, rejected |
| `--bad-weak` | `#F3E1DB` | mismatch cell background in the state matrix |
| `--warn-weak` | `#F2E8D2` | |
| `--ok-weak` | `#E0EBDF` | |

Dark mode is out of scope for the MVP. If added later, it gets its own hand-tuned token set, not an inversion.

## 3. Type

- **UI:** IBM Plex Sans (400, 500, 600). Base 15px for reading, 14px for controls and tables, line-height 1.5 for prose.
- **Data:** IBM Plex Mono for IDs, amounts, timestamps, status codes, evidence refs. `font-variant-numeric: tabular-nums` everywhere numbers align.
- Scale: 12 / 13 / 14 / 15 / 16 / 18 / 20 / 24 / 28. Page titles 28px 600, section headings 18–20px. Technical metadata remains 12–13px. No display sizes or gradient text.
- Amounts right-aligned, always with `₹` and Indian grouping (`₹12,499.00`), from `formatMoney()`.

## 4. Shape, depth, motion

- Radius: `6px` controls, `8px` major panels/dialogs, `0` table cells and the matrix. Status tags can remain compact at `2–4px`.
- Depth: borders, not shadows. The only shadow allowed is on popovers/dialogs: `0 1px 0 var(--rule), 0 8px 24px rgb(28 27 24 / 0.08)`.
- Motion: color/background transitions ≤ 100ms. No transforms on hover, no bouncing, no animated arrows, no parallax. Live agent steps appear by inserting a row, no slide-in.
- Density: standard table rows 44px, compact desktop rows 32px only when useful. Major controls 40px desktop and 44px on touch layouts. Spacing scale 4 / 8 / 12 / 16 / 24 / 32 / 48px.

## 5. Icons

- No Lucide, no sparkle icons, no "AI" glyphs anywhere.
- Prefer words. Status is shown as a mono text tag (`CAPTURED`, `FAILED`, `PASS`) with a 6px square swatch in the status color.
- The few icons needed (search, close, chevron, external link, copy) come from `@radix-ui/react-icons`, 15px, `--ink-2`.

## 6. Components (in `apps/web/src/ui/`)

Built on unstyled Radix primitives, styled with our tokens: `Button` (primary / secondary / quiet / danger), `Input`, `Select`, `Tag` (status), `Money`, `Mono`, `Table` (sortable headers, sticky header, keyboard row nav), `Drawer`, `Dialog`, `Tabs`, `Tooltip`, `Skeleton`, `EmptyState`, `KeyValue`, `Timeline`, `EvidenceRef`, `StateMatrix`, `Sparkline`.

Action hierarchy: one filled primary action in the active task area; secondary is the alternate path; quiet is tertiary support. Destructive entry uses a danger outline and final destructive confirmation uses a filled danger treatment. A dialog or drawer owns its own primary action while open. Navigation stays a link. Approval review must present the proposed operation, amount, evidence, and policy before a person chooses a decision; never visually preselect approval.

`EvidenceRef` renders `[ev_03]` in mono; hover or focus highlights the matching evidence row in the evidence panel, click scrolls to it. Findings and the root-cause statement use these inline. This is the main way we show the AI is grounded.

## 7. Loading, empty, error

- **Every** async surface has a skeleton that matches the final layout (row heights, column widths). No full-page spinners.
- Empty states are one line of plain text plus the next action ("No open exceptions. Generate a scenario from the Simulator.").
- Errors show the error code and request id in mono, with a retry button.

## 8. Copy rules

- Plain, specific, operational. "Webhook `payment.captured` returned HTTP 500 at 12:31:04." not "Something went wrong with your payment flow."
- Name AI features by what they do: **Investigation**, **Proposed resolution**, **Findings**, **Evidence**. Never "AI Assistant", "Magic", "Copilot", "Smart".
- Show model facts plainly: `gemini-3.6-flash · 11 tool calls · 7.8k tokens · ₹0.84`.
- No em dashes in UI copy. Use a period, colon or middle dot (·).
- No "it's not X, it's Y" constructions, no "seamless", "supercharge", "effortless", "unlock", "revolutionize".
- No emojis. No exclamation marks.
- Sentence case for everything except status codes.

## 9. The 30 "looks vibecoded" tells, and what we do instead

| # | Tell | Our rule |
|---|---|---|
| 1 | Harsh gradients | None. Flat token colors only |
| 2 | Lucide icons | Radix icons, sparingly; words first |
| 3 | Pure white background | `--paper` #F5F2EA |
| 4 | Rainbow coloring | One accent + three status colors, used only for status |
| 5 | Drop shadows | Hairline borders; shadow only on popovers |
| 6 | 3 feature cards in a row | No marketing cards in the app; landing uses screenshots and prose |
| 7 | Emojis | None |
| 8 | Liquid glass | No blur, no translucency |
| 9 | Em dashes | Not in UI copy |
| 10 | Inter / Geist / Space Grotesk | IBM Plex Sans + Plex Mono |
| 11 | Colored left stripe on cards | Status is a tag, never a stripe |
| 12 | Fake testimonials | None, ever |
| 13 | Bento grids | Tables, lists, a 12-column grid |
| 14 | Terminal window mockup | The agent trace is a real timeline table, not a fake terminal |
| 15 | "It's not X, it's Y" | Banned phrasing |
| 16 | Checkmark bullets | Step status as text tags (`DONE`, `RUNNING`, `FAILED`) with step numbers |
| 17 | 3 pricing tiers | No pricing page |
| 18 | No real product demo | Landing page shows real screen recordings from the running app |
| 19 | Soft big radius | Controlled 6–8px on interactive surfaces; square tables |
| 20 | Purple and black | Ledger green on warm paper |
| 21 | No skeleton loaders | Skeletons everywhere data loads |
| 22 | Radial orbs | None |
| 23 | Dot grids | None |
| 24 | Sparkle icons | None, including for AI features |
| 25 | Animated arrows | None |
| 26 | No TOS | `/terms` page (short, honest: demo system, simulated data) |
| 27 | No privacy policy | `/privacy` page (what is stored, what is sent to Gemini and TypeSafe) |
| 28 | Hover animations | Color change only |
| 29 | Neon colors | Muted, print-like status colors |
| 30 | Basic pastel colors | Warm neutrals; weak status tints only inside the state matrix |

## 10. Layout

- Left nav 216px, fixed: Overview, Payments, Exceptions (count), Approvals (count), Agent runs, Audit log; bottom: Simulator, Policy, user menu.
- Top bar 48px: breadcrumb, global search (`/` focuses, searches payment/order/case ids), an always-visible `SIMULATED DATA` tag, and `AI: REPLAY | LIVE` tag.
- Content max width none (tables use full width); reading panels max 72ch. On narrow screens, actions follow the case summary and wide tables scroll within their own region. A state-aware action area keeps the next permitted operation visible without inventing operations.

## 11. Screens

### Sign in
Two fields and a button, on paper. Under it, three demo accounts as text buttons ("Continue as Ops analyst", "Ops manager", "Viewer"). Product name in Plex Sans 600, no logo art.

### Overview
- Top row: 4 figures as plain text blocks separated by hairlines (not cards): Captured today (₹), Open exceptions, Awaiting approval, Resolved by investigation (7d, % of resolved).
- Below: "Exceptions by type (14 days)" stacked bars in accent + neutrals; "Validator outcomes" PASS/PARTIAL/FAIL counts; "Oldest open cases" table (5 rows).
- Charts: direct labels, no legend boxes where avoidable, no gridline clutter, tabular numbers.

### Payments
Table: Payment · Order · Customer (masked) · Amount · Gateway · Internal · Ledger · Settlement · Case. Gateway/Internal/Ledger/Settlement columns show status tags; a row where they disagree gets a `MISMATCH` tag in the Case column. Filters as a single row of selects + date range; URL-synced. Cursor pagination.
Row click opens a **drawer**: the payment lifecycle as one merged timeline across systems (gateway events, webhook attempts with HTTP codes, order transitions, ledger postings, settlement line), each row labelled with its system in mono.

### Exceptions (queue)
Table sorted by priority: Case · Type · Amount · Systems in disagreement (mini matrix: 5 small squares G O L W S, bad-tinted where wrong) · Age · Signals (J1 tags, and `QUARANTINED TEXT` if flagged) · Status · Assignee. Bulk: assign, start investigation.

### Case (hero screen)
```
┌───────────────────────────────────────────────────────────────────────────┐
│ PAY-8291 · Payment mismatch · ₹12,499.00 · OPEN · opened 12:31 · D1, D3   │
├───────────────────────────────────────────────────────────────────────────┤
│ STATE MATRIX                                                              │
│            Gateway    Order     Ledger    Webhook       Settlement        │
│ status     CAPTURED   FAILED▲   MISSING▲  500 x3▲       SETTLED           │
│ amount     12,499.00  12,499.00  –        –             12,499.00         │
│ at         12:30:58   12:31:04   –        12:31:02      +1d               │
├──────────────────────┬───────────────────────────────┬────────────────────┤
│ Investigation        │ Findings & resolution          │ Evidence (14)      │
│ run_29191 · attempt 1│ ROOT CAUSE                     │ ev_01 GATEWAY  ... │
│ 01 plan      DONE    │ Webhook processing failure     │ ev_02 WEBHOOK  ... │
│ 02 payment   DONE    │ The captured webhook failed 3  │ ev_03 ORDER    ... │
│   getGatewayPayment  │ times with HTTP 500 [ev_02],   │ ...                │
│   getWebhookDel...   │ so the order stayed FAILED     │                    │
│ 03 recon     RUNNING │ [ev_03] while gateway ...      │                    │
│ ...                  │ PROPOSED                        │                    │
│                      │ 1 REPLAY_WEBHOOK_EVENT         │                    │
│                      │ 2 POST_LEDGER_ENTRY ₹12,499.00 │                    │
│                      │ Policy: AUTO (P6) · risk LOW   │                    │
│                      │ [Approve] [Reject] [Escalate]  │                    │
└──────────────────────┴───────────────────────────────┴────────────────────┘
```
- Mismatched matrix cells get `--bad-weak` background and a ▲ marker; the column header of the "source of truth" (gateway) is marked `REFERENCE`.
- Investigation column: numbered steps, nested tool calls in mono, Jev decisions shown as `plan · primary: webhook_or_state_sync · conf 0.82`. Timing on the right in mono.
- After execution: a **Verification** block lists every validator check as a row (`order.status = PAID  expected PAID  actual PAID  PASS`).
- A visible verification row links to the current source records, payment drawer when applicable, resolution checks, case audit events, and any pending approval. Source records show the saved order/payment, gateway, webhook, ledger, refund, settlement, and dispute rows linked to the case; each row can reveal key fields. The records are read from core services separately from the agent trace and can be refreshed during a LIVE run.
- If replanned: attempts shown as tabs `Attempt 1 · FAIL` / `Attempt 2 · PASS`.
- Manual path always visible: "Resolve manually" opens the action catalog form.

### Approvals
Table: Case · Action summary · Amount · Tier · Risk · Rules fired · Requested · By. Row opens a drawer with the proposal, cited findings with evidence refs, and Approve / Reject / Escalate with a required comment for Reject and Escalate. MANAGER-tier rows are disabled for OPS users with the reason shown.

### Agent runs
Table: Run · Case · Status · Attempts · Duration · LLM calls · Jev calls · Tool calls · Tokens · Cost · Mode. Run detail starts with a vertical orchestration path derived from recorded `agent_steps`: actual visited stages in order, selected specialist branches grouped together, explicit approval pauses, and repeated stages when replanning occurs. Each node states its recorded result and first reason in plain language; expanding it explains evidence, chosen follow-up records and findings, with technical event names in a second disclosure. Temporary provider retries appear beside the affected step. Never draw unvisited agents, claim an unexecuted tool was used, or suggest the model authorizes policy, execution, or verification. Show the full step table (seq, node, kind, name, latency, context tokens), expandable projected JSON, run usage and per-node latency bars after the readable story. Case findings link to this run view.

### Audit log
Dense chronological table: time (mono), actor (user / agent / system tag), action, entity, run link. Filters by entity and actor.

### Simulator (admin/ops)
List of scenarios with one-line descriptions, seed input, "Generate", and "Reset demo data". Shows the ids created.
The four recorded critical showcase scenarios appear first as a distinct group. Their case severity comes from detection, and the copy explains that actual model responses were recorded for replay. Standard scenarios remain available below; do not imply every run in the catalog resolves successfully.

### Policy
Read-only table of policy rules (id, condition in plain words, tier), version, thresholds. Shows that authority lives in code.

### Public pages
- `/` landing (logged out): one column, 72ch. Product sentence, a real screen recording of the case screen, a real architecture diagram (SVG, same tokens), "How decisions are made" section in prose, link to GitHub and "Open the demo". No cards, no pricing, no testimonials.
- `/terms`, `/privacy`: plain text pages.

## 12. Accessibility

Contrast ≥ 4.5:1 for text (tokens chosen to pass on `--paper` and `--surface`). Visible 2px focus ring in `--accent`. Status never by color alone (always a text tag). Full keyboard nav in tables (j/k, enter). Live agent updates announced politely via an `aria-live` region.
