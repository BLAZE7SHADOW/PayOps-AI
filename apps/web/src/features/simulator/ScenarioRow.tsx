import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { CASE_TYPE_LABEL, type GenerateScenarioResult, type ScenarioInfo } from '@payops/shared';
import { plural } from '../../lib/format';
import { Button } from '../../ui/Button';
import { ErrorState } from '../../ui/ErrorState';
import { Input } from '../../ui/Input';
import { Tag } from '../../ui/Tag';
import { useGenerateScenario } from './api';

const MAX_IDS = 4;

export function ScenarioRow({ scenario, recordedSeeds = [], replay = false }: { scenario: ScenarioInfo; recordedSeeds?: number[]; replay?: boolean }) {
  const id = useId();
  const [seed, setSeed] = useState('');
  const [noise, setNoise] = useState('0');
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const gen = useGenerateScenario();
  const needsRealApi = import.meta.env.DEV && import.meta.env.VITE_MOCK_API === '1' && scenario.key.startsWith('showcase_');

  // In REPLAY, an empty seed means the first recorded one; a random seed would have no recording.
  const seedNum = seed.trim() === '' ? (replay ? recordedSeeds[0] : undefined) : Number(seed);
  const noiseNum = Number(noise === '' ? 0 : noise);
  const seedValid = seedNum === undefined || (Number.isInteger(seedNum) && seedNum >= 0 && seedNum <= 2 ** 31);
  const noiseValid = Number.isInteger(noiseNum) && noiseNum >= 0 && noiseNum <= 50;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!seedValid || !noiseValid) return;
    gen.mutate({ scenario: scenario.key, seed: seedNum, noise: noiseNum });
  };

  return (
    <div role="listitem" className="border-b border-rule last:border-b-0">
      <button type="button" aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => setOpen((value) => !value)} className="flex w-full flex-col gap-3 px-5 py-4 text-left hover:bg-surface-sunk sm:flex-row sm:items-center sm:justify-between">
        <span className="min-w-0">
          <span className="flex flex-wrap items-baseline gap-2">
            <span id={`${id}-title`} className="text-14 font-medium text-ink">
              {scenario.title}
            </span>
            {scenario.key.startsWith('showcase_') ? <Tag tone="bad">CRITICAL</Tag> : null}
          </span>
          <span className="mt-0.5 block max-w-[72ch] text-13 text-ink-2">{scenario.description}</span>
        </span>
        <span className="text-13 text-ink-2 sm:shrink-0">{scenario.expectedCaseType ? CASE_TYPE_LABEL[scenario.expectedCaseType] : 'No case expected'} <span aria-hidden="true">{open ? '−' : '+'}</span></span>
      </button>
      {open ? <form id={`${id}-panel`} onSubmit={submit} aria-labelledby={`${id}-title`} className="border-t border-rule bg-paper px-5 py-4">
        <div className="max-w-2xl space-y-4">
          <p className="text-13 text-ink-2">Generate this scenario, then open its case to investigate the mismatch.</p>
          {recordedSeeds.length > 0 ? (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-12 text-ink-2">
              <span>Recorded seeds</span>
              {recordedSeeds.map((rs) => (
                <button key={rs} type="button" className="link tabular font-mono" onClick={() => setSeed(String(rs))}>
                  {rs}
                </button>
              ))}
            </p>
          ) : null}
          <button type="button" className="link text-13" aria-expanded={advanced} onClick={() => setAdvanced((value) => !value)}>{advanced ? 'Hide seed and noise options' : 'Set seed and noise'}</button>
          {advanced ? <div className="grid gap-3 sm:grid-cols-2">
            <p className="font-mono text-12 text-ink-2 sm:col-span-2">Scenario key: {scenario.key}</p>
            <label className="space-y-1 text-13"><span>Seed</span>
        <Input
          mono
          inputMode="numeric"
          aria-label={`Seed for ${scenario.title}`}
          aria-invalid={!seedValid || undefined}
          placeholder={replay && recordedSeeds[0] !== undefined ? String(recordedSeeds[0]) : 'random'}
          value={seed}
          onChange={(e) => setSeed(e.target.value.replace(/[^\d]/g, ''))}
          className={seedValid ? 'w-full' : 'w-full border-bad'}
        /></label>
            <label className="space-y-1 text-13"><span>Noise payments</span>
        <Input
          mono
          inputMode="numeric"
          aria-label={`Noise payments for ${scenario.title}, 0 to 50`}
          aria-invalid={!noiseValid || undefined}
          value={noise}
          onChange={(e) => setNoise(e.target.value.replace(/[^\d]/g, '').slice(0, 2))}
          className={noiseValid ? 'w-full' : 'w-full border-bad'}
        /></label>
          </div> : null}
        {needsRealApi ? <p className="text-13 text-ink-2">Run the local API to generate this recorded investigation. Mock data cannot reproduce its payment records.</p> : null}
        <Button type="submit" variant="primary" disabled={needsRealApi || gen.isPending || !seedValid || !noiseValid}>
          {gen.isPending ? 'Generating…' : 'Generate scenario'}
        </Button>
        </div>
      </form>
      : null}
      {!noiseValid ? <p className="px-4 pb-3 text-12 text-bad">Noise must be between 0 and 50.</p> : null}
      {gen.isError ? (
        <ErrorState className="border-t border-rule bg-paper py-3" title="Generation failed." error={gen.error} onRetry={() => gen.reset()} />
      ) : null}
      {gen.data ? <Result r={gen.data} /> : null}
    </div>
  );
}

function IdList({ label, ids }: { label: string; ids: string[] }) {
  if (ids.length === 0) return null;
  const shown = ids.slice(0, MAX_IDS);
  return (
    <p className="flex min-w-0 gap-2">
      <span className="w-20 shrink-0 text-ink-2">{label}</span>
      <span className="tabular min-w-0 font-mono break-all text-ink" title={ids.join('\n')}>
        {shown.join('  ')}
        {ids.length > MAX_IDS ? <span className="text-ink-2">{`  +${ids.length - MAX_IDS} more`}</span> : null}
      </span>
    </p>
  );
}

function Result({ r }: { r: GenerateScenarioResult }) {
  return (
    <div role="status" className="flex flex-col gap-1 border-t border-rule bg-paper px-4 py-3 text-12">
      <p className="flex gap-2">
        <span className="w-20 shrink-0 text-ink-2">Seed</span>
        <span className="tabular font-mono">{r.seed}</span>
      </p>
      <IdList label="Payments" ids={r.created.paymentIds} />
      <IdList label="Orders" ids={r.created.orderIds} />
      <IdList label="Batches" ids={r.created.batchIds} />
      <p className="flex gap-2">
        <span className="w-20 shrink-0 text-ink-2">Cases</span>
        {r.casesOpened.length ? (
          <span className="flex flex-wrap gap-x-3">
            {r.casesOpened.map((c) => (
              <span key={c.id}>
                <Link to={`/cases/${c.id}`} className="link inline-flex min-h-10 items-center font-mono text-14 font-medium">
                  Open {c.displayId}
                </Link>{' '}
                <span className="text-ink-2">{CASE_TYPE_LABEL[c.type]}</span>
              </span>
            ))}
          </span>
        ) : (
          <span className="text-ink-2">None opened. {plural(r.created.paymentIds.length, 'payment')} matched across all systems.</span>
        )}
      </p>
    </div>
  );
}
