import type { ReactNode } from 'react';
import { useDocumentTitle } from '../../lib/use-document-title';
import { PublicLayout } from './PublicLayout';

export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  useDocumentTitle(title);
  return (
    <PublicLayout>
      <div className="max-w-[72ch]">
        <h1 className="text-20 font-semibold text-ink">{title}</h1>
        <p className="mt-1 text-13 text-ink-2">Last updated {updated}</p>
        <div className="mt-6 flex flex-col gap-6 text-14 leading-[1.6] text-ink [&_h2]:mb-1 [&_h2]:text-16 [&_h2]:font-semibold [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5">
          {children}
        </div>
      </div>
    </PublicLayout>
  );
}
