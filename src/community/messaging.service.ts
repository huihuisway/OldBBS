import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { AuthService, PublicUser } from '../auth/auth.service';
import { Conversation, Message, Notification, User } from '../database/entities';

@Injectable()
export class MessagingService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly auth: AuthService,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Notification) private readonly notifications: Repository<Notification>,
    @InjectRepository(Conversation) private readonly conversations: Repository<Conversation>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
  ) {}

  async notificationsFor(userId: number) {
    return this.notifications.find({ where: { userId }, order: { createdAt: 'DESC' }, take: 100 });
  }

  async markNotificationsRead(userId: number) { await this.notifications.update({ userId, isRead: false }, { isRead: true }); }

  async unreadCount(userId: number) {
    const [notifications, messages] = await Promise.all([
      this.notifications.count({ where: { userId, isRead: false } }),
      this.messages.createQueryBuilder('m').innerJoin(Conversation, 'c', 'c.id = m.conversationId')
        .where('m.isRead = false AND m.senderId <> :userId AND (c.userAId = :userId OR c.userBId = :userId)', { userId }).getCount(),
    ]);
    return notifications + messages;
  }

  async sendMessage(sender: PublicUser, toUsername: string, body: string) {
    const current = await this.users.findOneBy({ id: sender.id, status: 'active' });
    if (!current) throw new BadRequestException('This account is not active');
    sender = this.auth.publicUser(current);
    const recipient = await this.auth.findByUsername(toUsername);
    if (!recipient || recipient.status !== 'active') throw new NotFoundException('Recipient not found');
    if (recipient.id === sender.id) throw new BadRequestException('You cannot message yourself');
    if (!body.trim() || body.length > 10_000) throw new BadRequestException('Message must contain 1–10000 characters');
    const userAId = Math.min(sender.id, recipient.id), userBId = Math.max(sender.id, recipient.id);
    return this.db.transaction(async (manager) => {
      const conversations = manager.getRepository(Conversation);
      await conversations.createQueryBuilder().insert().values({ userAId, userBId, lastMessageAt: new Date(), hiddenByA: false, hiddenByB: false }).orIgnore().execute();
      const conversation = await conversations.findOneBy({ userAId, userBId });
      if (!conversation) throw new Error('Conversation could not be created');
      await manager.getRepository(Message).save({ conversationId: conversation.id, senderId: sender.id, body: body.trim(), isRead: false, hiddenAt: null });
      await conversations.update(conversation.id, { lastMessageAt: new Date(), hiddenByA: false, hiddenByB: false });
      await manager.getRepository(Notification).save({ userId: recipient.id, type: 'message', title: 'New private message', body: `Message from ${sender.nickname}`, url: `/messages/${conversation.id}` });
      return conversation.id;
    });
  }

  async listConversations(userId: number) {
    const rows = await this.conversations.createQueryBuilder('c').where('(c.userAId = :userId AND c.hiddenByA = false) OR (c.userBId = :userId AND c.hiddenByB = false)', { userId }).orderBy('c.lastMessageAt', 'DESC').take(100).getMany();
    const ids = [...new Set(rows.map((conversation) => conversation.userAId === userId ? conversation.userBId : conversation.userAId))];
    const users = ids.length ? await this.users.find({ where: { id: In(ids), status: 'active' } }) : [];
    const map = new Map(users.map((user) => [user.id, this.auth.publicUser(user)]));
    return rows.map((conversation) => ({ ...conversation, otherUser: map.get(conversation.userAId === userId ? conversation.userBId : conversation.userAId) }));
  }

  async conversation(userId: number, conversationId: number) {
    const conversation = await this.conversations.findOne({ where: { id: conversationId } });
    if (!conversation || ![conversation.userAId, conversation.userBId].includes(userId)) throw new NotFoundException('Conversation not found');
    const otherId = conversation.userAId === userId ? conversation.userBId : conversation.userAId;
    const [latestMessages, otherUser] = await Promise.all([
      this.messages.createQueryBuilder('m').where('m.conversationId = :conversationId AND m.hiddenAt IS NULL', { conversationId }).orderBy('m.createdAt', 'DESC').addOrderBy('m.id', 'DESC').take(200).getMany(),
      this.auth.findById(otherId),
    ]);
    const messages = latestMessages.reverse();
    return { conversation, messages, otherUser };
  }

  async markConversationRead(userId: number, conversationId: number) {
    const conversation = await this.conversations.findOne({ where: { id: conversationId } });
    if (!conversation || ![conversation.userAId, conversation.userBId].includes(userId)) throw new NotFoundException('Conversation not found');
    const otherId = conversation.userAId === userId ? conversation.userBId : conversation.userAId;
    await this.messages.update({ conversationId, senderId: In([otherId]), isRead: false }, { isRead: true });
  }

  async hideConversation(userId: number, conversationId: number) {
    const conversation = await this.conversations.findOneBy({ id: conversationId });
    if (!conversation || ![conversation.userAId, conversation.userBId].includes(userId)) throw new NotFoundException('Conversation not found');
    await this.conversations.update(conversationId, conversation.userAId === userId ? { hiddenByA: true } : { hiddenByB: true });
  }
}
