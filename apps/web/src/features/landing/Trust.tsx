import { Section } from './Section';

const POINTS: Array<{ title: string; text: string }> = [
  { title: 'It cannot touch your data', text: 'The AI only sees facts that code has prepared for it. It never reads or writes the database.' },
  { title: 'It can only pick from nine actions', text: 'There is no free-form command. Anything outside the list is refused.' },
  { title: 'Code decides who approves', text: 'Approval rules are ordinary, tested code. The AI cannot change them or skip them.' },
  { title: 'A separate check confirms the fix', text: 'The result is verified by reading the records again, not by trusting the step that made the change.' },
];

export function Trust() {
  return (
    <Section title="Why you can trust the result" lead="The AI helps with the thinking. It does not hold the keys.">
      <div className="grid grid-cols-2 border-t border-l border-rule max-md:grid-cols-1">
        {POINTS.map((p) => (
          <div key={p.title} className="border-r border-b border-rule p-6">
            <h3 className="text-[17px] leading-[1.4] font-semibold text-ink">{p.title}</h3>
            <p className="mt-2 text-16 leading-[1.6] text-ink-2">{p.text}</p>
          </div>
        ))}
      </div>
      <p className="mt-5 max-w-[62ch] text-16 leading-[1.6] text-ink-2">
        The product also works with the AI turned off. People use the same actions, rules and checks.
      </p>
    </Section>
  );
}
