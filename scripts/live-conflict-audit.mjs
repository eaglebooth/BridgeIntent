import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const sdk = await import(pathToFileURL('G:/Genlayer/UnlockCheck/frontend/node_modules/genlayer-js/dist/index.js'));
const chains = await import(pathToFileURL('G:/Genlayer/UnlockCheck/frontend/node_modules/genlayer-js/dist/chains/index.js'));
const { createAccount, createClient } = sdk;
const { studionet } = chains;

const CONTRACT = '0x5C893d0aAD68Cc5EaF9a0953C57CFea0F93B7E14';
const INTENT_ID = 'live-20261020024950';
const EXPECTED_A = '0xeb57bc7125fa60d7482CE12058397369AB3581f8';
const EXPECTED_B = '0x2da5393d7BBb9A037dc3abB56DbbC5C150fc843f';
const keytar = createRequire(process.env.GENLAYER_CLI_ENTRY || 'C:/Users/admin/AppData/Roaming/npm/node_modules/genlayer/dist/index.js')('keytar');
const keyA = await keytar.getPassword('genlayer-cli', 'account:dbl-owner');
const keyB = await keytar.getPassword('genlayer-cli', 'account:dbl-adapter');
if (!keyA || !keyB) throw new Error('Unlock the authorized GenLayer CLI test accounts before running.');
const accountA = createAccount(keyA.startsWith('0x') ? keyA : `0x${keyA}`);
const accountB = createAccount(keyB.startsWith('0x') ? keyB : `0x${keyB}`);
if (accountA.address.toLowerCase() !== EXPECTED_A.toLowerCase() || accountB.address.toLowerCase() !== EXPECTED_B.toLowerCase()) throw new Error('Test signer identity mismatch; no transaction was submitted.');
const clientA = createClient({ chain: studionet, account: accountA });
const clientB = createClient({ chain: studionet, account: accountB });
const json = (value) => JSON.parse(String(value));
const read = (client, functionName, args = []) => client.readContract({ address: CONTRACT, functionName, args, transactionHashVariant: 'latest-final' });
const values = (x) => Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : [];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const run = '20261020audit01';
const report = { project: 'BridgeIntent', run, contract: CONTRACT, network: 'GenLayer StudioNet', chain_id: 61999,
  note: 'Live conflict/adversarial follow-up against the user-provided deployed revision. This deployed revision predates local support for current Across FundsDeposited/FilledRelay topics.',
  actors: { walletA: accountA.address, walletB: accountB.address }, started_at: new Date().toISOString(), steps: [] };
const outDir = resolve('docs/live-evidence'); mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, `audit-${run}.json`);
const save = () => writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
async function submit(label, client, method, args, expectSuccess) {
  const before = json(await read(clientA, 'get_stats'));
  const raw = await client.writeContract({ address: CONTRACT, functionName: method, args, value: 0n });
  const hash = typeof raw === 'string' ? raw : raw.txId;
  if (!/^0x[\da-f]{64}$/i.test(hash || '')) throw new Error(`${label}: no SDK transaction hash`);
  const step = { label, method, args: args.map((value) => typeof value === 'bigint' ? value.toString() : value), hash, explorer: `https://explorer-studio.genlayer.com/tx/${hash}`, stats_before: before, submitted_at: new Date().toISOString() };
  report.steps.push(step); save(); console.log(`${label} ${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash, status: 'FINALIZED', interval: 2500, retries: 480 });
  const tx = await client.getTransaction({ hash });
  const leader = values(tx.consensus_data?.leader_receipt).find((value) => value?.mode === 'leader') || values(tx.consensus_data?.leader_receipt)[0];
  const status = String(receipt.statusName || tx.statusName || '').toUpperCase();
  const consensus = String(tx.result_name || '').toUpperCase();
  const execution = leader?.genvm_result?.error_code ? 'ERROR' : String(leader?.execution_result || tx.txExecutionResultName || 'UNKNOWN').toUpperCase();
  step.status = status; step.consensus = consensus; step.execution = execution; step.leader_status = leader?.result?.status || null;
  step.stats_after = json(await read(clientA, 'get_stats'));
  step.expected_result = expectSuccess ? 'SUCCESS' : 'ROLLBACK';
  step.pass = status === 'FINALIZED' && consensus === 'MAJORITY_AGREE' && (expectSuccess ? execution === 'SUCCESS' : execution !== 'SUCCESS');
  save(); if (!step.pass) throw new Error(`${label} unexpected result ${status}/${consensus}/${execution}`);
  return step;
}

try {
  report.initial_stats = json(await read(clientA, 'get_stats'));
  report.schema = String(await read(clientA, 'get_schema_version'));
  const sameIdOwnerB = await submit('wallet-b-creates-same-id-in-independent-owner-namespace', clientB, 'create_intent', [INTENT_ID, 42161n, 8453n, 'An independent declaration for the same public identifier', 'audit-b-create-namespace'], true);
  const bIntent = json(await read(clientB, 'get_intent', [accountB.address.toLowerCase(), INTENT_ID]));
  sameIdOwnerB.readback_owner = bIntent.owner;
  sameIdOwnerB.readback_intent_id = bIntent.intent_id;
  if (bIntent.owner.toLowerCase() !== accountB.address.toLowerCase()) throw new Error('Wallet B intent namespace readback mismatch.');

  await submit('wallet-a-duplicate-intent-id-conflicts', clientA, 'create_intent', [INTENT_ID, 42161n, 8453n, 'A duplicate owner-scoped declaration must revert', 'audit-a-duplicate'], false);

  const nonce = 'audit-a-independent-assessment';
  const retry = await submit('wallet-a-independent-assessment-after-wallet-b-assessment', clientA, 'assess', [accountA.address.toLowerCase(), INTENT_ID, nonce], true);
  const assessmentId = sha256(`${accountA.address.toLowerCase()}:${INTENT_ID}:${accountA.address.toLowerCase()}:${nonce}`);
  const assessment = json(await read(clientA, 'get_assessment', [assessmentId]));
  retry.assessment_id = assessmentId; retry.assessment_readback = assessment;
  if (assessment.assessor.toLowerCase() !== accountA.address.toLowerCase() || assessment.status !== 'INDETERMINATE' || assessment.verdict !== 'INSUFFICIENT') throw new Error('Independent assessment readback did not match expected fail-closed result.');
  report.final_stats = json(await read(clientA, 'get_stats'));
  report.completed_at = new Date().toISOString(); report.all_steps_pass = report.steps.every((step) => step.pass); report.outcome = 'owner_scoped_id_conflict_and_independent_assessment_verified'; save();
  console.log(`Evidence saved: ${outPath}`);
} catch (error) {
  report.error = String(error?.stack || error).slice(0, 2500); report.completed_at = new Date().toISOString(); save();
  console.error(`Audit run stopped; evidence saved: ${outPath}`); console.error(String(error)); process.exitCode = 1;
}
