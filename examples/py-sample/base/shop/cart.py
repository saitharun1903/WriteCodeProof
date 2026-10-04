def round_money(amount):
    return round(amount, 2)


def subtotal(items):
    return round_money(sum(item["price"] * item["qty"] for item in items))


def apply_discount(total, percent):
    if percent < 0 or percent > 100:
        raise ValueError("percent must be between 0 and 100")
    return round_money(total - total * percent / 100)


def cheapest_item(items):
    if not items:
        return None
    return min(items, key=lambda item: item["price"])


def _legacy_total(items):
    total = 0
    for item in items:
        total += item["price"] * item["qty"]
    return total


class Cart:
    def __init__(self):
        self.items = []

    def add(self, item):
        self.items.append(dict(item))
        return self

    def total(self):
        return subtotal(self.items)
