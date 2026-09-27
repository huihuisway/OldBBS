import {
  Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('users')
@Index(['username'], { unique: true })
@Index(['email'], { unique: true })
export class User {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: 'varchar', length: 32 }) username!: string;
  @Column({ type: 'varchar', length: 64 }) nickname!: string;
  @Column({ type: 'varchar', length: 190, nullable: true }) email!: string | null;
  @Column({ type: 'varchar', length: 255, select: false }) passwordHash!: string;
  @Column({ type: 'text', nullable: true }) signature!: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) avatar!: string | null;
  @Column({ type: 'enum', enum: ['user', 'moderator', 'admin'], default: 'user' }) role!: 'user' | 'moderator' | 'admin';
  @Column({ type: 'enum', enum: ['active', 'banned', 'pending'], default: 'active' }) status!: 'active' | 'banned' | 'pending';
  @Column({ type: 'text', nullable: true }) banReason!: string | null;
  @Column({ type: 'int', default: 0 }) postCount!: number;
  @Column({ type: 'int', default: 0 }) sessionVersion!: number;
  @Column({ type: 'bigint', default: 104857600 }) storageQuotaBytes!: string;
  @Column({ type: 'bigint', default: 0 }) storageUsedBytes!: string;
  @Column({ type: 'datetime', nullable: true }) lastOnlineAt!: Date | null;
  @Column({ type: 'boolean', default: false }) emailVerified!: boolean;
  @Column({ type: 'boolean', default: false }) lowBandwidth!: boolean;
  @Column({ type: 'varchar', length: 16, default: 'classic' }) theme!: string;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity('boards')
@Index(['slug'], { unique: true })
export class Board {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: 'varchar', length: 80 }) slug!: string;
  @Column({ type: 'varchar', length: 120 }) name!: string;
  @Column({ type: 'text', default: '' }) description!: string;
  @Column({ type: 'int', nullable: true }) parentId!: number | null;
  @Column({ type: 'int', default: 0 }) sortOrder!: number;
  @Column({ type: 'varchar', length: 255, nullable: true }) icon!: string | null;
  @Column({ type: 'varchar', length: 32, default: 'classic' }) theme!: string;
  @Column({ type: 'boolean', default: false }) isHidden!: boolean;
  @Column({ type: 'boolean', default: false }) isReadOnly!: boolean;
  @Column({ type: 'int', nullable: true }) minimumRole!: number | null;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity('threads')
@Index(['boardId', 'lastPostAt'])
@Index(['slug'])
export class Thread {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: 'int' }) boardId!: number;
  @Column({ type: 'int' }) authorId!: number;
  @Column({ type: 'int', nullable: true }) deviceId!: number | null;
  @Column({ type: 'int', nullable: true }) softwareId!: number | null;
  @Column({ type: 'varchar', length: 180 }) title!: string;
  @Column({ type: 'varchar', length: 220 }) slug!: string;
  @Column({ type: 'varchar', length: 24, default: 'normal' }) type!: string;
  @Column({ type: 'enum', enum: ['visible', 'deleted', 'hidden'], default: 'visible' }) status!: 'visible' | 'deleted' | 'hidden';
  @Column({ type: 'boolean', default: false }) isPinned!: boolean;
  @Column({ type: 'boolean', default: false }) isFeatured!: boolean;
  @Column({ type: 'boolean', default: false }) isLocked!: boolean;
  @Column({ type: 'int', default: 0 }) replyCount!: number;
  @Column({ type: 'int', default: 0 }) viewCount!: number;
  @Column({ type: 'int', nullable: true }) lastPostId!: number | null;
  @Column({ type: 'datetime', nullable: true }) lastPostAt!: Date | null;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity('posts')
