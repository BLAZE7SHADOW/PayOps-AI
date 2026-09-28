import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { qk } from '../lib/query-keys';
import { TooltipProvider } from '../ui/Tooltip';

function makeClient() {
  // A 401 from any request means the session ended (expired cookie, signed out elsewhere).
  // Clearing the session query sends the auth guard to /login?next=<current path>.
  const onError = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) client.setQueryData(qk.session(), null);
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        // Retry network blips, not 4xx answers from the server.
        retry: (count, err) => count < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
      },
    },
  });
  return client;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(makeClient);
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={300} skipDelayDuration={100}>
        {children}
      </TooltipProvider>
    </QueryClientProvider>
  );
}
