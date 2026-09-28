export const evidenceAnchor = (runId: string, id: string) => `evidence-${runId}-${id}`;

/** Keep citations keyboard accessible and scope ids to the selected run. */
export function EvidenceRef({ runId, id, onHighlight }: { runId: string; id: string; onHighlight: (id: string | null) => void }) {
  return (
    <a href={`#${evidenceAnchor(runId, id)}`} className="link font-mono text-12"
      onMouseEnter={() => onHighlight(id)} onMouseLeave={() => onHighlight(null)}
      onFocus={() => onHighlight(id)} onBlur={() => onHighlight(null)}
      onClick={(event) => {
        event.preventDefault();
        const row = document.getElementById(evidenceAnchor(runId, id));
        row?.scrollIntoView({ block: 'nearest' });
        row?.focus({ preventScroll: true });
        onHighlight(id);
      }}>
      [{id}]
    </a>
  );
}