@Index(['threadId', 'floor'], { unique: true })
@Index(['authorId', 'createdAt'])
export class Post {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: 'int' }) threadId!: number;
  @Column({ type: 'int' }) authorId!: number;
  @Column({ type: 'longtext' }) content!: string;
  @Column({ type: 'longtext', nullable: true }) renderedHtml!: string | null;
  @Column({ type: 'int', default: 0 }) renderVersion!: number;
  @Column({ type: 'varchar', length: 16, default: 'markdown' }) contentFormat!: string;
  @Column({ type: 'int' }) floor!: number;
  @Column({ type: 'int', nullable: true }) replyToPostId!: number | null;
  @Column({ type: 'enum', enum: ['visible', 'deleted', 'hidden'], default: 'visible' }) status!: 'visible' | 'deleted' | 'hidden';
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
  @Column({ type: 'datetime', nullable: true }) deletedAt!: Date | null;
}

@Entity('devices')
@Index(['slug'], { unique: true })
export class Device {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: 'varchar', length: 180 }) slug!: string;
  @Column({ type: 'varchar', length: 100 }) brand!: string;
  @Column({ type: 'varchar', length: 120 }) model!: string;
  @Column({ type: 'varchar', length: 180 }) name!: string;
  @Column({ type: 'smallint', nullable: true }) releaseYear!: number | null;
  @Column({ type: 'varchar', length: 80 }) platform!: string;
  @Column({ type: 'enum', enum: ['active', 'deleted'], default: 'active' }) status!: 'active' | 'deleted';
  @Column({ type: 'enum', enum: ['draft', 'pending_review', 'published', 'rejected'], default: 'pending_review' }) reviewStatus!: 'draft' | 'pending_review' | 'published' | 'rejected';
  @Column({ type: 'text', nullable: true }) osVersions!: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) cpu!: string | null;
  @Column({ type: 'varchar', length: 80, nullable: true }) ram!: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true }) storage!: string | null;
  @Column({ type: 'varchar', length: 120, nullable: true }) screen!: string | null;
  @Column({ type: 'text' }) description!: string;
  @Column({ type: 'varchar', length: 500, nullable: true }) cover!: string | null;
  @Column({ type: 'int' }) authorId!: number;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity('software')
@Index(['slug'], { unique: true })
export class Software {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: 'varchar', length: 180 }) slug!: string;
  @Column({ type: 'varchar', length: 180 }) name!: string;
  @Column({ type: 'varchar', length: 80 }) platform!: string;
  @Column({ type: 'varchar', length: 80 }) version!: string;
  @Column({ type: 'varchar', length: 180, nullable: true }) developer!: string | null;
  @Column({ type: 'text' }) description!: string;
  @Column({ type: 'varchar', length: 100, nullable: true }) minimumOs!: string | null;
  @Column({ type: 'text', nullable: true }) architectures!: string | null;
  @Column({ type: 'varchar', length: 1000, nullable: true }) downloadUrl!: string | null;
  @Column({ type: 'varchar', length: 255, nullable: true }) fileName!: string | null;
  @Column({ type: 'bigint', nullable: true }) fileSize!: string | null;
  @Column({ type: 'varchar', length: 64, nullable: true }) sha256!: string | null;
  @Column({ type: 'enum', enum: ['draft', 'pending_review', 'published', 'rejected'], default: 'pending_review' }) status!: 'draft' | 'pending_review' | 'published' | 'rejected';
  @Column({ type: 'int' }) authorId!: number;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity('compatibility_reports')
@Index(['deviceId', 'softwareId'])
export class CompatibilityReport {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: 'int' }) deviceId!: number;
  @Column({ type: 'int' }) softwareId!: number;
  @Column({ type: 'int' }) authorId!: number;
  @Column({ type: 'varchar', length: 100 }) systemVersion!: string;
  @Column({ type: 'enum', enum: ['working', 'partial', 'broken', 'unknown'] }) result!: 'working' | 'partial' | 'broken' | 'unknown';
  @Column({ type: 'enum', enum: ['pending', 'approved', 'rejected', 'deleted'], default: 'pending' }) status!: 'pending' | 'approved' | 'rejected' | 'deleted';
  @Column({ type: 'text', default: '' }) notes!: string;
  @CreateDateColumn() createdAt!: Date;
}

