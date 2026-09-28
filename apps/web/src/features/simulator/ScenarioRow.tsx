import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { CASE_TYPE_LABEL, type GenerateScenarioResult, type ScenarioInfo } from '@payops/shared';
import { plural } from '../../lib/format';
import { Button } from '../../ui/Button';
import { ErrorState } from '../../ui/ErrorState';
import { Input } from '../../ui/Input';
import { useGenerateScenario } from './api';

const MAX_IDS = 4;

export function ScenarioRow({ scenario }: { scenario: ScenarioInfo }) {
  const id = useId();
  const [seed, setSeed] = useState('');
  const [noise, setNoise] = useState('0');
  const gen = useGenerateScenario();

  const seedNum = seed.trim() === '' ? undefined : Number(seed);
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
      <form onSubmit={submit} aria-labelledby={`${id}-title`} className="grid grid-cols-[minmax(0,1fr)_176px_96px_72px_96px] items-start gap-4 px-4 py-3">
        <div className="min-w-0">
          <p className="flex items-baseline gap-2">
            <span id={`${id}-title`} className="text-14 font-medium text-ink">
              {scenario.title}
            </span>
            <span className="truncate font-mono text-12 text-ink-2">{scenario.key}</span>
          </p>
          <p className="mt-0.5 max-w-[72ch] text-13 text-ink-2">{scenario.description}</p>
        </div>
        <p className="pt-1.5 text-13">
          {scenario.expectedCaseType ? CASE_TYPE_LABEL[scenario.expectedCaseType] : <span className="text-ink-2">No case</span>}
        </p>
        <Input
          mono
          inputMode="numeric"
          aria-label={`Seed for ${scenario.title}`}
          aria-invalid={!seedValid || undefined}
          placeholder="random"
          value={seed}
          onChange={(e) => setSeed(e.target.value.replace(/[^\d]/g, ''))}
          className={seedValid ? 'w-full' : 'w-full border-bad'}
        />
        <Input
          mono
          inputMode="numeric"
          aria-label={`Noise payments for ${scenario.title}, 0 to 50`}
          aria-invalid={!noiseValid || undefined}
          value={noise}
          onChange={(e) => setNoise(e.target.value.replace(/[^\d]/g, '').slice(0, 2))}
          className={noiseValid ? 'w-full' : 'w-full border-bad'}
        />
        <Button type="submit" variant="secondary" disabled={gen.isPending || !seedValid || !noiseValid} className="w-full">
          {gen.isPending ? 'Generating' : 'Generate'}
        </Button>
      </form>
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
                <Link to={`/cases/${c.id}`} className="link font-mono">
                  {c.displayId}
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
