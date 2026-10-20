"""GenLayer Direct Mode entrypoint/storage tests. These do not establish live-chain E2E."""
import json
import pytest

import test_bridge_intent_logic as logic


def _address(account):
    return "0x" + bytes(account).hex()


def _word(value):
    return f"{value:064x}"


def _address_word(value):
    return value.removeprefix("0x").lower().rjust(64, "0")


def _install_across_receipts(
    direct_vm, owner, deposit_id=9, use_current_across_events=False, depositor=None,
    effective_recipient=None, effective_output_amount=94, fill_type=0,
    deposit_message="", fill_base_message_hash=None, effective_message_hash=None,
    use_current_deposit_event=None, use_current_fill_event=None,
):
    CHAINS = logic.contract.CHAINS
    depositor = depositor or owner
    use_current_deposit_event = use_current_across_events if use_current_deposit_event is None else use_current_deposit_event
    use_current_fill_event = use_current_across_events if use_current_fill_event is None else use_current_fill_event
    DEPOSIT_TOPIC = "0x32ed1a409ef04c7b0227189c3a103dc5ac10e775a15b785dcc510201f7c25ad3" if use_current_deposit_event else logic.contract.DEPOSIT_TOPIC
    FILL_TOPIC = "0x44b559f101f8fbcc8a0ea43fa91a05a729a5ea6e14a7c75aa750374690137208" if use_current_fill_event else logic.contract.FILL_TOPIC

    deposit_tx = "0x" + "a1" * 32
    fill_tx = "0x" + "b2" * 32
    token = "0x" + "22" * 20
    relayer = "0x" + "44" * 20
    recipient = owner
    effective_recipient = effective_recipient or recipient
    message_hex = deposit_message.encode("utf-8").hex()
    message_length = len(message_hex) // 2
    message_tail = _word(message_length) + message_hex.ljust(((message_length + 31) // 32) * 64, "0")
    fill_base_message_hash = fill_base_message_hash or ("0x" + "0" * 64)
    deposit_data = "0x" + "".join([
        _address_word(token), _address_word(token), _word(100), _word(95), _word(123),
        _word(456), _word(0), _address_word(recipient), _address_word("0x" + "00" * 20),
        _word(320), message_tail,
    ])
    fill_words = [
        _address_word(token), _address_word(token), _word(100), _word(94), _word(42161),
        _word(456), _word(0), _address_word("0x" + "00" * 20), _address_word(depositor),
        _address_word(recipient),
        _word(int(fill_base_message_hash, 16)) if use_current_fill_event else _word(480),
        _address_word(effective_recipient), _word(int(effective_message_hash or "0x" + "0" * 32, 16)),
        _word(effective_output_amount), _word(fill_type),
    ]
    if not use_current_fill_event:
        # Legacy FilledV3Relay has dynamic `message` in the tail after its static tuple.
        fill_words.append(message_tail)
    fill_data = "0x" + "".join(fill_words)
    logs = {
        deposit_tx: [{
            "address": CHAINS[42161]["spoke_pool"],
            "topics": [DEPOSIT_TOPIC, "0x" + _word(8453), "0x" + _word(deposit_id), "0x" + _address_word(depositor)],
            "data": deposit_data,
        }],
        fill_tx: [{
            "address": CHAINS[8453]["spoke_pool"],
            "topics": [FILL_TOPIC, "0x" + _word(42161), "0x" + _word(deposit_id), "0x" + _address_word(relayer)],
            "data": fill_data,
        }],
    }
    block_hash = "0x" + "99" * 32

    def live_web(request):
        url, method = request.get("url", ""), request.get("method", "GET")
        if method != "POST":
            raise AssertionError("unexpected non-POST RPC request")
        payload = request.get("body")
        if isinstance(payload, bytes):
            payload = json.loads(payload.decode("utf-8"))
        elif isinstance(payload, str):
            payload = json.loads(payload)
        chain_id = 42161 if url == CHAINS[42161]["rpc"] else 8453 if url == CHAINS[8453]["rpc"] else 0
        method_name = payload.get("method")
        params = payload.get("params", [])
        if method_name == "eth_chainId":
            result = hex(chain_id)
        elif method_name == "eth_getTransactionByHash":
            tx_hash = params[0].lower()
            result = {"hash": tx_hash, "from": owner, "to": "0x" + "55" * 20, "blockNumber": "0x64", "blockHash": block_hash}
        elif method_name == "eth_getTransactionReceipt":
            tx_hash = params[0].lower()
            result = {"transactionHash": tx_hash, "blockNumber": "0x64", "blockHash": block_hash,
                      "status": "0x1", "logs": logs.get(tx_hash, [])}
        elif method_name == "eth_getBlockByNumber" and params[0] == "finalized":
            result = {"number": "0x100", "hash": "0x" + "88" * 32}
        elif method_name == "eth_getBlockByNumber":
            result = {"number": "0x64", "hash": block_hash}
        else:
            raise AssertionError(f"unexpected RPC method: {method_name}")
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "result": result}).encode("utf-8")
        return {"ok": {"response": {"status": 200, "headers": {}, "body": body}}}

    direct_vm._live_web_handler = live_web
    return deposit_tx, fill_tx


