import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MessagingService } from '../src/community/messaging.service';

test('a conversation returns the newest 200 messages oldest-to-newest', async () => {
  const service: any = Object.create(MessagingService.prototype);
  const rows = Array.from({ length: 250 }, (_, index) => ({ id: index + 1, conversationId: 4, senderId: index % 2 ? 2 : 1, body: `message-${index + 1}`, createdAt: new Date((index + 1) * 1000), hiddenAt: null, isRead: false }));
  service.conversations = { findOne: async () => ({ id: 4, userAId: 1, userBId: 2 }) };
  service.messages = {
    createQueryBuilder: () => {
      let take = 0;
      return {
        where() { return this; }, orderBy() { return this; }, addOrderBy() { return this; }, take(value: number) { take = value; return this; },
        getMany: async () => [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, take),
      };
    },
    update: async () => undefined,
  };
  service.auth = { findById: async () => ({ id: 2, username: 'other' }) };
  const result = await service.conversation(1, 4);
  assert.equal(result.messages.length, 200);
  assert.equal(result.messages[0].id, 51);
  assert.equal(result.messages[result.messages.length - 1].id, 250);
});
