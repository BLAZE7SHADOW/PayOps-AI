import { Outlet } from 'react-router';
import { useRealtime } from '../lib/socket';
import { Nav } from './Nav';
import { TopBar } from './TopBar';
import { Notices } from './Notices';

/** Left nav 216px, top bar 48px, scrolling main (docs/05-ui-design.md §10). */
export function AppShell() {
  useRealtime();
  return (
    <div className="grid h-screen grid-cols-[var(--nav-width)_minmax(0,1fr)] bg-paper text-ink">
      <a
        href="#main"
        className="sr-only z-50 bg-surface px-3 py-2 text-13 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <Nav />
      <div className="flex min-h-0 min-w-0 flex-col">
        <TopBar />
        <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-auto px-4 min-[1360px]:px-6 pt-5 pb-10 outline-none">
          <Outlet />
        </main>
      </div>
      <Notices />
    </div>
  );
}