def test_direct_mode_contract_schema_and_empty_state(direct_deploy):
    contract = direct_deploy("contracts/bridge_intent.py")
    assert json.loads(contract.get_stats()) == {"intent_count": 0, "assessment_count": 0}
    assert contract.get_schema_version() == "bridgeintent/2"


def test_direct_mode_owner_binding_and_permissionless_record_creation(direct_deploy, direct_vm, direct_alice, direct_bob):
    contract = direct_deploy("contracts/bridge_intent.py")
    alice, bob = _address(direct_alice), _address(direct_bob)
    with direct_vm.prank(direct_alice):
        contract.create_intent(
            "direct-intent-01", 42161, 8453,
            "Receive the intended token at my destination wallet", "direct-create-01",
        )
    intent = json.loads(contract.get_intent(alice, "direct-intent-01"))
    assert intent["owner"].lower() == alice.lower()
    assert intent["evidence_bound"] is False

    with direct_vm.prank(direct_bob), direct_vm.expect_revert("ONLY_INTENT_OWNER_CAN_BIND_EVIDENCE"):
        contract.bind_evidence(alice, "direct-intent-01", "0x" + "a1" * 32, "0x" + "b2" * 32)

    with direct_vm.prank(direct_alice):
        contract.bind_evidence(alice, "direct-intent-01", "0x" + "a1" * 32, "0x" + "b2" * 32)
    intent = json.loads(contract.get_intent(alice, "direct-intent-01"))
    assert intent["evidence_bound"] is True
    assert intent["deposit_tx"] == "0x" + "a1" * 32
    assert intent["fill_tx"] == "0x" + "b2" * 32

    with direct_vm.prank(direct_alice), direct_vm.expect_revert("EVIDENCE_ALREADY_BOUND"):
        contract.bind_evidence(alice, "direct-intent-01", "0x" + "c3" * 32, "0x" + "d4" * 32)


def test_direct_mode_nonce_replay_and_wallet_scope(direct_deploy, direct_vm, direct_alice, direct_bob):
    contract = direct_deploy("contracts/bridge_intent.py")
    alice, bob = _address(direct_alice), _address(direct_bob)
    with direct_vm.prank(direct_alice):
        contract.create_intent("direct-intent-02", 42161, 8453, "Receive the declared token to my wallet", "direct-create-02")
    with direct_vm.prank(direct_alice), direct_vm.expect_revert("INTENT_NONCE_REPLAY"):
        contract.create_intent("direct-intent-03", 42161, 8453, "Receive the declared token to my wallet", "direct-create-02")

    with direct_vm.prank(direct_bob):
        contract.create_intent("direct-intent-02", 42161, 8453, "Receive the declared token to my wallet", "direct-bob-create-01")
    assert json.loads(contract.get_intent(bob, "direct-intent-02"))["owner"].lower() == bob.lower()
    assert json.loads(contract.get_stats())["intent_count"] == 2


