"""Local fake-runtime lifecycle checks; not Direct Mode or live-chain evidence."""
import json
import hashlib
import types

import test_bridge_intent_logic as logic


def _runtime(monkeypatch, prompt_result=None):
    sender = types.SimpleNamespace(as_hex="0x" + "11" * 20)
    gl = types.SimpleNamespace(
        Contract=object,
        message=types.SimpleNamespace(sender_address=sender),
        public=logic._Public(),
        vm=types.SimpleNamespace(UserError=lambda message: Exception(message)),
        nondet=types.SimpleNamespace(exec_prompt=lambda _prompt: json.dumps(prompt_result or {
            "verdict": "MATCH"
        })),
        eq_principle=types.SimpleNamespace(strict_eq=lambda callback: callback()),
    )
    monkeypatch.setattr(logic.contract, "gl", gl)
    contract = logic.contract.BridgeIntent()
    for field in ("intents", "intent_exists", "assessments", "assessment_exists", "used_intent_nonce", "used_assessment_nonce"):
        setattr(contract, field, logic.TreeMap())
    contract.intent_count = 0
    contract.assessment_count = 0
    return contract, gl


def test_wallet_owned_intent_permissionless_assessment_and_nonce_isolation(monkeypatch):
    contract, gl = _runtime(monkeypatch)
    alice = "0x" + "11" * 20
    bob = "0x" + "22" * 20
    contract.create_intent("bridge-test-01", 42161, 8453, "Receive USDC at my Base wallet", "create-nonce-01")
    assert json.loads(contract.get_intent(alice, "bridge-test-01"))["owner"] == alice

    gl.message.sender_address.as_hex = bob
    try:
        contract.bind_evidence(alice, "bridge-test-01", "0x" + "a1" * 32, "0x" + "b2" * 32)
        assert False, "an unrelated wallet must not bind evidence"
    except Exception as error:
        assert "ONLY_INTENT_OWNER_CAN_BIND_EVIDENCE" in str(error)

    gl.message.sender_address.as_hex = alice
    contract.bind_evidence(alice, "bridge-test-01", "0x" + "a1" * 32, "0x" + "b2" * 32)
    facts = {"fill": {"recipient": "0x" + "11" * 20, "output_amount": "99"}}
    digest = hashlib.sha256(logic.contract._canonical(facts).encode("utf-8")).hexdigest()
    monkeypatch.setattr(logic.contract, "_observe", lambda *_args: {"facts": facts, "facts_digest": digest})
    gl.message.sender_address.as_hex = bob
    first_id = contract.assess(alice, "bridge-test-01", "review-bob-01")
    first = json.loads(contract.get_assessment(first_id))
    assert first["status"] == "ASSESSED" and first["verdict"] == "MATCH"
    assert first["assessor"] == bob

    # An independent later assessor is not blocked by Bob's prior assessment.
    gl.message.sender_address.as_hex = "0x" + "33" * 20
    second_id = contract.assess(alice, "bridge-test-01", "review-third-01")
    assert json.loads(contract.get_assessment(second_id))["status"] == "ASSESSED"
    assert first_id != second_id

    gl.message.sender_address.as_hex = bob
    try:
        contract.assess(alice, "bridge-test-01", "review-bob-01")
        assert False, "the same wallet nonce must not be replayable"
    except Exception as error:
        assert "ASSESSMENT_NONCE_REPLAY" in str(error)


def test_conflicting_receipt_facts_fail_closed_as_indeterminate(monkeypatch):
    contract, gl = _runtime(monkeypatch)
    alice = "0x" + "11" * 20
    bob = "0x" + "22" * 20
    contract.create_intent("bridge-conflict-01", 42161, 8453, "Receive USDC at my wallet", "create-conflict-01")
    contract.bind_evidence(alice, "bridge-conflict-01", "0x" + "a1" * 32, "0x" + "b2" * 32)
    monkeypatch.setattr(logic.contract, "_observe", lambda *_args: (_ for _ in ()).throw(ValueError("DEPOSIT_ID_MISMATCH")))
    gl.message.sender_address.as_hex = bob
    assessment_id = contract.assess(alice, "bridge-conflict-01", "conflict-review-01")
    result = json.loads(contract.get_assessment(assessment_id))
    assert result["status"] == "INDETERMINATE"
    assert result["verdict"] == "INSUFFICIENT"
    assert "DEPOSIT_ID_MISMATCH" in result["reason"]
