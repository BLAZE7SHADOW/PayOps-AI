/**
 * Class names that make a link look like the app's Button (ui/Button.tsx). A link is not a button, so
 * the landing page uses these on <Link> and <a> instead of nesting a <button> inside an anchor.
 */
const BASE =
  'transition-color inline-flex h-11 shrink-0 items-center justify-center rounded-md border px-5 text-15 font-medium whitespace-nowrap';
const PRIMARY = 'bg-accent text-surface border-accent hover:bg-accent-hover active:bg-accent-hover';
const SECONDARY = 'bg-surface text-ink border-control hover:bg-surface-sunk active:bg-surface-sunk';

export const linkButton = (variant: 'primary' | 'secondary') => `${BASE} ${variant === 'primary' ? PRIMARY : SECONDARY}`;
