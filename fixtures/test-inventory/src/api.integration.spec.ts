import { describe, expect, it } from 'vitest';
import request from 'supertest';

describe('GET /health', () => {
  it('returns 200', async () => {
    const res = await request('http://localhost:3000').get('/health');
    expect(res.status).toBe(200);
  });
});
