import { RouterProvider } from 'react-router';
import { Providers } from './providers';
import { router } from './router';
import { ServerWakeNotice } from './ServerWakeNotice';

export function App() {
  return (
    <Providers>
      <ServerWakeNotice />
      <RouterProvider router={router} />
    </Providers>
  );
}
