# BridgeIntent

BridgeIntent interprets one narrowly scoped, receipt-grounded outcome: whether an Across V3 origin deposit and destination fill appear to accomplish a declared destination action. Any wallet may submit the public transaction hashes; the submitter does not need to be the depositor. Deterministic contract code checks the chain, transaction and receipt hashes, finality, canonical block hash, official SpokePool emitter, event topics, deposit ID, chain pair, depositor consistency across both events, and relay fields. Only then does GenLayer use consensus to judge the residual semantic match between the declared action and the effective fill facts.

It is a non-custodial evidence interpreter, not a bridge, refund service, solvency monitor, or proof that the user statement predated the transfer. `MATCH` means only that the observed event facts semantically align with the declared action. It does not prove that assets are safe, recoverable, or solvent.

## Roles and wallet flow

- The deployment wallet only deploys the contract; it has no privileged assessment or evidence-editing role.
- Any test/reviewer wallet can connect through the UI, create a public case, attach public bridge hashes (including another wallet's already-finalized transactions), and request assessment.
- Other wallets can independently assess any already-bound intent. Each assessment has a caller-scoped nonce/receipt, so an unrelated account cannot consume or block another assessor's retry.
- A separate reviewer wallet can repeat the same permissionless path.

The case creator is recorded as the submitter, not as the transaction owner. The contract checks that the depositor reported by the source deposit and destination fill agree with each other, but does not authenticate the submitter as that depositor. The case goal is a user declaration, not cryptographic proof of pre-transaction intent.

## Local frontend

```powershell
cd frontend
npm install
npm run dev
```

The frontend connects with `genlayer-js` to GenLayer StudioNet (61999), waits for a finalized successful transaction, and reads the contract state back before showing the result. Set `VITE_BRIDGEINTENT_ADDRESS` only after deployment or paste a deployed address in the app. Do not enter private keys in the app or repository.

## Test status

```powershell
python -m pytest -q tests
```

The suite includes pure helper tests, a fake runtime, and GenLayer Direct Mode calls. Direct Mode uses synthetic RPC receipts and mocked model output; it is not live-chain evidence. A regression test confirms a submitter distinct from the receipt depositor can register a public receipt pair, while mismatched deposit/fill fields still fail closed. Schema v2 is deployed at `0x6d253BE5ABf1e490d004FaB72379CFE54a27B2c3`; byte-for-byte source parity, two-wallet fail-closed/authorization/replay paths, and live public Across `MATCH`, `DIVERGED`, and prompt-injection resistance are recorded under [live evidence](docs/live-evidence/). Browser wallet/UI reconciliation remains outstanding. See [TEST_RESOURCE_MANIFEST.json](docs/TEST_RESOURCE_MANIFEST.json) for scope and limits.

For the main-wallet / test-wallet / judge-wallet sequence and evidence capture checklist, see [LIVE_E2E_PROCEDURE.md](docs/LIVE_E2E_PROCEDURE.md).

## Contract interface

- `create_intent(intent_id, origin_chain_id, destination_chain_id, expected_action, nonce)` — create caller-owned immutable intent.
- `bind_evidence(intent_owner, intent_id, deposit_tx, fill_tx)` — the case submitter binds one immutable public transaction pair. Here `intent_owner` means the submitter namespace, not the Across depositor.
- `assess(intent_owner, intent_id, nonce)` — any caller requests an independent consensus result; returns the deterministic assessment ID.
- `get_intent(owner, intent_id)`, `get_assessment(assessment_id)`, `get_stats()`, `get_schema_version()` — read-only state; schema v2 labels the submitter separately from receipt depositors in the normalized assessment facts.

## Evidence boundary and known limitations

- Supported source networks are currently Arbitrum One and Base only.
- Sources are fixed public JSON-RPC endpoints; user-provided RPC URLs are not accepted.
- The contract recognizes both Across V3 legacy EVM events `V3FundsDeposited` / `FilledV3Relay` and current `FundsDeposited` / `FilledRelay` events.
- For fill results it judges `relayExecutionInfo`'s effective recipient, output amount, message hash, and fill type, not only the base relay fields. Legacy raw message bytes are not forwarded to the semantic prompt; only their validated byte length and the effective message hash are included.
- The source deposit message commitment must match the base message/hash in the fill before semantic review. The effective `relayExecutionInfo.updatedMessageHash` remains separate because an authorized speed-up can change the executed message.
- Both receipts must already satisfy the contract's finality/canonicality checks; unavailable RPC or incomplete finality yields `INDETERMINATE`.
- The prompt receives decoded normalized fields, not arbitrary event message bytes.
- A public receipt pair does not prove the submitter owns the transaction, had a prospective intent, or has a claim to funds.
- The historical schema-v1 deployments do not have current public-case behavior; the verified schema-v2 deployment above does. Check source parity and `get_schema_version()` before relying on any deployment address.

See [the test resource manifest](docs/TEST_RESOURCE_MANIFEST.json) for source URLs, fixture provenance, and the complete verification matrix.
