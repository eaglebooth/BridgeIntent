"""Pure tests for the actual helper functions in the GenLayer contract source.

The GenVM import is stubbed only so these Python helpers can be imported in a
normal CPython test run. These tests are not Direct Mode or live-chain proof.
"""
import importlib.util
import sys
import types
from pathlib import Path
import pytest


SOURCE = Path(__file__).parents[1] / "contracts" / "bridge_intent.py"


class TreeMap(dict):
    @classmethod
    def __class_getitem__(cls, _item):
        return cls


def _identity(value):
    return value


def _unexpected_keccak(_data=b""):
    raise AssertionError("CPython helper stub does not emulate GenLayer Keccak; use Direct Mode for non-empty messages")


class _Public:
    @staticmethod
    def write(fn):
        return fn

    @staticmethod
    def view(fn):
        return fn


def load_contract_module():
    fake = types.ModuleType("genlayer")
    fake.__all__ = ["allow_storage", "bigint", "TreeMap", "gl", "Keccak256"]
    fake.allow_storage = _identity
    fake.bigint = int
    fake.TreeMap = TreeMap
    fake.Keccak256 = _unexpected_keccak
    fake.gl = types.SimpleNamespace(
        Contract=object, public=_Public(), vm=types.SimpleNamespace(UserError=lambda message: Exception(message))
    )
    previous = sys.modules.get("genlayer")
    contract_name = "bridge_intent_under_test"
    previous_contract = sys.modules.get(contract_name)
    sys.modules["genlayer"] = fake
    try:
        spec = importlib.util.spec_from_file_location(contract_name, SOURCE)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        sys.modules[contract_name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        if previous_contract is None:
            sys.modules.pop(contract_name, None)
        else:
            sys.modules[contract_name] = previous_contract
        if previous is None:
            sys.modules.pop("genlayer", None)
        else:
            sys.modules["genlayer"] = previous


contract = load_contract_module()


def _word(value: int) -> str:
    return f"{value:064x}"


def _address(value: str) -> str:
    return value.removeprefix("0x").lower().rjust(64, "0")


def test_v3_deposit_event_topic_matches_official_signature():
    assert contract.DEPOSIT_TOPIC == "0xa123dc29aebf7d0c3322c8eeb5b999e859f39937950ed31056532713d0de396f"


def test_deposit_decode_uses_indexed_destination_deposit_and_depositor():
    owner = "0x" + "11" * 20
    token = "0x" + "22" * 20
    recipient = "0x" + "33" * 20
    relayer = "0x" + "44" * 20
    data = "0x" + "".join([
        _address(token), _address(token), _word(100), _word(95), _word(123),
        _word(456), _word(0), _address(recipient), _address(relayer), _word(320), _word(0),
    ])
    decoded = contract._decode_deposit({
        "topics": ["0x" + "00" * 32, "0x" + _word(8453), "0x" + _word(9), "0x" + _address(owner)],
        "data": data,
    })
    assert decoded == {
        "destination_chain_id": "8453", "deposit_id": "9", "depositor": owner,
        "input_token": token, "output_token": token, "input_amount": "100",
        "quoted_output_amount": "95", "fill_deadline": "456", "exclusivity_deadline": "0",
        "recipient": recipient, "exclusive_relayer": relayer,
        "message_hash": "0x" + "0" * 64,
    }


def test_fill_decode_uses_indexed_origin_deposit_and_relayer():
    owner = "0x" + "11" * 20
    token = "0x" + "22" * 20
    recipient = "0x" + "33" * 20
    relayer = "0x" + "44" * 20
    data = "0x" + "".join([
        _address(token), _address(token), _word(100), _word(94), _word(42161),
        _word(456), _word(0), _address("0x" + "00" * 20), _address(owner),
        _address(recipient), _word(480), _address(recipient), _word(0), _word(94), _word(0), _word(0),
    ])
    decoded = contract._decode_fill({
        "topics": ["0x" + "00" * 32, "0x" + _word(42161), "0x" + _word(9), "0x" + _address(relayer)],
        "data": data,
    })
    assert decoded == {
        "origin_chain_id": "42161", "deposit_id": "9", "relayer": relayer,
        "input_token": token, "output_token": token, "input_amount": "100",
        "output_amount": "94", "fill_deadline": "456", "exclusivity_deadline": "0",
        "exclusive_relayer": "0x" + "00" * 20, "depositor": owner, "recipient": recipient,
        "base_message_hash": "0x" + "0" * 64,
        "effective_recipient": recipient, "effective_message_hash": "0x" + "0" * 64,
        "effective_output_amount": "94", "fill_type": "FAST_FILL",
    }


def test_legacy_fill_decode_rejects_invalid_dynamic_message_offset():
    token = "0x" + "22" * 20
    recipient = "0x" + "33" * 20
    data = "0x" + "".join([
        _address(token), _address(token), _word(100), _word(94), _word(42161),
        _word(456), _word(0), _address("0x" + "00" * 20), _address("0x" + "11" * 20),
        _address(recipient), _word(352), _address(recipient), _word(0), _word(94), _word(0), _word(0),
    ])
    with pytest.raises(ValueError, match="EVENT_DYNAMIC_OFFSET_INVALID"):
        contract._decode_fill({
            "topics": ["0x" + "00" * 32, "0x" + _word(42161), "0x" + _word(9), "0x" + _word(1)],
            "data": data,
        })


def test_dynamic_bytes_decoder_requires_canonical_zero_padding_and_no_trailing_data():
    canonical = "0x" + _word(32) + _word(1) + "61" + "00" * 31
    assert contract._dynamic_bytes(canonical, 0, 1) == "0x61"

    nonzero_padding = canonical[:-2] + "01"
    with pytest.raises(ValueError, match="EVENT_DYNAMIC_PADDING_INVALID"):
        contract._dynamic_bytes(nonzero_padding, 0, 1)

    with pytest.raises(ValueError, match="EVENT_DYNAMIC_BYTES_INVALID"):
        contract._dynamic_bytes(canonical + _word(0), 0, 1)


def test_invalid_transaction_hash_is_rejected():
    assert contract._tx_hash("0x1234") == ""
    assert contract._tx_hash("0x" + "AA" * 32) == "0x" + "aa" * 32

