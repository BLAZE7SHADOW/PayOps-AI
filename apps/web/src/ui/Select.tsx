import * as RS from '@radix-ui/react-select';
import { CheckIcon, ChevronDownIcon } from '@radix-ui/react-icons';
import { cx } from './cx';

const ALL = '__all';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

interface SelectProps<T extends string> {
  /** Accessible name; also used as the "All …" option label. */
  label: string;
  allLabel: string;
  value: T | undefined;
  options: readonly SelectOption<T>[];
  onChange: (value: T | undefined) => void;
  mono?: boolean;
  width?: number;
}

/** Filter select with an explicit "All" option (Radix Select forbids empty string values). */
export function Select<T extends string>({ label, allLabel, value, options, onChange, mono, width = 176 }: SelectProps<T>) {
  const active = value !== undefined;
  return (
    <RS.Root value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : (v as T))}>
      <RS.Trigger
        aria-label={label}
        style={{ width }}
        className={cx(
          'transition-color inline-flex h-10 max-w-full items-center justify-between gap-2 rounded-md border bg-surface pr-3 pl-3 text-14 max-md:h-11',
          'hover:border-ink-2 data-[state=open]:border-accent',
          active ? 'border-control text-ink' : 'border-control text-ink-2',
        )}
      >
        <span className={cx('truncate', active && mono && 'font-mono text-12')}>
          <RS.Value />
        </span>
        <RS.Icon>
          <ChevronDownIcon className="text-ink-2" width={15} height={15} />
        </RS.Icon>
      </RS.Trigger>
      <RS.Portal>
        <RS.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-control bg-surface shadow-pop"
        >
          <RS.Viewport className="p-1">
            <Item value={ALL} label={allLabel} />
            {options.map((o) => (
              <Item key={o.value} value={o.value} label={o.label} mono={mono} />
            ))}
          </RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}

function Item({ value, label, mono }: { value: string; label: string; mono?: boolean }) {
  return (
    <RS.Item
      value={value}
      className={cx(
        'relative flex h-9 cursor-default items-center rounded-sm pr-2 pl-6 text-14 text-ink outline-none select-none',
        'data-[highlighted]:bg-accent-weak',
        mono && value !== ALL && 'font-mono text-12',
      )}
    >
      <RS.ItemIndicator className="absolute left-1.5 inline-flex">
        <CheckIcon width={14} height={14} className="text-accent" />
      </RS.ItemIndicator>
      <RS.ItemText>{label}</RS.ItemText>
    </RS.Item>
  );
}
