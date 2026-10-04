import pytest

from shop.cart import Cart, apply_discount, subtotal


def test_adds_up_line_items():
    assert subtotal([{"price": 2.5, "qty": 2}, {"price": 1, "qty": 3}]) == 8


def test_applies_percentage_discount():
    assert apply_discount(50, 10) == 45


def test_rejects_discount_over_100():
    with pytest.raises(ValueError):
        apply_discount(50, 120)


def test_totals_a_cart():
    assert Cart().add({"sku": "a", "price": 3, "qty": 2}).total() == 6
