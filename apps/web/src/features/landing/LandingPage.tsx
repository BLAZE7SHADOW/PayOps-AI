import { Link } from 'react-router';
import { useDocumentTitle } from '../../lib/use-document-title';
import { Architecture } from './Architecture';
import { DemoVideo } from './DemoVideo';
import { Hero, EXAMPLE_AMOUNT } from './Hero';
import { PublicLayout } from './PublicLayout';
import { BODY, Section } from './Section';
import { Steps } from './Steps';
import { Trust } from './Trust';
import { linkButton } from './link-button';

/**
 * Logged-out home page. It explains the problem and the product in plain words first, then shows the
 * demo, then the evidence that the result can be trusted. D081 records why this departs from the
 * one-column prose layout that docs/05 section 11 first described.
 */
export function LandingPage() {
  useDocumentTitle('Payment reconciliation with a checked AI investigator');
  return (
    <PublicLayout landing>
      <Hero />

      <Section title="The problem">
        <div className="space-y-4">
          <p className={BODY}>A customer pays {EXAMPLE_AMOUNT} by card. The payment gateway takes the money.</p>
          <p className={BODY}>
            Then something small goes wrong. A message between two systems fails. The shop&apos;s order still says failed, and the accounting
            ledger has no entry for the payment.
          </p>
          <p className={BODY}>
            Now five systems tell five different stories. Today a person opens each one, compares them, works out which is right, and fixes
            the records by hand. It is slow, repetitive, and easy to get wrong.
          </p>
        </div>
      </Section>

      <Steps />
      <DemoVideo />
      <Trust />

      <Section title="Inside the product" lead="Real screens from the running demo.">
        <div className="space-y-10">
          <figure>
            <img
              src="/landing/overview.jpg"
              alt="The overview screen. It shows open exceptions, approvals waiting, performance for the last 7 days, and a chart of exceptions by type."
              width={1440}
              height={900}
              loading="lazy"
              className="block h-auto w-full rounded-lg border border-rule"
            />
            <figcaption className="mt-3 max-w-[62ch] text-14 leading-[1.6] text-ink-2">
              The overview shows what is open, what is waiting for approval, and how long cases take to resolve.
            </figcaption>
          </figure>
          <figure>
            <img
              src="/landing/case.jpg"
              alt="A resolved payment mismatch. The five systems now agree, a green banner says the fix was applied automatically and verified, and the investigation steps are listed below."
              width={1440}
              height={1100}
              loading="lazy"
              className="block h-auto w-full rounded-lg border border-rule"
            />
            <figcaption className="mt-3 max-w-[62ch] text-14 leading-[1.6] text-ink-2">
              A case lists the five systems side by side, then each investigation step and the evidence behind every finding.
            </figcaption>
          </figure>
        </div>
      </Section>

      <Section title="How it is built" lead="Plain code makes the decisions. The AI only proposes.">
        <p className={BODY}>
          A web app and an API sit on top of Postgres. Detection, approvals, execution and checking are ordinary tested code. A LangGraph
          workflow investigates each case and can only propose a fix from the fixed list.
        </p>
        <div className="mt-6 rounded-lg border border-rule bg-surface p-4">
          <Architecture />
        </div>
        <p className="mt-4 max-w-[62ch] text-14 leading-[1.6] text-ink-2">
          Built with React, Node, Postgres and LangGraph. Gemini does the open-ended reasoning, and Jev makes six small typed decisions, each
          with a coded fallback.
        </p>
      </Section>

      <Section title="Try it yourself">
        <ol className="max-w-[62ch] space-y-3 text-[17px] leading-[1.65] text-ink">
          <li>Open the demo and choose a demo account.</li>
          <li>Open any case on the Exceptions page and press Start investigation.</li>
          <li>Watch the steps and evidence arrive, then read the verified result.</li>
        </ol>
        <p className="mt-4 max-w-[62ch] text-14 leading-[1.6] text-ink-2">
          The AI answers in the demo are replayed from recordings, so no AI provider is called.
        </p>
        <p className="mt-6">
          <Link to="/login" className={linkButton('primary')}>
            Open the demo
          </Link>
        </p>
      </Section>
    </PublicLayout>
  );
}
