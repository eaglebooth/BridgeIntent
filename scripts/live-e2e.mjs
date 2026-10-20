import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const sdk = await import(pathToFileURL('G:/Genlayer/UnlockCheck/frontend/node_modules/genlayer-js/dist/index.js'));
const chains = await import(pathToFileURL('G:/Genlayer/UnlockCheck/frontend/node_modules/genlayer-js/dist/chains/index.js'));
const { createAccount, createClient } = sdk;
const { studionet } = chains;

const CONTRACT = process.env.BRIDGEINTENT_CONTRACT || '0x5C893d0aAD68Cc5EaF9a0953C57CFea0F93B7E14';
const EXPECTED_A = '0xeb57bc7125fa60d7482ce12058397369ab3581f8';
const EXPECTED_B = '0x2da5393d7bbb9a037dc3abb56dbbc5c150fc843f';
const CLI_ENTRY = process.env.GENLAYER_CLI_ENTRY || 'C:/Users/admin/AppData/Roaming/npm/node_modules/genlayer/dist/index.js';
const keytar = createRequire(CLI_ENTRY)('keytar');
const keyA = await keytar.getPassword('genlayer-cli', 'account:dbl-owner');
const keyB = await keytar.getPassword('genlayer-cli', 'account:dbl-adapter');
if (!keyA || !keyB) throw new Error('Unlock the two authorized GenLayer CLI test accounts before running.');
const accountA = createAccount(keyA.startsWith('0x') ? keyA : `0x${keyA}`);
const accountB = createAccount(keyB.startsWith('0x') ? keyB : `0x${keyB}`);
if (accountA.address.toLowerCase() !== EXPECTED_A || accountB.address.toLowerCase() !== EXPECTED_B) {
  throw new Error('Test signer identity mismatch; no transaction was submitted.');
}

