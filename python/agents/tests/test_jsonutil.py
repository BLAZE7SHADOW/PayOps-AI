import pytest

from payops_agents.cassette import cassette_key, stable_hash
from payops_agents.jsonutil import js_dumps, js_number, utf16_length
from payops_agents.text import format_money, scrub_pii_text


@pytest.mark.parametrize(
    ("value", "text"),
    [
        (2.0, "2"),
        (0.74, "0.74"),
        (-3, "-3"),
        (12.5, "12.5"),
        (1e-7, "1e-7"),
        (1.5e-7, "1.5e-7"),
        (0.000001, "0.000001"),
        (1e21, "1e+21"),
        (123456789012345680000.0, "123456789012345680000"),
        (0.1 + 0.2, "0.30000000000000004"),
        (float("nan"), "null"),
    ],
)
def test_numbers_print_like_javascript(value: float, text: str) -> None:
    assert js_number(value) == text


def test_dumps_keeps_key_order_and_escapes_like_javascript() -> None:
    value = {"b": 1, "a": [2.5, "x", True, None], "s": 'say "hi"\nnext — ₹'}
    assert js_dumps(value) == '{"b":1,"a":[2.5,"x",true,null],"s":"say \\"hi\\"\\nnext — ₹"}'


def test_hashes_match_the_typescript_implementation() -> None:
    # Reference values computed with packages/core cassette.ts.
    assert stable_hash({"b": 1, "a": [2.5, "x", True, None], "c": {"z": 0.74, "y": -3}}) == (
        "05040e600671c84ff06256108d811725937482567778d81e91fe94e822c05346"
    )
    messages = [{"role": "system", "content": 'a "quoted" line\nnext — dash ₹'}, {"role": "user", "content": "u"}]
    assert stable_hash(messages) == "327bacd92c9f583e6b25781b5fe2e28e6617e2ff8d777374c37564446abc0926"
    request = {"state": {"n": 1e21, "m": 1.5e-7, "k": 100, "f": 0.1}, "questions": {"q": {"type": "noul", "instructions": "Is it?"}}}
    assert stable_hash(request) == "c833f562c71723c9fd953b25a25a4b9181e1a627924962f7a421f581387c3b74"
    assert cassette_key("J6_DIAGNOSE", 0, "abc") == "41f944390796f24be8d755e4"


def test_utf16_length_counts_astral_characters_twice() -> None:
    assert utf16_length("abc") == 3
    assert utf16_length("a\U0001f600") == 3


def test_money_uses_indian_grouping() -> None:
    assert format_money(1249900) == "₹12,499.00"
    assert format_money(10000000) == "₹1,00,000.00"
    assert format_money(5) == "₹0.05"
    assert format_money(-123456789) == "-₹12,34,567.89"
    with pytest.raises(TypeError):
        format_money(1.5)


def test_pii_scrubber_removes_emails_phones_and_long_numbers() -> None:
    text = "mail a.b@x.io or call +91 98765 43210, card 4111 1111 1111 1111 ok"
    assert scrub_pii_text(text) == "mail [email removed] or call [phone removed], card [number removed] ok"
