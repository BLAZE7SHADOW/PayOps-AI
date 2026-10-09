import type { ReactNode } from 'react';

/** A landing section: hairline rule on top, heading on the left and content on the right (stacked on phones). */
export function Section({ id, title, lead, children }: { id?: string; title: string; lead?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className="grid scroll-mt-4 grid-cols-12 gap-x-8 gap-y-6 border-t border-rule py-16 max-md:py-10">
      <div className="col-span-4 max-md:col-span-12">
        <h2 id={id ? `${id}-title` : undefined} className="text-[28px] leading-[1.2] font-semibold tracking-[-0.01em] text-ink max-md:text-24">
          {title}
        </h2>
        {lead ? <p className="mt-3 max-w-[34ch] text-16 leading-[1.55] text-ink-2">{lead}</p> : null}
      </div>
      <div className="col-span-8 max-md:col-span-12">{children}</div>
    </section>
  );
}

export const BODY = 'max-w-[62ch] text-[17px] leading-[1.65] text-ink';
