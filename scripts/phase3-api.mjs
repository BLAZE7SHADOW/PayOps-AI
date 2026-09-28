// Local acceptance helper. Prints only ids/statuses, never configuration or provider errors.
import { readFile, writeFile } from 'node:fs/promises';
const base = 'http://127.0.0.1:4000';
const action = process.argv[2];
const stateFile = '.data/phase3-acceptance.json';
let cookie;
async function api(path, body) {
  const res = await fetch(`${base}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}
await api('/auth/demo-login', { email: action === 'approve' ? 'manager@payops.dev' : 'ops@payops.dev' });
if (action === 'start') {
  const scenario = process.argv[3];
  const generated = await api('/simulator/scenarios', { scenario, seed: Number(process.argv[4] ?? 3101) });
  const caseId = generated.casesOpened[0].id;
  const { runId } = await api(`/cases/${caseId}/runs`, { scenarioKey: scenario });
  let state = [];
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch { /* first scenario */ }
  state.push({ scenario, caseId, runId });
  await writeFile(stateFile, JSON.stringify(state, null, 2));
  console.warn(JSON.stringify({ scenario, caseId, runId }));
} else {
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  for (const item of state) {
    const run = await api(`/runs/${item.runId}`);
    if (action === 'approve' && run.status === 'AWAITING_APPROVAL') {
      await api(`/approvals/${run.approvalId}/decision`, { decision: 'APPROVE' });
      console.warn(JSON.stringify({ runId: run.id, approved: true }));
    } else {
      const steps = await api(`/runs/${run.id}/steps`);
      console.warn(JSON.stringify({ ...item, status: run.status, path: run.path, tier: run.policy?.tier, verdict: run.validation?.verdict, budget: run.budget, steps: steps.items.length, diagnosis: run.diagnosis?.rootCause, fallbacks: steps.items.filter(s => s.payload.fallback).map(s => ({ node: s.node, fallback: true })), triageSteps: steps.items.filter(s => s.node === 'triage').length }));
    }
  }
}
