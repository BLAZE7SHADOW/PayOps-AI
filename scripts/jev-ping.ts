/**
 * Live smoke test for the Jev (TypeSafe System One) connection: one narrow J1-shaped question,
 * printed confidence, never the API key. `pnpm jev:ping` — requires TYPESAFE_JEV_API_KEY in .env.
 * Exercises the same adapter and model pin the agent graph uses (docs/03-agent-system.md §4).
 */
import { choice, JevDecisionAdapter, loadServerEnv, noul } from '@payops/core';

async function main() {
  const env = loadServerEnv();
  if (!env.TYPESAFE_JEV_API_KEY) {
    console.error('TYPESAFE_JEV_API_KEY is not set. Add it to .env before running jev:ping.');
    process.exitCode = 1;
    return;
  }

  console.warn(`Pinging Jev (model=${env.JEV_MODEL})...`);
  const adapter = new JevDecisionAdapter({
    apiKey: env.TYPESAFE_JEV_API_KEY,
    model: env.JEV_MODEL,
  });

  const started = Date.now();
  const result = await adapter.ask({
    tag: 'J1_INTAKE',
    state: { untrusted_text: 'The refund never arrived and I need it back today.' },
    questions: {
      complaint_type: choice('What kind of complaint is this?', {
        charged_not_delivered: 'Customer was charged but did not receive the goods or service.',
        double_charged: 'Customer was charged more than once for the same order.',
        refund_not_received: 'Customer is waiting on a refund that has not arrived.',
        unauthorized: 'Customer says they did not authorize the charge.',
        other: 'None of the above.',
      }),
      urgency: noul('The author says they are losing money or access right now.'),
    },
  });
  const ms = Date.now() - started;

  console.warn(`Jev responded in ${ms}ms:`);
  console.warn(JSON.stringify(result, null, 2));
  console.warn('OK: Jev connection and model pin are working.');
}

main().catch((err) => {
  console.error('jev:ping failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
