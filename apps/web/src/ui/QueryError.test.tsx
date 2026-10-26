import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { QueryError } from './ErrorState';

describe('QueryError', () => {
  it('shows what failed and retries by refetching the query', async () => {
    const refetch = vi.fn();
    const error = new ApiError({ code: 'BOOM', message: 'It broke.', status: 500, requestId: 'req_1' });
    render(<QueryError title="Could not load payments." query={{ error, refetch }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load payments.');
    expect(screen.getByRole('alert')).toHaveTextContent('request req_1');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('offers no retry when the role is not allowed to see this', () => {
    const error = new ApiError({ code: 'FORBIDDEN', message: 'No.', status: 403 });
    render(<QueryError title="Could not load payments." query={{ error, refetch: vi.fn() }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('You do not have access to this.');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
