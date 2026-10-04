import { describe, expect, it } from 'vitest';
import { Cart, applyDiscount, subtotal } from '../src/cart.js';

describe('cart', () => {
  it('adds up line items', () => {
    expect(
      subtotal([
        { price: 2.5, qty: 2 },
        { price: 1, qty: 3 },
      ]),
    ).toBe(8);
  });

  it('applies a percentage discount', () => {
    expect(applyDiscount(50, 10)).toBe(45);
  });

  it('rejects discounts over 100%', () => {
    expect(() => applyDiscount(50, 120)).toThrow(RangeError);
  });

  it('totals a cart', () => {
    expect(new Cart().add({ sku: 'a', price: 3, qty: 2 }).total()).toBe(6);
  });
});
