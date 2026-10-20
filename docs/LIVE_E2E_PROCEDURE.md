# BridgeIntent live E2E runbook

This runbook is deliberately separate from Direct Mode. A local synthetic RPC fixture cannot be described as a live source receipt, and a mocked LLM verdict cannot be described as a live GenLayer judgment.

## Wallet responsibilities

1. **Main wallet:** deploy `contracts/bridge_intent.py` to StudioNet only. It has no contract owner/admin role and is not needed for dApp testing.
2. **Any submitter wallet:** connect to the dApp, set the deployed address, create a public verification case, and attach any real Arbitrum/Base V3 deposit/fill pair. The submitter need not be the Across depositor; this is a public receipt interpretation, not an ownership claim.
3. **Any reviewer wallet:** connect independently and assess the already-bound case. Each reviewer receives an independent immutable assessment receipt; reviewers cannot change another submitter's intent or hashes.
4. A reviewer may repeat assess with a fresh nonce, or create and bind another public case. No allowlist or deployer role is required.

The contract verifies that the depositor and base-message commitment in the source deposit and destination fill events match across the pair, along with the other relay-linkage fields. It does not authenticate the case submitter as that depositor. Therefore, real public transaction pairs may be used without funding a new bridge transfer. Never describe the submitter as the transaction owner unless separately authenticated.

For Across fills, the semantic assessment uses the effective recipient, output amount, message hash, and fill type in `relayExecutionInfo`; the base relay fields alone may be stale after an authorized speed-up or slow-fill replacement. The public receipt pair must still match on deterministic relay-linkage fields.

## Required happy path evidence

Record in the evidence bundle:

- StudioNet contract deployment address and deployment transaction hash, linked to `https://explorer-studio.genlayer.com/tx/<hash>`.
- Case submitter `create_intent` and `bind_evidence` StudioNet transaction hashes.
- The Arbitrum deposit and Base fill transaction hashes, linked to Arbiscan and Basescan respectively.
- Reviewer `assess` StudioNet transaction hash and final contract readback (`assessment_id`, `MATCH`/`DIVERGED`/`INSUFFICIENT`, assessor, facts digest).
- Screenshots/video showing wallet switching, pending/finalized transaction states, explorer links, and readback matching the final UI result.

Only claim happy-path success when the source transaction pair is linked by the contract, both chain receipts are successful, final and canonical, and the GenLayer transaction is finalized with successful execution.

## Required negative and adversarial cases

- **Failure:** unknown hash, wrong chain, missing/reverted/non-final receipt, RPC error, missing event, or malformed model JSON results in a failed write or an `INDETERMINATE` receipt; never `MATCH`.
- **Conflict:** alter one receipt hash or use a pair whose deposit ID, chain route, depositor, or relay fields do not match. Verify the GenLayer consensus prompt is not reached for deterministic link failures and the UI shows the stored `INDETERMINATE` result.
- **Retry / anti-grief:** after an unrelated account's assessment, verify wallet B can still submit a fresh nonce. Verify one wallet's reused nonce reverts and does not prevent another wallet from assessing.
- **Ownership:** wallet B cannot bind/replace wallet A's evidence; neither an assessor nor the deployer can overwrite A's bound hashes.
- **Prompt injection:** use a goal that contains instructions to ignore the verifier and request `MATCH`. It must be treated as untrusted claim text, and only receipt facts can support the bounded verdict.
- **UI reconciliation:** after each write, confirm the visible status is read from finalized state, and every transaction link opens the exact matching explorer/hash. A finalized but failed execution must not be presented as success.

## Capture format

Save screenshots and an append-only JSON/Markdown transaction ledger under `evidence/live/<date>/`. Include chain, wallet label (never private key), method, tx hash, explorer URL, receipt status, finality status, resulting assessment ID/state, and capture timestamp. Do not commit seed phrases, private keys, or wallet JSON files.

Current completion state (2026-10-20): schema v2 is deployed at `0x6d253BE5ABf1e490d004FaB72379CFE54a27B2c3`, and the deployed source matches local source byte-for-byte (26,761 bytes; SHA-256 `9c2e8881666ad1408e9bab43f5e0cebf2c26dbb42fe792121ef34b4eeeed7c37`). Two-wallet live cases on this instance verified create, unauthorized-binder rollback, invalid-hash fail-closed assessment, assessment-nonce replay rollback, and finalized readbacks in [studionet-20261020042745.json](live-evidence/studionet-20261020042745.json). A real, independently verified public Across pair then finalized as `ASSESSED / MATCH` in [public-across-20261020043216.json](live-evidence/public-across-20261020043216.json). Historical schema-v1 evidence remains documented separately in [LIVE_E2E_2026-10-20.md](live-evidence/LIVE_E2E_2026-10-20.md) and [conflict/audit ledger](live-evidence/audit-20261020audit01.json).

Follow-up source inspection verified a public deposit/fill pair from Arbitrum/Base RPC. Those receipts emit current `FundsDeposited`/`FilledRelay` topics (`0x32ed…` / `0x44b5…`); local source supports both current and legacy ABIs. Schema v2 has assessed the public pair live as `MATCH`, as `DIVERGED` against a contradictory recipient goal, and as `DIVERGED` when the contradictory goal also contains an instruction to ignore the verifier. See the three JSON files under `live-evidence/` referenced in `TEST_RESOURCE_MANIFEST.json`. Browser wallet/UI reconciliation remains outstanding; do not claim it was tested.
