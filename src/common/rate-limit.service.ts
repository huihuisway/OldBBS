import { HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { RedisClientType } from 'redis';

@Injectable()
export class RateLimitService {
  private client?: RedisClientType;

  configure(client: RedisClientType) { this.client = client; }

  async assertAllowed(action: string, subject: { userId?: number; ip?: string }, limit: number, windowMs: number) {
    if (!this.client?.isReady) throw new ServiceUnavailableException('Rate limiter is unavailable');
    const keys: string[] = [];
    if (subject.userId) keys.push(`oldbbs:rate:user:${subject.userId}:${action}`);
    if (subject.ip) {
      const ipHash = createHash('sha256').update(subject.ip).digest('hex').slice(0, 24);
      keys.push(`oldbbs:rate:ip:${ipHash}:${action}`);
    }
    for (const key of keys) {
      const count = Number(await this.client.eval(
        "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); end; return count",
        { keys: [key], arguments: [String(windowMs)] },
      ));
      if (count > limit) throw new HttpException('Too many requests. Please try again later.', 429);
    }
  }
}
