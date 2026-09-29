import { Link } from 'react-router';
import { useDocumentTitle } from '../../lib/use-document-title';
import { Button } from '../../ui/Button';
import { Architecture } from './Architecture';
import { PublicLayout } from './PublicLayout';

const H2 = 'mt-10 mb-2 max-w-[72ch] text-16 font-semibold text-ink';
const P = 'mt-3 max-w-[72ch] text-14 leading-[1.6] text-ink';

/** Logged-out home page (docs/05 §11 Public pages). Prose, one real screenshot, one diagram. No cards. */
export function LandingPage() {
  useDocumentTitle('Payment reconciliation with a checked AI investigator');
  return (
    <PublicLayout>
      <h1 className="max-w-[72ch] text-24 leading-[1.25] font-semibold text-ink">Find payments where your systems disagree, and fix them with a paper trail.</h1>
      <p className={P}>
        PayOps AI compares what the payment gateway, the order service, the ledger, webhook deliveries and settlement each say about a
        payment. When they disagree it opens a case, investigates it, cites the evidence, proposes a fix, and checks the result. A person
        approves anything risky. The product works with the AI turned off.
      </p>
      <p className="mt-5 flex items-center gap-3">
        <Link to="/login">
          <Button variant="primary">Open the demo</Button>
        </Link>
        <span className="text-13 text-ink-2">Runs locally with simulated data. Sign in with a demo account.</span>
      </p>

      <figure className="mt-8">
        <img
          src="/landing/case-screen.jpg"
          alt="The case screen for a resolved payment mismatch. A state matrix shows the gateway, order, ledger, webhook and settlement now agree. Below it are the investigation steps, the root cause with cited evidence references, and the evidence list."
          width={1512}
          height={805}
          className="block h-auto w-full border border-rule"
          loading="eager"
        />
        <figcaption className="mt-2 text-12 text-ink-2">
          The case screen after a verified fix. The state matrix shows one payment as five systems see it, and every finding cites its evidence.
        </figcaption>
      </figure>

      <h2 className={H2}>What it does</h2>
      <p className={P}>
        Nine kinds of fault are simulated, from a captured payment whose webhook failed to a settlement batch that is short. Detection rules
        flag the mismatch. An investigation gathers facts through read-only tools, and every finding cites the evidence it rests on. The
        proposed fix comes from a fixed catalog of nine actions, such as replaying a webhook or initiating a refund.
      </p>

      <h2 className={H2}>How decisions are made</h2>
      <p className={P}>
        Models propose and code decides. A model never touches the database, never does arithmetic or date math, and never approves or runs
        anything. Amounts are integer paise computed by code and passed in as facts.
      </p>
      <p className={P}>
        Narrow, typed choices go to Jev, which returns an answer with a confidence: screening customer notes, choosing which specialists to
        run, scoring risk, checking grounding, deciding whether to replan, and a fast diagnosis for well-known faults. Every one of those
        has a coded fallback if Jev is slow or unsure. Open-ended reasoning over the gathered evidence goes to Gemini, and its output must
        pass a schema check.
      </p>
      <p className={P}>
        A policy engine in code then assigns a tier: automatic, ops approval, manager approval, or blocked. Approvals need a second person.
        The executor runs each action once, using an idempotency key. Finally a separate validator re-reads the data and returns PASS,
        PARTIAL or FAIL. On FAIL the run replans within limits, or escalates to a person.
      </p>

      <h2 className={H2}>Architecture</h2>
      <div className="mt-3 border border-rule bg-surface p-3">
        <Architecture />
      </div>

      <h2 className={H2}>Try it</h2>
      <p className={P}>
        Sign in as an ops analyst, open the Simulator, generate the scenario named captured, order failed with seed 3201, and open the case
        it creates. Start an investigation and watch the steps, findings and evidence arrive. Then look at the Agent runs page for the
        counts, tokens and cost of that run. In this demo the AI answers are replayed from recordings, so no model calls are made.
      </p>
    </PublicLayout>
  );
}
