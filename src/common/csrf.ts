import { ForbiddenException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

export function validCsrfToken(expected: unknown, bodyToken: unknown, headerToken: unknown): boolean {
  if (typeof expected !== 'string' || !expected) return false;
  const left = Buffer.from(expected);
  const matches = (supplied: unknown) => {
    if (typeof supplied !== 'string' || !supplied) return false;
    const right = Buffer.from(supplied);
    return left.length === right.length && timingSafeEqual(left, right);
  };
  return matches(bodyToken) || matches(headerToken);
}

export function assertCsrfToken(expected: unknown, bodyToken: unknown, headerToken: unknown): void {
  if (!validCsrfToken(expected, bodyToken, headerToken)) {
    throw new ForbiddenException('This form expired. Please reload and try again.');
  }
}
