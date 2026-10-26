/**
 * Writes the fixture the Python agent tool layer is tested against (D086): for every case of the demo seed, the case brief, the output of every tool and the
 * proposal built for every root cause, as the TypeScript code computed them. Output: python/payops/tests/fixtures/agent_tools.json.gz
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createCore } from '@payops/core';
import { fixedClock, startTestDatabase } from '@payops/core/testing';
import { ROOT_CAUSES } from '@payops/shared';
import { remoteCaseBrief, remoteProposal, remoteRunTools } from '../../agents/src/remote';
import { ALL_TOOLS } from '../../agents/src/tools';
import { seedDemoCases, seedWorld } from '../../simulator/src/index';

const NOW = '2026-09-28T12:00:00.000Z';

async function main() {
  process.env.NODE_ENV = 'test';
  const t = await startTestDatabase();
  try {
    const core = createCore({ db: t.db, clock: fixedClock(NOW), events: { publish: () => {} } });
    await seedWorld(t.db, core.clock.now());
    await seedDemoCases(core);
    const cases = (await core.cases.list({ scope: 'all', limit: 100 } as never)).items;
    const out: Record<string, unknown> = {};
    for (const c of cases) {
      const brief = await remoteCaseBrief(core, c.id);
      const tools = await remoteRunTools(core, c.id, ALL_TOOLS.map((x) => x.name));
      const proposals: Record<string, unknown> = {};
      for (const rootCause of ROOT_CAUSES) {
        const diagnosis = { rootCause, narrative: `Narrative for ${rootCause}.`, confidence: 0.9, supportingFindingIds: [], path: 'FAST' as const };
        proposals[rootCause] = await remoteProposal(core, c.id, diagnosis as never, []);
      }
      out[c.displayId] = { brief, tools, proposals };
    }
    writeFileSync(resolve(import.meta.dirname, '../../../python/payops/tests/fixtures/agent_tools.json.gz'), gzipSync(JSON.stringify({ now: NOW, cases: out })));
    console.log(`cases: ${Object.keys(out).length}`);
  } finally {
    await t.close();
  }
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
