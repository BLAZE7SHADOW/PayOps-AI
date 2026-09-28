import * as RT from '@radix-ui/react-tabs';
import { cx } from './cx';

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
}

/** Tab list used as a segmented control (Open / Closed / All). Arrow keys move between options. */
export function Segmented<T extends string>({ label, value, options, onChange }: SegmentedProps<T>) {
  return (
    <RT.Root value={value} onValueChange={(v) => onChange(v as T)} activationMode="automatic">
      <RT.List aria-label={label} className="inline-flex h-8 rounded-xs border border-rule bg-surface p-0.5">
        {options.map((o) => (
          <RT.Trigger
            key={o.value}
            value={o.value}
            className={cx(
              'transition-color h-full rounded-xs px-3 text-13 text-ink-2',
              'hover:text-ink data-[state=active]:bg-accent-weak data-[state=active]:font-medium data-[state=active]:text-ink',
            )}
          >
            {o.label}
          </RT.Trigger>
        ))}
      </RT.List>
    </RT.Root>
  );
}
