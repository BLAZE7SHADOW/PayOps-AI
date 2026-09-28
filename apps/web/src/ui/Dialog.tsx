import * as RD from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer: ReactNode;
}

export function Dialog({ open, onOpenChange, title, description, children, footer }: DialogProps) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-ink/15" />
        <RD.Content className="fixed top-[20vh] left-1/2 z-50 w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-sm border border-rule bg-surface shadow-pop">
          <div className="px-5 pt-4 pb-3">
            <RD.Title className="text-16 font-semibold text-ink">{title}</RD.Title>
            {description ? <RD.Description className="mt-1 text-13 text-ink-2">{description}</RD.Description> : null}
            {children}
          </div>
          <div className="flex justify-end gap-2 border-t border-rule bg-paper px-5 py-3">{footer}</div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

export const DialogClose = RD.Close;
