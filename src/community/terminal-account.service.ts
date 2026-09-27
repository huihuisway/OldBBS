import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { IsNull, Repository } from 'typeorm';
import { utils as sshUtils } from 'ssh2';
import { AuthService, PublicUser } from '../auth/auth.service';
import { SshKey, TerminalAccessKey, User } from '../database/entities';

@Injectable()
export class TerminalAccountService {
  constructor(
    private readonly auth: AuthService,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(TerminalAccessKey) private readonly terminalKeys: Repository<TerminalAccessKey>,
    @InjectRepository(SshKey) private readonly sshKeys: Repository<SshKey>,
  ) {}

  async terminalAccessKeys(userId: number) {
    return this.terminalKeys.find({ where: { userId, revokedAt: IsNull() }, order: { createdAt: 'DESC' } });
  }

  async createTerminalKey(user: PublicUser, name: string) {
    user = await this.currentUser(user);
    if (!name.trim() || name.length > 80) throw new BadRequestException('Key name must contain 1–80 characters');
    const raw = `obk_${randomBytes(32).toString('base64url')}`;
    const hash = createHash('sha256').update(raw).digest('hex');
    await this.terminalKeys.save({ userId: user.id, name: name.trim(), keyHash: hash, scope: 'terminal', lastUsedAt: null, lastIp: null, revokedAt: null });
    return raw;
  }

  async revokeTerminalKey(userId: number, keyId: number) {
    await this.terminalKeys.update({ id: keyId, userId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  async authenticateTerminalKey(raw: string, ip: string): Promise<PublicUser | null> {
    if (!raw.startsWith('obk_')) return null;
    const hash = createHash('sha256').update(raw).digest('hex');
    const found = await this.terminalKeys.createQueryBuilder('k').addSelect('k.keyHash').where('k.keyHash = :hash AND k.revokedAt IS NULL', { hash }).getOne();
    if (!found) return null;
    const digest = Buffer.from(hash, 'hex'), saved = Buffer.from(found.keyHash, 'hex');
    if (digest.length !== saved.length || !timingSafeEqual(digest, saved)) return null;
    await this.terminalKeys.update(found.id, { lastUsedAt: new Date(), lastIp: ip.slice(0, 45) });
    const user = await this.auth.findById(found.userId);
    return user?.status === 'active' ? user : null;
  }

  async addSshKey(user: PublicUser, name: string, publicKeyText: string) {
    user = await this.currentUser(user);
    if (!name.trim() || name.length > 80) throw new BadRequestException('Key name must contain 1–80 characters');
    const parsed = sshUtils.parseKey(publicKeyText);
    if (Array.isArray(parsed) || parsed instanceof Error) throw new BadRequestException('SSH public key is invalid');
    const type = parsed.type;
    if (type !== 'ssh-ed25519' && type !== 'ssh-rsa') throw new BadRequestException('Only ed25519 and RSA keys are supported');
    const blob = parsed.getPublicSSH();
    const fingerprint = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
    return this.sshKeys.save({ userId: user.id, name: name.trim(), publicKey: publicKeyText.trim(), fingerprint, lastUsedAt: null, lastIp: null, revokedAt: null });
  }

  async listSshKeys(userId: number) {
    return this.sshKeys.find({ where: { userId, revokedAt: IsNull() }, order: { createdAt: 'DESC' } });
  }

  async revokeSshKey(userId: number, keyId: number) {
    await this.sshKeys.update({ id: keyId, userId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  async verifySshKey(username: string, key: Buffer, ip: string, signedData?: Buffer, signature?: Buffer, hashAlgo?: string): Promise<PublicUser | null> {
    const user = await this.auth.findByUsername(username);
    if (!user || user.status !== 'active') return null;
    const rows = await this.sshKeys.find({ where: { userId: user.id, revokedAt: IsNull() } });
    const fingerprint = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
    const match = rows.find((row) => row.fingerprint === fingerprint);
    if (!match) return null;
    const parsed = sshUtils.parseKey(match.publicKey);
    if (parsed instanceof Error || Array.isArray(parsed)) return null;
    if (signedData && (!signature || parsed.verify(signedData, signature, hashAlgo) !== true)) return null;
    await this.sshKeys.update(match.id, { lastUsedAt: new Date(), lastIp: ip.slice(0, 45) });
    return user;
  }

  async terminalLogin(username: string, secret: string, ip: string, allowPassword: boolean): Promise<PublicUser | null> {
    const keyUser = await this.authenticateTerminalKey(secret, ip);
    if (keyUser && (!username || keyUser.username === username.toLowerCase())) return keyUser;
    if (!allowPassword || !username) return null;
    try { return await this.auth.authenticate(username, secret, ip); } catch { return null; }
  }

  private async currentUser(user: PublicUser): Promise<PublicUser> {
    const current = await this.users.findOneBy({ id: user.id });
    if (!current || current.status !== 'active') throw new ForbiddenException('This account is not active');
    return this.auth.publicUser(current);
  }
}
