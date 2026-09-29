import { useState } from 'react';
import { SCENARIOS } from '@payops/shared';
import { useDocumentTitle } from '../../lib/use-document-title';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { ErrorState } from '../../ui/ErrorState';
import { PageHeader } from '../../ui/PageHeader';
import { formatTime } from '../../lib/format';
import { useAiMode } from '../../lib/use-ai-mode';
import { useRecordedRuns, useResetDemo, useResetStatus, useUndoReset } from './api';
import { ScenarioRow } from './ScenarioRow';

export function SimulatorPage() {
  useDocumentTitle('Simulator');
  // Bumping the epoch remounts rows so stale results disappear after a reset.
  const [epoch, setEpoch] = useState(0);
  const aiMode = useAiMode();
  const recorded = useRecordedRuns().data ?? [];

  return (
    <>
      <PageHeader
        title="Simulator"
        meta="Generate payments with a known fault. Detection runs right after, and any case it opens appears in Exceptions."
        actions={<ResetActions onDone={() => setEpoch((e) => e + 1)} />}
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
          <ScenarioRow key={`${s.key}:${epoch}`} scenario={s} recordedSeeds={recorded.filter((r) => r.scenario === s.key).map((r) => r.seed)} replay={aiMode === 'REPLAY'} />
        ))}
      </div>
      <p className="mt-3 text-12 text-ink-2">
        {aiMode === 'REPLAY'
          ? 'This demo replays recorded AI responses. Pick a recorded seed under a scenario (or leave the seed empty to use the first one); other seeds still create the case, but the investigation escalates because no response was recorded for it. '
          : ''}
        Seed makes a run reproducible; leave it empty for a random one. Noise adds up to 50 healthy payments around the scenario.
      </p>
    </>
  );
}

function ResetActions({ onDone }: { onDone: () => void }) {
  const status = useResetStatus();
  const undo = useUndoReset();
  return (
    <div className="flex items-center gap-3">
      {undo.isError ? <span role="alert" className="text-12 text-bad">{undo.error instanceof Error ? undo.error.message : 'Undo failed.'}</span> : null}
      {status.data?.canUndo ? (
        <Button
          variant="secondary"
          disabled={undo.isPending}
          title={status.data.snapshotAt ? `Restores the data as it was at ${formatTime(status.data.snapshotAt)}` : undefined}
          onClick={() => undo.mutate(undefined, { onSuccess: onDone })}
        >
          {undo.isPending ? 'Restoring' : 'Undo last reset'}
        </Button>
      ) : null}
      <ResetButton onDone={onDone} />
    </div>
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
        description="This removes every generated payment, order, case and audit event, then restores the baseline data. This demo is shared, so anyone can reset it. Use Undo last reset to bring the previous data back."
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
