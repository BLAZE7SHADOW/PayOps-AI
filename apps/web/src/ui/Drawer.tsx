import * as RD from '@radix-ui/react-dialog';
import { Cross2Icon } from '@radix-ui/react-icons';
import type { ReactNode } from 'react';

interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible title; the visible header is rendered by children. */
  title: string;
  children: ReactNode;
  width?: number;
}

/** Right-hand sheet on top of the page. No scrim: the table stays readable beside it. */
export function Drawer({ open, onOpenChange, title, children, width = 680 }: DrawerProps) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40" />
        <RD.Content
          aria-describedby={undefined}
          style={{ width }}
          className="fixed top-0 right-0 bottom-0 z-50 flex max-w-[calc(100vw-48px)] flex-col border-l border-rule bg-paper shadow-pop outline-none"
        >
          <RD.Title className="sr-only">{title}</RD.Title>
          <RD.Close asChild>
            <button
              type="button"
              aria-label="Close"
              className="transition-color absolute top-3 right-3 z-10 grid size-8 place-items-center rounded-xs text-ink-2 hover:bg-surface-sunk hover:text-ink"
            >
              <Cross2Icon width={15} height={15} />
            </button>
          </RD.Close>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
