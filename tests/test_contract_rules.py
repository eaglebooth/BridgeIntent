from pathlib import Path


ROOT = Path(__file__).parents[1]
SOURCE = (ROOT / "contracts" / "bridge_intent.py").read_text(encoding="utf-8")


def test_contract_uses_fixed_rpc_and_protocol_sources():
    assert '"https://arb1.arbitrum.io/rpc"' in SOURCE
    assert '"https://mainnet.base.org"' in SOURCE
    rpc = SOURCE[SOURCE.index("def _rpc("):SOURCE.index("def _chain_id_matches")]
    assert "gl.nondet.web.request(" in rpc
    assert "input_url" not in rpc
    assert "api/deposit/status" not in SOURCE
    assert "Authorization" not in SOURCE


def test_semantic_judgment_runs_only_after_receipt_grounding():
    method = SOURCE[SOURCE.index("    def assess("):SOURCE.index("    @gl.public.view\n    def get_intent")]
    assert "gl.eq_principle.strict_eq(evaluate)" in method
    assert method.index("gl.nondet.exec_prompt(prompt)") < method.index("gl.eq_principle.strict_eq(evaluate)")
    evaluation = method[method.index("            def evaluate()"):method.index("            # One consensus boundary")]
    assert "item." not in evaluation
    assert "_observe(intent_owner, origin_chain, destination_chain, deposit_tx_hash, fill_tx_hash)" in evaluation
    observe = SOURCE[SOURCE.index("def _observe("):SOURCE.index("\n\ndef _parse_judgment")]
    assert "intent." not in observe
    assert '"ASSESSED"' in method and '"INDETERMINATE"' in method
    assert '"INDETERMINATE", "INSUFFICIENT"' in method


def test_intents_are_owner_bound_and_any_wallet_can_make_independent_assessment():
    bind = SOURCE[SOURCE.index("    def bind_evidence("):SOURCE.index("    @gl.public.write\n    def assess(")]
    assess = SOURCE[SOURCE.index("    def assess("):SOURCE.index("    @gl.public.view\n    def get_intent")]
    assert "ONLY_INTENT_OWNER_CAN_BIND_EVIDENCE" in bind
    assert "self._sender() != str(item.owner)" in bind
    assert "assessor = self._sender()" in assess
    assert "used_assessment_nonce" in assess
    assert "ONLY_INTENT_OWNER" not in assess


def test_contract_is_non_custodial_and_limits_scope():
    assert "@gl.public.write" in SOURCE
    assert "value=" not in SOURCE
    assert "msg.value" not in SOURCE
    assert "refund" not in SOURCE.lower() or "does not prove" in SOURCE.lower()
    assert "gl.eq_principle.strict_eq(evaluate)" in SOURCE
    assert "gl.nondet.exec_prompt(prompt)" in SOURCE

