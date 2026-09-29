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
  const showcase = SCENARIOS.filter((scenario) => scenario.key.startsWith('showcase_'));
  const standard = SCENARIOS.filter((scenario) => !scenario.key.startsWith('showcase_'));
  const row = (s: (typeof SCENARIOS)[number]) => <ScenarioRow key={`${s.key}:${epoch}`} scenario={s} recordedSeeds={recorded.filter((r) => r.scenario === s.key).map((r) => r.seed)} replay={aiMode === 'REPLAY'} />;

  return (
    <>
      <PageHeader
        title="Simulator"
        meta="Generate payments with a known fault. Detection runs right after, and any case it opens appears in Exceptions."
        actions={<ResetActions onDone={() => setEpoch((e) => e + 1)} />}
      />
      <section aria-labelledby="showcase-title" className="mt-6">
        <h2 id="showcase-title" className="text-18 font-semibold">Critical case showcase</h2>
        <p className="mt-1 mb-3 text-14 text-ink-2">Four high-value faults that were investigated with live model responses, passed policy review where required, and passed independent verification. Choose a recorded seed in replay mode.</p>
        <div className="overflow-hidden rounded-lg border border-rule bg-surface" role="list" aria-label="Critical showcase scenarios">{showcase.map(row)}</div>
      </section>
      <section aria-labelledby="other-scenarios-title" className="mt-8">
        <h2 id="other-scenarios-title" className="text-18 font-semibold">Other scenarios</h2>
        <p className="mt-1 mb-3 text-14 text-ink-2">Explore everyday exceptions, risk review, recovery attempts and a healthy-payment control.</p>
        <div className="overflow-hidden rounded-lg border border-rule bg-surface" role="list" aria-label="Other scenarios">{standard.map(row)}</div>
      </section>
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