def test_direct_mode_synthetic_rpc_semantic_consensus_and_conflict_fail_closed(direct_deploy, direct_vm, direct_alice, direct_bob):
    contract = direct_deploy("contracts/bridge_intent.py")
    alice, bob = _address(direct_alice), _address(direct_bob)
    deposit_tx, fill_tx = _install_across_receipts(direct_vm, alice)
    direct_vm.mock_llm(r"^You are an evidence-bounded cross-chain transaction outcome classifier", '{"verdict":"MATCH"}')
    with direct_vm.prank(direct_alice):
        contract.create_intent("direct-assess-01", 42161, 8453, "Receive the declared token at my destination wallet", "direct-assess-create")
        contract.bind_evidence(alice, "direct-assess-01", deposit_tx, fill_tx)
    with direct_vm.prank(direct_bob):
        assessment_id = contract.assess(alice, "direct-assess-01", "direct-assess-review")
    assessment = json.loads(contract.get_assessment(assessment_id))
    assert assessment["status"] == "ASSESSED"
    assert assessment["verdict"] == "MATCH"
    assert assessment["assessor"].lower() == bob.lower()
    assert len(assessment["facts_digest"]) == 64

    # A conflicting destination deposit ID cannot reach semantic judgment.
    deposit_tx, fill_tx = _install_across_receipts(direct_vm, alice, deposit_id=10)
    direct_vm.mock_llm(r"^You are an evidence-bounded cross-chain transaction outcome classifier", '{"verdict":"MATCH"}')
    with direct_vm.prank(direct_alice):
        contract.create_intent("direct-conflict-01", 42161, 8453, "Receive the declared token at my destination wallet", "direct-conflict-create")
        contract.bind_evidence(alice, "direct-conflict-01", deposit_tx, fill_tx)
    # Keep the origin event at depositId=9 while the fill event uses 10.
    handler = direct_vm._live_web_handler
    # Replace only the source log's indexed depositId with a conflicting value.
    def conflicting_source(request):
        result = handler(request)
        payload = request.get("body")
        if isinstance(payload, bytes):
            payload = json.loads(payload.decode("utf-8"))
        elif isinstance(payload, str):
            payload = json.loads(payload)
        if payload.get("method") == "eth_getTransactionReceipt" and payload.get("params", [""])[0].lower() == deposit_tx:
            body = result["ok"]["response"]["body"]
            parsed = json.loads(body.decode("utf-8") if isinstance(body, bytes) else body)
            parsed["result"]["logs"][0]["topics"][2] = "0x" + _word(9)
            result["ok"]["response"]["body"] = json.dumps(parsed).encode("utf-8")
        return result

    direct_vm._live_web_handler = conflicting_source
    with direct_vm.prank(direct_bob):
        conflict_id = contract.assess(alice, "direct-conflict-01", "direct-conflict-review")
    conflict_assessment = json.loads(contract.get_assessment(conflict_id))
    assert conflict_assessment["status"] == "INDETERMINATE"
    assert conflict_assessment["verdict"] == "INSUFFICIENT"
    assert "DEPOSIT_ID_MISMATCH" in conflict_assessment["reason"]


def test_direct_mode_current_across_event_abi_supports_semantic_match(direct_deploy, direct_vm, direct_alice, direct_bob):
    contract = direct_deploy("contracts/bridge_intent.py")
    alice, bob = _address(direct_alice), _address(direct_bob)
    deposit_tx, fill_tx = _install_across_receipts(direct_vm, alice, use_current_across_events=True)
    direct_vm.mock_llm(r"^You are an evidence-bounded cross-chain transaction outcome classifier", '{"verdict":"MATCH"}')
    with direct_vm.prank(direct_alice):
        contract.create_intent("current-events-01", 42161, 8453, "Receive the declared token at my destination wallet", "current-events-create")
        contract.bind_evidence(alice, "current-events-01", deposit_tx, fill_tx)
    with direct_vm.prank(direct_bob):
        assessment_id = contract.assess(alice, "current-events-01", "current-events-assess")
    assessment = json.loads(contract.get_assessment(assessment_id))
    assert assessment["status"] == "ASSESSED"
    assert assessment["verdict"] == "MATCH"
    facts = json.loads(assessment["facts_json"])
    assert facts["link_checks"]["deposit_id_and_origin_destination_chains_match"] is True
    assert facts["deposit"]["deposit_id"] == facts["fill"]["deposit_id"]
    assert facts["fill"]["effective_recipient"].lower() == alice.lower()
    assert facts["fill"]["effective_output_amount"] == "94"
    assert facts["fill"]["fill_type"] == "FAST_FILL"


