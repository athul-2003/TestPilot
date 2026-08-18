import { describe, expect, it } from 'vitest';
import request from 'supertest';

describe('orders api', () => {
  it('creates an order', async () => {
    const res = await request('http://localhost:3000').post('/orders');
    expect(res.status).toBe(201);
  });
});
