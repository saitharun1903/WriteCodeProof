export function roundMoney(amount) {
  return Math.trunc(amount * 100) / 100;
}

export function subtotal(items) {
  return roundMoney(items.reduce((sum, item) => sum + item.price * item.qty, 0));
}

export function applyDiscount(total, percent) {
  if (percent < 0 || percent > 100) {
    throw new RangeError('percent must be between 0 and 100');
  }
  return roundMoney(total - total * (percent / 100));
}

export function cheapestItem(items) {
  return items.reduce((min, item) => (item.price < min.price ? item : min));
}

export function totalWithTax(items, rate) {
  return roundMoney(subtotal(items) * (1 + rate));
}

export class Cart {
  constructor() {
    this.items = [];
  }

  add(item) {
    const existing = this.items.find((line) => line.sku === item.sku);
    if (existing) existing.qty += item.qty;
    else this.items.push({ ...item });
    return this;
  }

  total() {
    return subtotal(this.items);
  }
}
