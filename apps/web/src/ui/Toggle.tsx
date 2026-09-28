import { cx } from './cx';

interface ToggleProps {
  pressed: boolean;
  onPressedChange: (next: boolean) => void;
  label: string;
}

/** A filter toggle that reads as a checkbox: square box plus label, no pill switch. */
export function Toggle({ pressed, onPressedChange, label }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={pressed}
      onClick={() => onPressedChange(!pressed)}
      className={cx(
        'transition-color inline-flex h-8 items-center gap-2 rounded-xs border px-2.5 text-13',
        pressed ? 'border-accent bg-accent-weak text-ink' : 'border-rule bg-surface text-ink-2 hover:border-rule-strong',
      )}
    >
      <span
        aria-hidden="true"
        className={cx('grid size-3 place-items-center border', pressed ? 'border-accent bg-accent' : 'border-rule-strong bg-surface')}
      >
        {pressed ? <span className="size-1.5 bg-surface" /> : null}
      </span>
      {label}
    </button>
  );
}
