import type { Handoff } from './handoff';

/** Why the agent stopped and what a person can do next. Pure, so it renders anywhere. */
export function HandoffCard({ handoff, className }: { handoff: Handoff; className?: string }) {
  return (
    <section aria-label="Why the agent stopped" className={`rounded-lg border border-rule bg-surface px-5 py-4 ${className ?? ''}`}>
      <p className="text-12 font-semibold tracking-wide text-ink-2 uppercase">Why the agent stopped</p>
      <h2 className="mt-1 text-16 font-semibold text-ink">{handoff.title}</h2>
      <p className="mt-2 text-14 leading-6 text-ink">{handoff.reason}</p>
      <p className="mt-3 text-13 font-medium text-ink">What you can do</p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-14 text-ink-2">
        {handoff.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
    </section>
  );
}
