import { formatMoney, type MatrixCell, type StateMatrix as Matrix, type SystemKey } from '@payops/shared';
import { Link } from 'react-router';
import { StateMatrix } from '../../ui/StateMatrix';
import { linkButton } from './link-button';

const AMOUNT = 12_500_000;

const cell = (system: SystemKey, rest: Partial<MatrixCell>): MatrixCell => ({
  system,
  status: null,
  amountMinor: null,
  at: null,
  detail: null,
  mismatch: false,
  reference: false,
  ...rest,
});

/** One illustrative payment for the hero. It uses the same component as the real case screen. */
const EXAMPLE: Matrix = {
  mismatched: ['ORDER', 'LEDGER', 'WEBHOOK'],
  cells: {
    GATEWAY: cell('GATEWAY', { status: 'CAPTURED', amountMinor: AMOUNT, at: '2026-10-02T12:30:55.000Z', detail: 'Card payment taken', reference: true }),
    ORDER: cell('ORDER', { status: 'FAILED', amountMinor: AMOUNT, at: '2026-10-02T12:31:02.000Z', detail: 'Order marked failed', mismatch: true }),
    LEDGER: cell('LEDGER', { status: 'MISSING', detail: 'No accounting entry', mismatch: true }),
    WEBHOOK: cell('WEBHOOK', { status: 'FAILED', at: '2026-10-02T12:31:04.000Z', detail: 'Returned HTTP 500 after 3 attempts', mismatch: true }),
    SETTLEMENT: cell('SETTLEMENT', { status: 'PENDING', detail: 'Not in a payout batch yet' }),
  },
};

export const EXAMPLE_AMOUNT = formatMoney(AMOUNT);

export function Hero() {
  return (
    <section className="pt-6 pb-14 max-md:pb-10">
      <h1 className="max-w-[840px] text-[44px] leading-[1.1] font-semibold tracking-[-0.02em] text-ink max-md:text-[30px]">
        When a customer has paid but your records disagree, PayOps AI finds out why and fixes it.
      </h1>
      <p className="mt-5 max-w-[640px] text-[18px] leading-[1.6] text-ink-2 max-md:text-16">
        It compares five systems, explains the cause with evidence, applies a safe fix, and checks that the fix worked. A person approves
        anything risky.
      </p>
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Link to="/login" className={linkButton('primary')}>
          Open the demo
        </Link>
        <a href="#demo" className={linkButton('secondary')}>
          Watch the 3-minute video
        </a>
      </div>
      <p className="mt-3 text-13 text-ink-2">No sign-up. Choose a demo account on the next screen. All payments are simulated.</p>

      <figure className="mt-12 max-md:mt-8">
        <div className="relative overflow-x-auto rounded-lg border border-rule bg-surface">
          <div className="min-w-[760px]">
            <StateMatrix matrix={EXAMPLE} />
          </div>
        </div>
        <figcaption className="mt-3 text-14 text-ink-2">
          One payment of <span className="tabular font-mono text-ink">{EXAMPLE_AMOUNT}</span>, as five systems see it. The gateway took the money.
          Three other systems disagree.
        </figcaption>
      </figure>
    </section>
  );
}
