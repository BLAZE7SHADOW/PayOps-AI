import { LegalPage } from './LegalPage';

export function PrivacyPage() {
  return (
    <LegalPage title="Privacy" updated="29 September 2026">
      <section>
        <h2>What is stored</h2>
        <ul>
          <li>Simulated business data: payments, orders, ledger entries, cases, support notes and the audit log. None of it belongs to a real person.</li>
          <li>Agent records: each investigation step, the evidence gathered, findings, proposals and validation results.</li>
          <li>A session cookie after you sign in. It is signed, marked httpOnly, and lasts 8 hours. It is the only cookie used.</li>
        </ul>
      </section>
      <section>
        <h2>What is not collected</h2>
        <p>There is no analytics, advertising or tracking script. The sign-in form asks for a demo email and password only.</p>
      </section>
      <section>
        <h2>What is sent to AI providers</h2>
        <p>
          When the server runs in live mode, two providers receive data. Gemini receives structured case facts built for an investigation:
          statuses, amounts and internal ids, with personal details masked and display ids and timestamps left out. TypeSafe, which runs the
          Jev decision model, receives those same kinds of facts for typed decisions, and also the text of a support note so it can be screened
          for complaint type, urgency and instructions aimed at the AI. Text flagged as an injection attempt is quarantined and not used
          further.
        </p>
        <p>
          When the server runs in replay mode, as in this demo, answers come from recordings stored with the code. Nothing is sent to either
          provider.
        </p>
      </section>
      <section>
        <h2>Deleting data</h2>
        <p>An admin can reset all demo data from the Simulator page.</p>
      </section>
    </LegalPage>
  );
}