@Entity('bookmarks')
@Index(['userId', 'threadId'], { unique: true })
export class Bookmark { @PrimaryGeneratedColumn() id!: number; @Column({ type: 'int' }) userId!: number; @Column({ type: 'int' }) threadId!: number; @CreateDateColumn() createdAt!: Date; }

@Entity('follows')
@Index(['userId', 'targetUserId'], { unique: true })
export class Follow { @PrimaryGeneratedColumn() id!: number; @Column({ type: 'int' }) userId!: number; @Column({ type: 'int' }) targetUserId!: number; @CreateDateColumn() createdAt!: Date; }

@Entity('notifications')
@Index(['userId', 'isRead', 'createdAt'])
export class Notification { @PrimaryGeneratedColumn() id!: number; @Column({ type: 'int' }) userId!: number; @Column({ type: 'varchar', length: 40 }) type!: string; @Column({ type: 'varchar', length: 255 }) title!: string; @Column({ type: 'text', default: '' }) body!: string; @Column({ type: 'varchar', length: 500, nullable: true }) url!: string | null; @Column({ type: 'boolean', default: false }) isRead!: boolean; @CreateDateColumn() createdAt!: Date; }

@Entity('conversations')
export class Conversation { @PrimaryGeneratedColumn() id!: number; @Column({ type: 'int' }) userAId!: number; @Column({ type: 'int' }) userBId!: number; @Column({ type: 'boolean', default: false }) hiddenByA!: boolean; @Column({ type: 'boolean', default: false }) hiddenByB!: boolean; @Column({ type: 'datetime', nullable: true }) lastMessageAt!: Date | null; @CreateDateColumn() createdAt!: Date; }

@Entity('messages')
@Index(['conversationId', 'createdAt'])
export class Message { @PrimaryGeneratedColumn() id!: number; @Column({ type: 'int' }) conversationId!: number; @Column({ type: 'int' }) senderId!: number; @Column({ type: 'text' }) body!: string; @Column({ type: 'boolean', default: false }) isRead!: boolean; @Column({ type: 'datetime', nullable: true }) hiddenAt!: Date | null; @CreateDateColumn() createdAt!: Date; }

@Entity('reports')
@Index(['status', 'createdAt'])
export class Report { @PrimaryGeneratedColumn() id!: number; @Column({ type: 'int' }) reporterId!: number; @Column({ type: 'varchar', length: 32 }) targetType!: string; @Column({ type: 'int' }) targetId!: number; @Column({ type: 'text' }) reason!: string; @Column({ type: 'enum', enum: ['open', 'resolved', 'dismissed'], default: 'open' }) status!: 'open' | 'resolved' | 'dismissed'; @Column({ type: 'int', nullable: true }) handledById!: number | null; @CreateDateColumn() createdAt!: Date; @UpdateDateColumn() updatedAt!: Date; }

@Entity('audit_logs')
@Index(['targetType', 'targetId', 'createdAt'])
export class AuditLog { @PrimaryGeneratedColumn() id!: number; @Column({ type: 'int', nullable: true }) actorId!: number | null; @Column({ type: 'varchar', length: 100 }) action!: string; @Column({ type: 'varchar', length: 40 }) targetType!: string; @Column({ type: 'int', nullable: true }) targetId!: number | null; @Column({ type: 'json', nullable: true }) metadata!: Record<string, unknown> | null; @Column({ type: 'varchar', length: 45, nullable: true }) ip!: string | null; @CreateDateColumn() createdAt!: Date; }

