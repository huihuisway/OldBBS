import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimitService } from '../src/common/rate-limit.service';

test('rate limits share action windows by user and IP, and fail closed without Redis', async () => {
  const service = new RateLimitService();
  await assert.rejects(service.assertAllowed('reply', { userId: 7, ip: '203.0.113.4' }, 1, 60_000), /Rate limiter is unavailable/);
  const counters = new Map<string, number>();
  const seenKeys: string[] = [];
  service.configure({
    isReady: true,
    eval: async (_script: string, options: { keys: string[] }) => {
      const key = options.keys[0];
      seenKeys.push(key);
      const next = (counters.get(key) || 0) + 1;
      counters.set(key, next);
      return next;
    },
  } as any);
  await service.assertAllowed('reply', { userId: 7, ip: '203.0.113.4' }, 1, 60_000);
  await assert.rejects(service.assertAllowed('reply', { userId: 7, ip: '203.0.113.4' }, 1, 60_000), (error: any) => error.getStatus() === 429);
  await service.assertAllowed('message', { userId: 7, ip: '203.0.113.4' }, 1, 60_000);
  assert.ok(seenKeys.includes('oldbbs:rate:user:7:reply'));
  assert.ok(seenKeys.some((key) => key.startsWith('oldbbs:rate:ip:') && key.endsWith(':reply')));
  assert.equal(seenKeys.some((key) => key.includes('203.0.113.4')), false);
});
