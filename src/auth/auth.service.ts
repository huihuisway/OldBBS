import { Injectable, UnauthorizedException, ForbiddenException, HttpException, ConflictException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { LoginAttempt, SiteSetting, User } from '../database/entities';
import { config } from '../config';
import { rethrowReadableDatabaseError } from '../common/database-errors';

export type PublicUser = Pick<User, 'id' | 'username' | 'nickname' | 'role' | 'status' | 'signature' | 'avatar' | 'postCount' | 'createdAt' | 'lastOnlineAt' | 'lowBandwidth' | 'theme' | 'sessionVersion'>;
function derive(password: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCallback(password, salt, length, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derive(password, salt, 64);
  return `scrypt$32768$8$1$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPasswordHash(password: string, encoded: string): Promise<boolean> {
  const [scheme, n, r, p, saltHex, hashHex] = encoded.split('$');
  if (scheme !== 'scrypt' || n !== '32768' || r !== '8' || p !== '1' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await derive(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

@Injectable()
export class AuthService {
  private attemptsCleanupAt = 0;
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(LoginAttempt) private readonly attempts: Repository<LoginAttempt>,
    @InjectRepository(SiteSetting) private readonly settings: Repository<SiteSetting>,
  ) {}

  async register(input: { username: string; nickname?: string; email?: string; password: string }, ip: string): Promise<PublicUser> {
    if (!(await this.registrationOpen())) throw new ForbiddenException('Registration is currently closed');
    await this.cleanupAttempts();
    const registrationIdentity = `register:${ip || 'unknown'}`.slice(0, 190);
    const attemptsSince = new Date(Date.now() - 60 * 60_000);
    const registrations = await this.attempts.createQueryBuilder('a').where('a.identity = :identity AND a.createdAt >= :since', { identity: registrationIdentity, since: attemptsSince }).getCount();
    if (registrations >= 5) throw new HttpException('Too many registration attempts. Try again later.', 429);
    const attempt = await this.attempts.save(this.attempts.create({ identity: registrationIdentity, ip: (ip || 'unknown').slice(0, 45), succeeded: false }));
    const username = input.username.trim().toLowerCase();
    if (!/^[a-z0-9_\-]{3,32}$/.test(username)) throw new BadRequestException('Username must be 3–32 characters: letters, numbers, _ or -');
    if (input.password.length < 12 || input.password.length > 256) throw new BadRequestException('Password must contain 12–256 characters');
    if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) throw new BadRequestException('Email address is invalid');
    if (await this.users.findOne({ where: [{ username }, ...(input.email ? [{ email: input.email.toLowerCase() }] : [])] })) throw new ConflictException('Username or email is already in use');
    const user = this.users.create({ username, nickname: (input.nickname || username).trim().slice(0, 64), email: input.email?.trim().toLowerCase() || null, passwordHash: await hashPassword(input.password), role: 'user', status: 'active' });
    let saved: User;
    try { saved = await this.users.save(user); }
    catch (error) { rethrowReadableDatabaseError(error, 'Username or email is already in use'); }
    await this.attempts.update(attempt.id, { succeeded: true });
    return this.publicUser(saved);
  }

  async registrationOpen() {
    const override = await this.settings.findOneBy({ key: 'registration_enabled' });
    if (override?.value === 'true') return true;
    if (override?.value === 'false') return false;
    return config.registrationEnabled;
  }

  async authenticate(identityInput: string, password: string, ip: string): Promise<PublicUser> {
    const identity = identityInput.trim().toLowerCase();
    const since = new Date(Date.now() - 15 * 60_000);
    await this.cleanupAttempts();
    const [accountFailures, ipFailures, pairFailures] = await Promise.all([
      this.failureCount('a.identity = :identity', { identity }, since),
      this.failureCount('a.ip = :ip', { ip }, since),
      this.failureCount('a.identity = :identity AND a.ip = :ip', { identity, ip }, since),
    ]);
    if (accountFailures >= 12 || ipFailures >= 120 || pairFailures >= 8) throw new HttpException('Too many sign-in attempts. Try again in a few minutes.', 429);
    const user = await this.users.createQueryBuilder('u').addSelect('u.passwordHash').where('u.username = :identity OR u.email = :identity', { identity }).getOne();
    const valid = user ? await verifyPasswordHash(password, user.passwordHash).catch(() => false) : false;
    await this.recordAttempt(identity, ip, valid);
    if (!valid || !user) throw new UnauthorizedException('Username or password is incorrect');
    if (user.status !== 'active') throw new ForbiddenException(user.status === 'banned' ? `Account is suspended: ${user.banReason || 'contact a moderator'}` : 'Account is awaiting review');
    await this.users.update(user.id, { lastOnlineAt: new Date() });
    return this.publicUser(user);
  }

  async verifyPassword(userId: number, password: string): Promise<void> {
    const user = await this.users.createQueryBuilder('u').addSelect('u.passwordHash').where('u.id = :userId', { userId }).getOne();
    if (!user || user.status !== 'active' || !(await verifyPasswordHash(password, user.passwordHash).catch(() => false))) throw new UnauthorizedException('Password is incorrect');
  }

  async changePassword(userId: number, currentPassword: string, nextPassword: string): Promise<void> {
    if (nextPassword.length < 12 || nextPassword.length > 256) throw new BadRequestException('Password must contain 12–256 characters');
    await this.verifyPassword(userId, currentPassword);
    await this.users.createQueryBuilder().update(User).set({ passwordHash: await hashPassword(nextPassword), sessionVersion: () => '`sessionVersion` + 1' }).where('id = :userId', { userId }).execute();
  }

  async findById(id: number): Promise<PublicUser | null> {
    const user = await this.users.findOne({ where: { id } });
    return user ? this.publicUser(user) : null;
  }

  async sessionVersionFor(userId: number): Promise<number> {
    const user = await this.users.findOne({ where: { id: userId } });
    return user?.sessionVersion ?? 0;
  }

  async validateSession(userId: number, version: number | undefined): Promise<PublicUser | null> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user || user.status !== 'active' || (user.sessionVersion ?? 0) !== Number(version ?? 0)) return null;
    const heartbeatCutoff = new Date(Date.now() - 5 * 60_000);
    if (!user.lastOnlineAt || user.lastOnlineAt < heartbeatCutoff) {
      const now = new Date();
      await this.users.createQueryBuilder().update(User).set({ lastOnlineAt: now })
        .where('id = :userId AND (lastOnlineAt IS NULL OR lastOnlineAt < :cutoff)', { userId, cutoff: heartbeatCutoff }).execute();
      user.lastOnlineAt = now;
    }
    return this.publicUser(user);
  }

  async findByUsername(username: string): Promise<PublicUser | null> {
    const user = await this.users.findOne({ where: { username: username.toLowerCase() } });
    return user ? this.publicUser(user) : null;
  }

  async updateProfile(userId: number, input: { nickname: string; signature?: string; theme?: string; lowBandwidth?: boolean }): Promise<void> {
    if (!(await this.users.existsBy({ id: userId, status: 'active' }))) throw new ForbiddenException('This account is not active');
    const nickname = (input.nickname || '').trim();
    if (nickname.length < 1 || nickname.length > 64) throw new BadRequestException('Nickname must contain 1–64 characters');
    await this.users.update(userId, { nickname, signature: (input.signature || '').slice(0, 500), theme: input.theme === 'clean' ? 'clean' : 'classic', lowBandwidth: input.lowBandwidth === true });
  }

  async listUsers(query: string): Promise<PublicUser[]> {
    const users = await this.users.createQueryBuilder('u').where('u.username LIKE :q OR u.nickname LIKE :q', { q: `%${query.slice(0, 80)}%` }).orderBy('u.id', 'ASC').take(30).getMany();
    return users.map((u) => this.publicUser(u));
  }

  async ban(userId: number, reason: string, banned: boolean): Promise<void> {
    await this.users.createQueryBuilder().update(User).set({ status: banned ? 'banned' : 'active', banReason: banned ? reason.slice(0, 500) : null, sessionVersion: () => '`sessionVersion` + 1' }).where('id = :userId', { userId }).execute();
  }

  async forceLogout(userId: number): Promise<void> {
    if (!(await this.users.existsBy({ id: userId }))) throw new BadRequestException('User not found');
    await this.users.createQueryBuilder().update(User).set({ sessionVersion: () => '`sessionVersion` + 1' }).where('id = :userId', { userId }).execute();
  }

  publicUser(user: User): PublicUser {
    const { id, username, nickname, role, status, signature, avatar, postCount, createdAt, lastOnlineAt, lowBandwidth, theme, sessionVersion } = user;
    return { id, username, nickname, role, status, signature, avatar, postCount, createdAt, lastOnlineAt, lowBandwidth, theme, sessionVersion };
  }

  private async recordAttempt(identity: string, ip: string, succeeded: boolean): Promise<void> {
    await this.attempts.save(this.attempts.create({ identity: identity.slice(0, 190), ip: (ip || 'unknown').slice(0, 45), succeeded }));
  }

  private async failureCount(condition: string, parameters: Record<string, string>, since: Date): Promise<number> {
    return this.attempts.createQueryBuilder('a').where(`${condition} AND a.succeeded = false`, parameters).andWhere('a.createdAt >= :since', { since }).getCount();
  }

  private async cleanupAttempts(): Promise<void> {
    if (Date.now() - this.attemptsCleanupAt < 60 * 60_000) return;
    this.attemptsCleanupAt = Date.now();
    await this.attempts.delete({ createdAt: LessThan(new Date(Date.now() - 30 * 24 * 60 * 60_000)) });
  }

  assertRole(user: PublicUser | undefined, roles: Array<PublicUser['role']>): PublicUser {
    if (!user) throw new UnauthorizedException('Sign in is required');
    if (user.status !== 'active') throw new ForbiddenException('This account is not active');
    if (!roles.includes(user.role)) throw new ForbiddenException('You do not have permission to do that');
    return user;
  }
}
