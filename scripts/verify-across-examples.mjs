import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const manifest = JSON.parse(readFileSync('docs/TEST_RESOURCE_MANIFEST.json', 'utf8'));
const { depositTx, fillTx } = manifest.documentedExamples;
const DEPOSIT_TOPIC = '0x32ed1a409ef04c7b0227189c3a103dc5ac10e775a15b785dcc510201f7c25ad3';
const FILL_TOPIC = '0x44b559f101f8fbcc8a0ea43fa91a05a729a5ea6e14a7c75aa750374690137208';
const routes = {
  42161: { name: 'Arbitrum One', rpc: 'https://arb1.arbitrum.io/rpc', spokePool: '0xe35e9842fceaca96570b734083f4a58e8f7c5f2a', explorer: 'https://arbiscan.io/tx/' },
  8453: { name: 'Base', rpc: 'https://mainnet.base.org', spokePool: '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64', explorer: 'https://basescan.org/tx/' },
};

async function rpc(chainId, method, params) {
  const { rpc } = routes[chainId];
  const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(`${chainId}:${method}:${payload.error?.message || response.status}`);
  return payload.result;
}
function word(data, index) {
  const body = data.startsWith('0x') ? data.slice(2) : data;
  const result = body.slice(index * 64, (index + 1) * 64);
  if (result.length !== 64) throw new Error('EVENT_DATA_TRUNCATED');
  return `0x${result.toLowerCase()}`;
}
function addressWord(value) { return `0x${value.slice(-40).toLowerCase()}`; }
function topicUint(value) { return BigInt(value).toString(); }
function assert(condition, reason) { if (!condition) throw new Error(reason); }

async function getFinalReceipt(chainId, hash, spokePool, topic) {
  const tx = await rpc(chainId, 'eth_getTransactionByHash', [hash]);
  const receipt = await rpc(chainId, 'eth_getTransactionReceipt', [hash]);
  assert(tx && receipt, `TRANSACTION_NOT_FOUND_${chainId}`);
  assert(tx.hash.toLowerCase() === hash.toLowerCase() && receipt.transactionHash.toLowerCase() === hash.toLowerCase(), 'TRANSACTION_HASH_MISMATCH');
  assert(receipt.status === '0x1', 'TRANSACTION_REVERTED');
  const block = await rpc(chainId, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
  const finalized = await rpc(chainId, 'eth_getBlockByNumber', ['finalized', false]);
  assert(block?.hash?.toLowerCase() === receipt.blockHash.toLowerCase(), 'NONCANONICAL_RECEIPT_BLOCK');
  assert(BigInt(finalized.number) >= BigInt(receipt.blockNumber), 'RECEIPT_NOT_FINALIZED');
  const matches = receipt.logs.filter((log) => log.address.toLowerCase() === spokePool && log.topics?.[0]?.toLowerCase() === topic);
  assert(matches.length === 1, 'EXPECTED_SINGLE_ACROSS_EVENT');
  return { tx, receipt, event: matches[0] };
}

const depositResult = await getFinalReceipt(42161, depositTx, routes[42161].spokePool, DEPOSIT_TOPIC);
const fillResult = await getFinalReceipt(8453, fillTx, routes[8453].spokePool, FILL_TOPIC);
const d = depositResult.event, f = fillResult.event;
assert(d.topics.length === 4 && f.topics.length === 4, 'EVENT_TOPICS_INVALID');
const deposit = {
  destination_chain_id: topicUint(d.topics[1]), deposit_id: topicUint(d.topics[2]), depositor: addressWord(d.topics[3]),
  input_token: addressWord(word(d.data, 0)), output_token: addressWord(word(d.data, 1)),
  input_amount: BigInt(word(d.data, 2)).toString(), quoted_output_amount: BigInt(word(d.data, 3)).toString(),
  fill_deadline: BigInt(word(d.data, 5)).toString(), exclusivity_deadline: BigInt(word(d.data, 6)).toString(),
  recipient: addressWord(word(d.data, 7)), exclusive_relayer: addressWord(word(d.data, 8)),
};
const fill = {
  origin_chain_id: topicUint(f.topics[1]), deposit_id: topicUint(f.topics[2]), relayer: addressWord(f.topics[3]),
  input_token: addressWord(word(f.data, 0)), output_token: addressWord(word(f.data, 1)),
  input_amount: BigInt(word(f.data, 2)).toString(), output_amount: BigInt(word(f.data, 3)).toString(),
  fill_deadline: BigInt(word(f.data, 5)).toString(), exclusivity_deadline: BigInt(word(f.data, 6)).toString(),
  exclusive_relayer: addressWord(word(f.data, 7)), depositor: addressWord(word(f.data, 8)), recipient: addressWord(word(f.data, 9)),
};
assert(deposit.destination_chain_id === '8453' && fill.origin_chain_id === '42161', 'CHAIN_ROUTE_MISMATCH');
assert(deposit.deposit_id === fill.deposit_id, 'DEPOSIT_ID_MISMATCH');
for (const field of ['depositor', 'input_token', 'input_amount', 'fill_deadline', 'exclusivity_deadline', 'exclusive_relayer']) {
  assert(deposit[field] === fill[field], `RELAY_FIELD_MISMATCH_${field.toUpperCase()}`);
}

const report = {
  project: 'BridgeIntent',
  checked_at: new Date().toISOString(),
  source: 'Across documentation example hashes independently queried from Arbitrum One and Base JSON-RPC.',
  event_abi: { deposit: { name: 'FundsDeposited', topic0: DEPOSIT_TOPIC }, fill: { name: 'FilledRelay', topic0: FILL_TOPIC } },
  deposit_tx: { hash: depositTx, explorer: `${routes[42161].explorer}${depositTx}`, chain: routes[42161].name, status: depositResult.receipt.status, block: depositResult.receipt.blockNumber, block_hash: depositResult.receipt.blockHash, sender: depositResult.tx.from, event: deposit },
  fill_tx: { hash: fillTx, explorer: `${routes[8453].explorer}${fillTx}`, chain: routes[8453].name, status: fillResult.receipt.status, block: fillResult.receipt.blockNumber, block_hash: fillResult.receipt.blockHash, sender: fillResult.tx.from, event: fill },
  linkage: { deposit_id_match: true, route_match: true, depositor_match: true, required_relay_fields_match: true },
  constraint: 'These are real, linked, finalized public receipts. Their depositor is not either historical StudioNet test wallet, so schema v1 cannot use them under its old submitter-equals-depositor rule. Schema v2 intentionally separates the public-case submitter from the receipt depositor; this source-chain verification alone is not a live GenLayer MATCH/DIVERGED result.',
};
const outDir = resolve('docs/live-evidence');
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, 'across-example-receipts-verified.json');
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ verified: true, outPath, depositId: deposit.deposit_id, depositor: deposit.depositor, walletA: '0xeb57bc7125fa60d7482CE12058397369AB3581f8', links: [report.deposit_tx.explorer, report.fill_tx.explorer] }));
