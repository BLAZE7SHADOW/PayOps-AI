import { Fragment } from 'react';

// Entity ids (evt_…, pay_…, gwp_…), display ids (PAY-0042) and dotted event names in server copy.
const ID_RE = /(\b[a-z]{2,4}_[A-Za-z0-9]{4,}\b|\b[A-Z]{3}-\d{4}\b|\b[a-z]+\.[a-z_]+\b)/g;

/** Plain server text with ids set in mono, so "Replay payment.captured (evt_x1) …" scans quickly. */
export function MonoIds({ text }: { text: string }) {
  const parts = text.split(ID_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <span key={i} className="tabular font-mono text-[0.93em]">
            {p}
          </span>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}