def test_direct_mode_judges_effective_fill_values_not_stale_base_fields(direct_deploy, direct_vm, direct_alice, direct_bob):
    contract = direct_deploy("contracts/bridge_intent.py")
    alice, bob = _address(direct_alice), _address(direct_bob)
    changed_recipient = "0x" + "dd" * 20
    deposit_tx, fill_tx = _install_across_receipts(
        direct_vm, alice, use_current_across_events=True,
        effective_recipient=changed_recipient, effective_output_amount=91, fill_type=1,
        effective_message_hash="0x" + "ee" * 32,
    )
    direct_vm.mock_llm(
        r"^You are an evidence-bounded cross-chain transaction outcome classifier",
        '{"verdict":"DIVERGED"}',
    )
    with direct_vm.prank(direct_alice):
        contract.create_intent(
            "effective-fill-01", 42161, 8453,
            "The effective destination recipient must be the declared beneficiary",
            "effective-fill-create-01",
        )
        contract.bind_evidence(alice, "effective-fill-01", deposit_tx, fill_tx)
    with direct_vm.prank(direct_bob):
        assessment_id = contract.assess(alice, "effective-fill-01", "effective-fill-assess-01")

    assessment = json.loads(contract.get_assessment(assessment_id))
    facts = json.loads(assessment["facts_json"])
    assert assessment["status"] == "ASSESSED"
    assert assessment["verdict"] == "DIVERGED"
    assert facts["fill"]["recipient"].lower() == alice.lower()
    assert facts["fill"]["effective_recipient"].lower() == changed_recipient.lower()
    assert facts["fill"]["effective_output_amount"] == "91"
    assert facts["fill"]["fill_type"] == "REPLACED_SLOW_FILL"
    assert facts["deposit"]["message_hash"] == facts["fill"]["base_message_hash"]
    assert facts["fill"]["effective_message_hash"] != facts["fill"]["base_message_hash"]


def test_direct_mode_rejects_fill_with_wrong_base_message_commitment(direct_deploy, direct_vm, direct_alice, direct_bob):
    contract = direct_deploy("contracts/bridge_intent.py")
    alice, bob = _address(direct_alice), _address(direct_bob)
    deposit_tx, fill_tx = _install_across_receipts(
        direct_vm, alice, use_current_across_events=True,
        deposit_message="BridgeIntent source message",
    )
    direct_vm.mock_llm(r"^You are an evidence-bounded cross-chain transaction outcome classifier", '{"verdict":"MATCH"}')
    with direct_vm.prank(direct_alice):
        contract.create_intent(
            "message-link-01", 42161, 8453,
            "The fill must correspond to this exact source deposit",
            "message-link-create-01",
        )
        contract.bind_evidence(alice, "message-link-01", deposit_tx, fill_tx)
    with direct_vm.prank(direct_bob):
        assessment_id = contract.assess(alice, "message-link-01", "message-link-assess-01")

    assessment = json.loads(contract.get_assessment(assessment_id))
    facts = json.loads(assessment["facts_json"])
    assert assessment["status"] == "INDETERMINATE"
    assert assessment["verdict"] == "INSUFFICIENT"
    assert facts["reason_code"] == "RELAY_FIELD_MISMATCH_MESSAGE"


@pytest.mark.parametrize(
    ("current_deposit", "current_fill"),
    [(True, True), (False, False), (True, False)],
    ids=["current-current", "legacy-legacy", "mixed-current-deposit-legacy-fill"],
)
def test_direct_mode_links_nonempty_deposit_and_fill_messages(
    direct_deploy, direct_vm, direct_alice, direct_bob, current_deposit, current_fill,
):
    contract = direct_deploy("contracts/bridge_intent.py")
    alice, bob = _address(direct_alice), _address(direct_bob)
    expected_message_hash = "0x05256ffc406afdbce52b934756f84dfa9695376f166f2b466dee3f4263467cf2"
    deposit_tx, fill_tx = _install_across_receipts(
        direct_vm, alice, deposit_message="BridgeIntent source message",
        fill_base_message_hash=expected_message_hash,
        effective_message_hash=expected_message_hash,
        use_current_deposit_event=current_deposit,
        use_current_fill_event=current_fill,
    )
    direct_vm.mock_llm(r"^You are an evidence-bounded cross-chain transaction outcome classifier", '{"verdict":"MATCH"}')
    intent_id = f"message-match-{int(current_deposit)}-{int(current_fill)}"
    with direct_vm.prank(direct_alice):
        contract.create_intent(intent_id, 42161, 8453, "The observed transfer matches the declared destination", intent_id + "-create")
        contract.bind_evidence(alice, intent_id, deposit_tx, fill_tx)
    with direct_vm.prank(direct_bob):
        assessment_id = contract.assess(alice, intent_id, intent_id + "-assess")

    assessment = json.loads(contract.get_assessment(assessment_id))
    facts = json.loads(assessment["facts_json"])
    assert assessment["status"] == "ASSESSED"
    assert assessment["verdict"] == "MATCH"
    assert facts["deposit"]["message_hash"] == expected_message_hash
    assert facts["fill"]["base_message_hash"] == expected_message_hash
    assert facts["fill"]["effective_message_hash"] == expected_message_hash