const clientA = createClient({ chain: studionet, account: accountA });
const clientB = createClient({ chain: studionet, account: accountB });
const sourcePath = resolve('contracts/bridge_intent.py');
const localSource = readFileSync(sourcePath);
const deployedSource = Buffer.from(await clientA.getContractCode(CONTRACT), 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
if (!localSource.equals(deployedSource)) throw new Error('Deployed contract source does not exactly match local source; no transaction submitted.');

const run = process.argv[2] || new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
if (!/^[a-zA-Z0-9_-]{1,24}$/.test(run)) throw new Error('Invalid run identifier.');
const outDir = resolve('docs/live-evidence');
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, `studionet-${run}.json`);
const baseReport = {
  project: 'BridgeIntent', run, network: 'GenLayer StudioNet', chain_id: 61999,
  contract: CONTRACT,
  source_parity: { byte_for_byte: true, byte_length: localSource.length, local_sha256: sha256(localSource), deployed_sha256: sha256(deployedSource) },
  signing_method: 'GenLayerJS SDK; authorized test-account keys read in memory from GenLayer CLI OS keychain.',
  actors: { walletA: accountA.address, walletB: accountB.address },
  scope: 'Live schema-v2 create, unauthorized-binder rejection, invalid-receipt fail-closed assessment, nonce replay rejection, and finalized state readback. Not a valid-receipt MATCH/DIVERGED test.',
  started_at: new Date().toISOString(), steps: [], assertions: [],
};
const report = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : baseReport;
const save = () => writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
delete report.error;
const createBaseline = report.steps.find((item) => item.label === 'wallet-a-create-intent')?.stats_before;
if (createBaseline) report.initial_stats = createBaseline;
if (run === '20261020024950' && !report.steps.some((item) => item.label === 'wallet-a-create-intent')) {
  report.intent_id = 'live-20261020024950';
  report.steps.push({ label: 'wallet-a-create-intent', function: 'create_intent', args: ['live-20261020024950', '42161', '8453', 'Recipient receives the declared destination asset', 'create-20261020024950'], hash: '0x4b1754509e88e3fbea4cfcf843d8d9f7a3a35b0b15658a61bd438d5e75c642e1', stats_before: report.initial_stats, recovered_after_tool_serialization_failure: true });
  save();
}
const check = (pass, name, details = {}) => {
  const assertion = { name, pass: Boolean(pass), details, at: new Date().toISOString() };
  const existing = report.assertions.findIndex((item) => item.name === name);
  if (existing >= 0) report.assertions[existing] = assertion; else report.assertions.push(assertion);
  save();
  if (!pass) throw new Error(`Assertion failed: ${name}`);
};
const read = (client, functionName, args = []) => client.readContract({ address: CONTRACT, functionName, args, transactionHashVariant: 'latest-final' });
const json = (value) => JSON.parse(String(value));
const all = (value) => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
function leaderResult(tx) {
  const leader = all(tx.consensus_data?.leader_receipt).find((item) => item?.mode === 'leader') || all(tx.consensus_data?.leader_receipt)[0];
  return { leader, execution: leader?.genvm_result?.error_code ? 'ERROR' : String(leader?.execution_result || tx.txExecutionResultName || 'UNKNOWN').toUpperCase() };
}
async function submit(label, client, functionName, args, expectsSuccess) {
  const before = json(await read(clientA, 'get_stats'));
  let step = report.steps.find((item) => item.label === label);
  const isResuming = Boolean(step?.hash);
  let hash = step?.hash;
  if (!hash) {
    const raw = await client.writeContract({ address: CONTRACT, functionName, args, value: 0n });
    hash = typeof raw === 'string' ? raw : raw.txId;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash || '')) throw new Error(`${label}: invalid SDK transaction hash`);
  if (!step) {
    step = { label, function: functionName, args: args.map((value) => typeof value === 'bigint' ? value.toString() : value), hash, stats_before: before, submitted_at: new Date().toISOString() };
    report.steps.push(step);
    save();
  }
  console.log(`${label}: ${isResuming ? 'resuming' : 'submitted'} ${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash, status: 'FINALIZED', interval: 2500, retries: 480 });
  const tx = await client.getTransaction({ hash });
  const { leader, execution } = leaderResult(tx);
  const status = String(receipt.statusName || tx.statusName || '').toUpperCase();
  const consensus = String(tx.result_name || '').toUpperCase();
  const successful = status === 'FINALIZED' && consensus === 'MAJORITY_AGREE' && execution === 'SUCCESS' && !leader?.result?.status?.includes?.('error');
  const failed = status === 'FINALIZED' && consensus === 'MAJORITY_AGREE' && execution !== 'SUCCESS';
  const after = json(await read(clientA, 'get_stats'));
  step = { ...(step || {}), label, function: functionName, args: args.map((value) => typeof value === 'bigint' ? value.toString() : value), hash, status, consensus, execution, leader_status: leader?.result?.status || null, stats_before: isResuming && step.stats_before ? step.stats_before : before, stats_after: isResuming && step.stats_after ? step.stats_after : after, at: new Date().toISOString() };
  const priorIndex = report.steps.findIndex((item) => item.label === label);
  if (priorIndex >= 0) report.steps[priorIndex] = step; else report.steps.push(step);
  save();
  check(expectsSuccess ? successful : failed, `${label}: ${expectsSuccess ? 'successful' : 'expected failed'} finalized execution`, { hash, status, consensus, execution, leader_status: step.leader_status });
  return step;
}

try {
  const schema = String(await read(clientA, 'get_schema_version'));
  const initial = json(await read(clientA, 'get_stats'));
  report.schema = schema; report.initial_stats ||= initial; save();
  check(schema === 'bridgeintent/2', 'schema matches BridgeIntent v2', { schema });

  const intentId = `live-${run}`.toLowerCase();
  const createNonce = `create-${run}`.toLowerCase();
  const assessNonce = `assess-${run}`.toLowerCase();
  report.intent_id = intentId;
  const create = await submit('wallet-a-create-intent', clientA, 'create_intent', [intentId, 42161n, 8453n, 'Recipient receives the declared destination asset', createNonce], true);
  const owner = accountA.address.toLowerCase();

  const fakeDeposit = `0x${'a'.repeat(64)}`;
  const fakeFill = `0x${'b'.repeat(64)}`;
  const unauthorized = await submit('wallet-b-cannot-bind-wallet-a-intent', clientB, 'bind_evidence', [owner, intentId, fakeDeposit, fakeFill], false);
  check(unauthorized.stats_after.intent_count === unauthorized.stats_before.intent_count && unauthorized.stats_after.assessment_count === unauthorized.stats_before.assessment_count,
    'unauthorized binder causes no state mutation', { before: unauthorized.stats_before, after: unauthorized.stats_after });

  await submit('wallet-a-bind-deliberately-fake-receipts', clientA, 'bind_evidence', [owner, intentId, fakeDeposit, fakeFill], true);
  const assess = await submit('wallet-b-assess-fake-receipts-fail-closed', clientB, 'assess', [owner, intentId, assessNonce], true);
  const assessmentId = createHash('sha256').update(`${owner}:${intentId}:${accountB.address.toLowerCase()}:${assessNonce}`).digest('hex');
  const assessment = json(await read(clientB, 'get_assessment', [assessmentId]));
  report.assessment_id = assessmentId; report.assessment_readback = assessment; save();
  check(assessment.status === 'INDETERMINATE' && assessment.verdict === 'INSUFFICIENT', 'invalid receipt hashes produce fail-closed INDETERMINATE result', { status: assessment.status, verdict: assessment.verdict, reason: assessment.reason });
  check(assessment.assessor.toLowerCase() === accountB.address.toLowerCase() && assessment.intent_owner.toLowerCase() === owner, 'assessment readback matches signer and intent owner', { assessor: assessment.assessor, intent_owner: assessment.intent_owner });

  const replay = await submit('wallet-b-replayed-assessment-nonce-rejected', clientB, 'assess', [owner, intentId, assessNonce], false);
  check(replay.stats_after.assessment_count === replay.stats_before.assessment_count, 'replayed assessment nonce leaves state unchanged', { before: replay.stats_before, after: replay.stats_after });
  const intent = json(await read(clientA, 'get_intent', [owner, intentId]));
  const finalStats = json(await read(clientA, 'get_stats'));
  report.intent_readback = intent; report.final_stats = finalStats;
  check(intent.evidence_bound === true && intent.deposit_tx === fakeDeposit && intent.fill_tx === fakeFill, 'finalized intent state matches submitted evidence', { evidence_bound: intent.evidence_bound, deposit_tx: intent.deposit_tx, fill_tx: intent.fill_tx });
  const baseline = report.initial_stats;
  check(finalStats.intent_count === baseline.intent_count + 1 && finalStats.assessment_count === baseline.assessment_count + 1, 'only accepted create and assessment advanced counts', { initial: baseline, final: finalStats });
  report.completed_at = new Date().toISOString();
  report.all_assertions_pass = report.assertions.every((item) => item.pass);
  report.outcome = report.all_assertions_pass ? 'live_fail_closed_and_authorization_e2e_verified' : 'live_e2e_incomplete';
  save(); console.log(`Evidence saved: ${outPath}`);
} catch (error) {
  report.error = String(error?.stack || error).slice(0, 3000); report.completed_at = new Date().toISOString(); save();
  console.error(`Live E2E stopped. Partial evidence: ${outPath}`); console.error(String(error)); process.exitCode = 1;
}