@Entity('terminal_access_keys')
@Index(['keyHash'], { unique: true })
export class TerminalAccessKey { @PrimaryGeneratedColumn() id!: number; @Column({ type: 'int' }) userId!: number; @Column({ type: 'varchar', length: 80 }) name!: string; @Column({ type: 'varchar', length: 64, select: false }) keyHash!: string; @Column({ type: 'varchar', length: 16, default: 'terminal' }) scope!: string; @Column({ type: 'datetime', nullable: true }) lastUsedAt!: Date | null; @Column({ type: 'varchar', length: 45, nullable: true }) lastIp!: string | null; @Column({ type: 'datetime', nullable: true }) revokedAt!: Date | null; @CreateDateColumn() createdAt!: Date; }

@Entity('ssh_keys')
@Index(['fingerprint'], { unique: true })
export class SshKey { @PrimaryGeneratedColumn() id!: number; @Column({ type: 'int' }) userId!: number; @Column({ type: 'varchar', length: 80 }) name!: string; @Column({ type: 'text' }) publicKey!: string; @Column({ type: 'varchar', length: 128 }) fingerprint!: string; @Column({ type: 'datetime', nullable: true }) lastUsedAt!: Date | null; @Column({ type: 'varchar', length: 45, nullable: true }) lastIp!: string | null; @Column({ type: 'datetime', nullable: true }) revokedAt!: Date | null; @CreateDateColumn() createdAt!: Date; }

@Entity('login_attempts')
@Index(['identity', 'createdAt'])
export class LoginAttempt { @PrimaryGeneratedColumn() id!: number; @Column({ type: 'varchar', length: 190 }) identity!: string; @Column({ type: 'varchar', length: 45 }) ip!: string; @Column({ type: 'boolean' }) succeeded!: boolean; @CreateDateColumn() createdAt!: Date; }

@Entity('tags')
@Index(['slug'], { unique: true })
export class Tag { @PrimaryGeneratedColumn() id!: number; @Column({ type: 'varchar', length: 48 }) name!: string; @Column({ type: 'varchar', length: 64 }) slug!: string; @CreateDateColumn() createdAt!: Date; }

@Entity('thread_tags')
@Index(['threadId', 'tagId'], { unique: true })
export class ThreadTag { @PrimaryGeneratedColumn() id!: number; @Column({ type: 'int' }) threadId!: number; @Column({ type: 'int' }) tagId!: number; }

@Entity('attachments')
@Index(['uploaderId', 'createdAt'])
@Index(['sha256'])
export class Attachment { @PrimaryGeneratedColumn() id!: number; @Column({ type: 'varchar', length: 120 }) storageKey!: string; @Column({ type: 'varchar', length: 255 }) originalName!: string; @Column({ type: 'varchar', length: 120 }) mimeType!: string; @Column({ type: 'int' }) fileSize!: number; @Column({ type: 'varchar', length: 64 }) sha256!: string; @Column({ type: 'enum', enum: ['pending_scan', 'clean', 'rejected', 'scan_failed'], default: 'pending_scan' }) scanStatus!: 'pending_scan' | 'clean' | 'rejected' | 'scan_failed'; @Column({ type: 'int' }) uploaderId!: number; @Column({ type: 'int', nullable: true }) threadId!: number | null; @CreateDateColumn() createdAt!: Date; }

@Entity('email_tokens')
@Index(['userId', 'type', 'expiresAt'])
export class EmailToken { @PrimaryGeneratedColumn() id!: number; @Column({ type: 'int' }) userId!: number; @Column({ type: 'enum', enum: ['verify_email', 'reset_password'] }) type!: 'verify_email' | 'reset_password'; @Column({ type: 'varchar', length: 64, unique: true }) tokenHash!: string; @Column({ type: 'datetime' }) expiresAt!: Date; @Column({ type: 'datetime', nullable: true }) usedAt!: Date | null; @CreateDateColumn() createdAt!: Date; }

@Entity('site_settings')
export class SiteSetting { @PrimaryColumn({ type: 'varchar', length: 100 }) key!: string; @Column({ type: 'text' }) value!: string; @Column({ type: 'int', nullable: true }) updatedById!: number | null; @UpdateDateColumn() updatedAt!: Date; }
