import { Skeleton } from '../ui/Skeleton';

/** Same grid as AppShell, so nothing moves when the session resolves and the real shell mounts. */
export function ShellSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading PayOps" className="grid h-screen grid-cols-[var(--nav-width)_minmax(0,1fr)] bg-paper">
      <div className="flex flex-col border-r border-rule">
        <div className="flex h-12 items-center border-b border-rule px-4">
          <span className="text-14 font-semibold tracking-[-0.005em] text-ink">PayOps</span>
          <span className="ml-1.5 text-14 text-ink-2">AI</span>
        </div>
        <div className="flex flex-col gap-px px-2 pt-3">
          {[72, 64, 80, 72, 64].map((w, i) => (
            <span key={i} className="flex h-8 items-center px-2">
              <Skeleton width={w} />
            </span>
          ))}
        </div>
        <div className="mt-auto border-t border-rule px-4 py-3">
          <Skeleton width={96} />
          <Skeleton width={56} height={16} className="mt-2" />
        </div>
      </div>
      <div className="flex min-w-0 flex-col">
        <div className="flex h-12 items-center border-b border-rule px-4 min-[1360px]:px-6">
          <Skeleton width={96} height={14} />
        </div>
        <div className="px-4 pt-5 min-[1360px]:px-6">
          <Skeleton width={160} height={20} />
          <Skeleton width={320} className="mt-2" />
          <Skeleton height={240} className="mt-6" />
        </div>
      </div>
    </div>
  );
}
