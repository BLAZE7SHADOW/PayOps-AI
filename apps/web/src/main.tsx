import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles/index.css';
import { App } from './app/App';

async function start() {
  // Mock API for UI work without the server. The DEV check is statically false in
  // production builds, so the mocks and their fixtures are never bundled.
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK_API === '1') {
    const { installMockFetch } = await import('./mocks/server');
    installMockFetch();
  }
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing from index.html');
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
