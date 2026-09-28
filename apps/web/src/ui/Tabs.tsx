import * as RT from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';
import { cx } from './cx';

interface TabsProps<T extends string> {
  label: string;
  value: T;
  onChange: (v: T) => void;
  tabs: ReadonlyArray<{ value: T; label: ReactNode; content: ReactNode }>;
}

/** Underlined text tabs on a hairline. Used for resolution attempts. */
export function Tabs<T extends string>({ label, value, onChange, tabs }: TabsProps<T>) {
  return (
    <RT.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <RT.List aria-label={label} className="flex gap-4 border-b border-rule px-4">
        {tabs.map((t) => (
          <RT.Trigger
            key={t.value}
            value={t.value}
            className={cx(
              'transition-color -mb-px h-9 border-b-2 border-transparent font-mono text-12 text-ink-2',
              'hover:text-ink data-[state=active]:border-accent data-[state=active]:font-medium data-[state=active]:text-ink',
            )}
          >
            {t.label}
          </RT.Trigger>
        ))}
      </RT.List>
      {tabs.map((t) => (
        <RT.Content key={t.value} value={t.value} className="outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent">
          {t.content}
        </RT.Content>
      ))}
    </RT.Root>
  );
}
