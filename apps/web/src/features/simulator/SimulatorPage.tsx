import { useState } from 'react';
import { SCENARIOS } from '@payops/shared';
import { useDocumentTitle } from '../../lib/use-document-title';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { ErrorState } from '../../ui/ErrorState';
import { PageHeader } from '../../ui/PageHeader';
import { useResetDemo } from './api';
import { ScenarioRow } from './ScenarioRow';

export function SimulatorPage() {
  useDocumentTitle('Simulator');
  // Bumping the epoch remounts rows so stale results disappear after a reset.
  const [epoch, setEpoch] = useState(0);

  return (
    <>
      <PageHeader
        title="Simulator"
        meta="Generate payments with a known fault. Detection runs right after, and any case it opens appears in Exceptions."
        actions={<ResetButton onDone={() => setEpoch((e) => e + 1)} />}
      />
      <div className="border border-rule bg-surface" role="list" aria-label="Scenarios">
        <div
          aria-hidden="true"
          className="grid h-8 grid-cols-[minmax(0,1fr)_176px_96px_72px_96px] items-center gap-4 border-b border-rule bg-surface-sunk px-4 text-12 font-medium text-ink-2"
        >
          <span>Scenario</span>
          <span>Expected case</span>
          <span>Seed</span>
          <span>Noise</span>
          <span />
        </div>
        {SCENARIOS.map((s) => (
          <ScenarioRow key={`${s.key}:${epoch}`} scenario={s} />
        ))}
      </div>
      <p className="mt-3 text-12 text-ink-2">
        Seed makes a run reproducible; leave it empty for a random one. Noise adds up to 50 healthy payments around the scenario.
      </p>
    </>
  );
}

function ResetButton({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const reset = useResetDemo();
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Reset demo data
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset.reset();
        }}
        title="Reset demo data"
        description="This removes every generated payment, order, case and audit event, then restores the baseline data. It cannot be undone."
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button
              variant="danger"
              disabled={reset.isPending}
              onClick={() =>
                reset.mutate(undefined, {
                  onSuccess: () => {
                    setOpen(false);
                    onDone();
                  },
                })
              }
            >
              {reset.isPending ? 'Resetting' : 'Reset demo data'}
            </Button>
          </>
        }
      >
        {reset.isError ? <ErrorState className="mt-3 border border-rule px-3 py-3" title="Reset failed." error={reset.error} /> : null}
      </Dialog>
    </>
  );
}