def test_direct_mode_public_receipt_pair_does_not_require_submitter_to_be_depositor(direct_deploy, direct_vm, direct_alice, direct_bob):
    contract = direct_deploy("contracts/bridge_intent.py")
    alice, bob = _address(direct_alice), _address(direct_bob)
    external_depositor = "0x" + "cc" * 20
    deposit_tx, fill_tx = _install_across_receipts(
        direct_vm, alice, use_current_across_events=True, depositor=external_depositor,
    )
    direct_vm.mock_llm(r"^You are an evidence-bounded cross-chain transaction outcome classifier", '{"verdict":"MATCH"}')
    with direct_vm.prank(direct_alice):
        contract.create_intent(
            "public-receipts-01", 42161, 8453,
            "The public receipt pair shows the declared token delivered to its event recipient",
            "public-receipts-create-01",
        )
        contract.bind_evidence(alice, "public-receipts-01", deposit_tx, fill_tx)
    with direct_vm.prank(direct_bob):
        assessment_id = contract.assess(alice, "public-receipts-01", "public-receipts-review-01")

    assessment = json.loads(contract.get_assessment(assessment_id))
    facts = json.loads(assessment["facts_json"])
    assert assessment["status"] == "ASSESSED"
    assert assessment["verdict"] == "MATCH"
    assert facts["case_submitter"].lower() == alice.lower()
    assert facts["deposit"]["depositor"].lower() == external_depositor.lower()
    assert facts["fill"]["depositor"].lower() == external_depositor.lower()
    assert facts["deposit"]["depositor"].lower() != facts["case_submitter"].lower()
    assert facts["link_checks"]["depositor_and_required_relay_fields_match_across_receipts"] is True
    assert "not an authenticated depositor or transaction owner" in facts["boundary"]


def test_direct_mode_current_across_event_abi_records_diverged_judgment(direct_deploy, direct_vm, direct_alice, direct_bob):
    contract = direct_deploy("contracts/bridge_intent.py")
    alice, bob = _address(direct_alice), _address(direct_bob)
    deposit_tx, fill_tx = _install_across_receipts(direct_vm, alice, use_current_across_events=True)
    direct_vm.mock_llm(r"^You are an evidence-bounded cross-chain transaction outcome classifier", '{"verdict":"DIVERGED"}')
    with direct_vm.prank(direct_alice):
        contract.create_intent("current-events-02", 42161, 8453, "Recipient must be the declared beneficiary", "current-events-create-02")
        contract.bind_evidence(alice, "current-events-02", deposit_tx, fill_tx)
    with direct_vm.prank(direct_bob):
        assessment_id = contract.assess(alice, "current-events-02", "current-events-assess-02")
    assessment = json.loads(contract.get_assessment(assessment_id))
    assert assessment["status"] == "ASSESSED"
    assert assessment["verdict"] == "DIVERGED"


def test_direct_mode_missing_receipts_are_recorded_as_indeterminate(direct_deploy, direct_vm, direct_alice, direct_bob):
    contract = direct_deploy("contracts/bridge_intent.py")
    alice, bob = _address(direct_alice), _address(direct_bob)
    with direct_vm.prank(direct_alice):
        contract.create_intent("direct-missing-01", 42161, 8453, "Receive the expected token at the destination wallet", "direct-missing-create")
        contract.bind_evidence(alice, "direct-missing-01", "0x" + "a5" * 32, "0x" + "b6" * 32)
    with direct_vm.prank(direct_bob):
        assessment_id = contract.assess(alice, "direct-missing-01", "direct-missing-review")
    assessment = json.loads(contract.get_assessment(assessment_id))
    assert assessment["status"] == "INDETERMINATE"
    assert assessment["verdict"] == "INSUFFICIENT"
