import { Outlet } from 'react-router';
import { useRealtime } from '../lib/socket';
import { MobileNav, Nav } from './Nav';
import { TopBar } from './TopBar';
import { Notices } from './Notices';

/** Desktop rail and a compact mobile nav; main content owns scrolling. */
export function AppShell() {
  useRealtime();
  return (
    <div className="grid h-dvh grid-cols-1 bg-paper text-ink md:grid-cols-[var(--nav-width)_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only z-50 bg-surface px-3 py-2 text-13 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <Nav />
      <div className="flex min-h-0 min-w-0 flex-col">
        <MobileNav />
        <TopBar />
        <main id="main" tabIndex={-1} className="relative min-h-0 flex-1 overflow-auto px-4 pt-6 pb-10 outline-none min-[1360px]:px-8 md:px-6">
          <Outlet />
        </main>
      </div>
      <Notices />
    </div>
  );
}
