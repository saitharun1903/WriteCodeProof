import math


def round_money(amount):
    return math.floor(amount * 100) / 100


def subtotal(items):
    return round_money(sum(item["price"] * item["qty"] for item in items))


def apply_discount(total, percent):
    if percent < 0 or percent > 100:
        raise ValueError("percent must be between 0 and 100")
    return round_money(total - total * percent / 100)


def cheapest_item(items):
    return min(items, key=lambda item: item["price"])


def total_with_tax(items, rate):
    return round_money(subtotal(items) * (1 + rate))


class Cart:
    def __init__(self):
        self.items = []

    def add(self, item):
        for line in self.items:
            if line["sku"] == item["sku"]:
                line["qty"] += item["qty"]
                return self
        self.items.append(dict(item))
        return self

    def total(self):
        return subtotal(self.items)
