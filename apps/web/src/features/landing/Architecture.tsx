/**
 * Architecture diagram as inline SVG, drawn with the app's own tokens (docs/05 §11 landing).
 * Boxes are systems, arrows are calls. The one rule it shows: models propose, code decides.
 */
const box = { fill: 'var(--surface)', stroke: 'var(--rule-strong)', strokeWidth: 1 };
const accentBox = { fill: 'var(--accent-weak)', stroke: 'var(--accent)', strokeWidth: 1 };
const label = { fontFamily: 'var(--font-mono)', fontSize: 12, fill: 'var(--ink)' } as const;
const sub = { fontFamily: 'var(--font-sans)', fontSize: 11, fill: 'var(--ink-2)' } as const;
const line = { stroke: 'var(--ink-2)', strokeWidth: 1, fill: 'none', markerEnd: 'url(#arrow)' } as const;

export function Architecture() {
  return (
    <svg viewBox="0 0 680 400" role="img" aria-labelledby="arch-title arch-desc" className="block h-auto w-full">
      <title id="arch-title">PayOps AI architecture</title>
      <desc id="arch-desc">
        The web app calls an API. The API runs detection, policy, the executor and the validator against Postgres. An agent graph
        investigates through read-only tools and returns a proposal. Policy decides whether a person must approve it before the
        executor acts, and the validator re-reads the data to check the result.
      </desc>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--ink-2)" />
        </marker>
      </defs>

      {/* Left column: people and API */}
      <rect x="16" y="24" width="150" height="56" {...box} />
      <text x="28" y="48" style={label}>Web app</text>
      <text x="28" y="66" style={sub}>Ops analysts, managers</text>

      <rect x="16" y="144" width="150" height="56" {...box} />
      <text x="28" y="168" style={label}>API + jobs</text>
      <text x="28" y="186" style={sub}>Express, pg-boss, sockets</text>

      <rect x="16" y="304" width="150" height="72" {...box} />
      <text x="28" y="328" style={label}>Postgres</text>
      <text x="28" y="346" style={sub}>Cases, ledger, audit,</text>
      <text x="28" y="360" style={sub}>agent steps, checkpoints</text>

      <path d="M91 80 V144" {...line} />
      <path d="M91 200 V304" {...line} />

      {/* Middle: deterministic core */}
      <rect x="232" y="120" width="200" height="256" {...accentBox} />
      <text x="246" y="144" style={label}>Deterministic core</text>
      <text x="246" y="162" style={sub}>Decides and acts. No model here.</text>
      {['Detection rules', 'Policy engine (tier)', 'Approval, four-eyes', 'Executor (idempotent)', 'Validator (re-reads)'].map((t, i) => (
        <g key={t}>
          <rect x="246" y={178 + i * 38} width="172" height="30" {...box} />
          <text x="258" y={198 + i * 38} style={{ ...label, fontSize: 11 }}>{t}</text>
        </g>
      ))}
      <path d="M166 172 H232" {...line} />

      {/* Right: agents and providers */}
      <rect x="498" y="24" width="166" height="132" {...box} />
      <text x="510" y="48" style={label}>Agent graph</text>
      <text x="510" y="66" style={sub}>LangGraph, one thread per run</text>
      <text x="510" y="90" style={sub}>plan, payment, reconciliation,</text>
      <text x="510" y="104" style={sub}>risk, grounding check, resolve</text>
      <text x="510" y="128" style={sub}>Proposes from a closed action</text>
      <text x="510" y="142" style={sub}>catalog. Cannot execute.</text>

      <rect x="498" y="204" width="166" height="72" {...box} />
      <text x="510" y="228" style={label}>Jev</text>
      <text x="510" y="246" style={sub}>Typed decisions with</text>
      <text x="510" y="260" style={sub}>confidence, six points</text>

      <rect x="498" y="304" width="166" height="72" {...box} />
      <text x="510" y="328" style={label}>Gemini</text>
      <text x="510" y="346" style={sub}>Reasoning over projected</text>
      <text x="510" y="360" style={sub}>evidence, schema-checked</text>

      <path d="M432 120 V90 H498" {...line} />
      <path d="M498 110 H460 V128 H432" {...line} />
      <path d="M581 156 V204" {...line} />
      <path d="M581 276 V304" {...line} />
    </svg>
  );
}
