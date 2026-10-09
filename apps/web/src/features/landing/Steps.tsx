import { Section } from './Section';

const STEPS: Array<{ name: string; text: string }> = [
  {
    name: 'Notice',
    text: 'Every minute it compares the gateway, the order service, the ledger, webhook deliveries and settlement. When they disagree, it opens a case.',
  },
  {
    name: 'Investigate',
    text: 'AI helpers collect facts with read-only tools. Every claim has to point to the evidence behind it, or it is thrown out.',
  },
  {
    name: 'Propose',
    text: 'The fix is picked from a fixed list of nine actions, such as replaying a failed webhook or sending a refund. It cannot invent an action.',
  },
  {
    name: 'Approve',
    text: 'Rules written in code decide whether the fix can run on its own or needs a person. Risky actions need a second person to approve.',
  },
  {
    name: 'Check',
    text: 'After the fix runs, a separate check reads the records again and reports pass, partial or fail. A failed fix is retried within limits or handed to a person.',
  },
];

/** The one numbered list on the page, because this content really is a sequence. */
export function Steps() {
  return (
    <Section title="What PayOps AI does" lead="Five steps, from the first mismatch to a checked fix.">
      <ol className="border-t border-rule">
        {STEPS.map((s, i) => (
          <li key={s.name} className="grid grid-cols-[2.5rem_8rem_1fr] gap-x-4 border-b border-rule py-5 max-md:grid-cols-[2rem_1fr]">
            <span className="tabular font-mono text-14 leading-[1.65] text-ink-2">{i + 1}</span>
            <h3 className="text-[17px] leading-[1.65] font-semibold text-ink max-md:col-start-2">{s.name}</h3>
            <p className="text-[17px] leading-[1.65] text-ink max-md:col-start-2">{s.text}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}
