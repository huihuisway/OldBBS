import { MigrationInterface, QueryRunner } from 'typeorm';

const constraints: Array<[string, string]> = [
  ['boards', 'ALTER TABLE boards ADD CONSTRAINT FK_boards_parent FOREIGN KEY (parentId) REFERENCES boards(id) ON DELETE SET NULL ON UPDATE CASCADE'],
  ['devices', 'ALTER TABLE devices ADD CONSTRAINT FK_devices_author FOREIGN KEY (authorId) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE'],
  ['software', 'ALTER TABLE software ADD CONSTRAINT FK_software_author FOREIGN KEY (authorId) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE'],
  ['threads', 'ALTER TABLE threads ADD CONSTRAINT FK_threads_board FOREIGN KEY (boardId) REFERENCES boards(id) ON DELETE RESTRICT ON UPDATE CASCADE'],
  ['threads', 'ALTER TABLE threads ADD CONSTRAINT FK_threads_author FOREIGN KEY (authorId) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE'],
  ['threads', 'ALTER TABLE threads ADD CONSTRAINT FK_threads_device FOREIGN KEY (deviceId) REFERENCES devices(id) ON DELETE SET NULL ON UPDATE CASCADE'],
  ['threads', 'ALTER TABLE threads ADD CONSTRAINT FK_threads_software FOREIGN KEY (softwareId) REFERENCES software(id) ON DELETE SET NULL ON UPDATE CASCADE'],
  ['posts', 'ALTER TABLE posts ADD CONSTRAINT FK_posts_thread FOREIGN KEY (threadId) REFERENCES threads(id) ON DELETE RESTRICT ON UPDATE CASCADE'],
  ['posts', 'ALTER TABLE posts ADD CONSTRAINT FK_posts_author FOREIGN KEY (authorId) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE'],
  ['posts', 'ALTER TABLE posts ADD CONSTRAINT FK_posts_reply FOREIGN KEY (replyToPostId) REFERENCES posts(id) ON DELETE SET NULL ON UPDATE CASCADE'],
  ['threads', 'ALTER TABLE threads ADD CONSTRAINT FK_threads_last_post FOREIGN KEY (lastPostId) REFERENCES posts(id) ON DELETE SET NULL ON UPDATE CASCADE'],
  ['compatibility_reports', 'ALTER TABLE compatibility_reports ADD CONSTRAINT FK_compat_device FOREIGN KEY (deviceId) REFERENCES devices(id) ON DELETE RESTRICT ON UPDATE CASCADE'],
  ['compatibility_reports', 'ALTER TABLE compatibility_reports ADD CONSTRAINT FK_compat_software FOREIGN KEY (softwareId) REFERENCES software(id) ON DELETE RESTRICT ON UPDATE CASCADE'],
  ['compatibility_reports', 'ALTER TABLE compatibility_reports ADD CONSTRAINT FK_compat_author FOREIGN KEY (authorId) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE'],
  ['bookmarks', 'ALTER TABLE bookmarks ADD CONSTRAINT FK_bookmarks_user FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE'],
  ['bookmarks', 'ALTER TABLE bookmarks ADD CONSTRAINT FK_bookmarks_thread FOREIGN KEY (threadId) REFERENCES threads(id) ON DELETE CASCADE ON UPDATE CASCADE'],
  ['follows', 'ALTER TABLE follows ADD CONSTRAINT FK_follows_user FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE'],
  ['follows', 'ALTER TABLE follows ADD CONSTRAINT FK_follows_target FOREIGN KEY (targetUserId) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE'],
  ['notifications', 'ALTER TABLE notifications ADD CONSTRAINT FK_notifications_user FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE'],
  ['conversations', 'ALTER TABLE conversations ADD CONSTRAINT FK_conversations_user_a FOREIGN KEY (userAId) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE'],
  ['conversations', 'ALTER TABLE conversations ADD CONSTRAINT FK_conversations_user_b FOREIGN KEY (userBId) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE'],
  ['messages', 'ALTER TABLE messages ADD CONSTRAINT FK_messages_conversation FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE ON UPDATE CASCADE'],
  ['messages', 'ALTER TABLE messages ADD CONSTRAINT FK_messages_sender FOREIGN KEY (senderId) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE'],
  ['reports', 'ALTER TABLE reports ADD CONSTRAINT FK_reports_reporter FOREIGN KEY (reporterId) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE'],
  ['reports', 'ALTER TABLE reports ADD CONSTRAINT FK_reports_handler FOREIGN KEY (handledById) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE'],
  ['audit_logs', 'ALTER TABLE audit_logs ADD CONSTRAINT FK_audit_actor FOREIGN KEY (actorId) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE'],
  ['terminal_access_keys', 'ALTER TABLE terminal_access_keys ADD CONSTRAINT FK_terminal_keys_user FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE'],
  ['ssh_keys', 'ALTER TABLE ssh_keys ADD CONSTRAINT FK_ssh_keys_user FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE'],
  ['thread_tags', 'ALTER TABLE thread_tags ADD CONSTRAINT FK_thread_tags_thread FOREIGN KEY (threadId) REFERENCES threads(id) ON DELETE CASCADE ON UPDATE CASCADE'],
  ['thread_tags', 'ALTER TABLE thread_tags ADD CONSTRAINT FK_thread_tags_tag FOREIGN KEY (tagId) REFERENCES tags(id) ON DELETE CASCADE ON UPDATE CASCADE'],
  ['attachments', 'ALTER TABLE attachments ADD CONSTRAINT FK_attachments_uploader FOREIGN KEY (uploaderId) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE'],
  ['attachments', 'ALTER TABLE attachments ADD CONSTRAINT FK_attachments_thread FOREIGN KEY (threadId) REFERENCES threads(id) ON DELETE SET NULL ON UPDATE CASCADE'],
  ['email_tokens', 'ALTER TABLE email_tokens ADD CONSTRAINT FK_email_tokens_user FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE'],
  ['site_settings', 'ALTER TABLE site_settings ADD CONSTRAINT FK_site_settings_actor FOREIGN KEY (updatedById) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE'],
];

export class AddIntegrityAndSecurity1760000001000 implements MigrationInterface {
  name = 'AddIntegrityAndSecurity1760000001000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Normalize nullable legacy references before adding constraints. Required references are
    // deliberately left untouched so a migration never silently deletes historical records.
    await queryRunner.query('UPDATE boards child LEFT JOIN boards parent ON parent.id = child.parentId SET child.parentId = NULL WHERE child.parentId IS NOT NULL AND parent.id IS NULL');
    await queryRunner.query('UPDATE threads t LEFT JOIN devices d ON d.id = t.deviceId SET t.deviceId = NULL WHERE t.deviceId IS NOT NULL AND d.id IS NULL');
    await queryRunner.query('UPDATE threads t LEFT JOIN software s ON s.id = t.softwareId SET t.softwareId = NULL WHERE t.softwareId IS NOT NULL AND s.id IS NULL');
    await queryRunner.query('UPDATE posts p LEFT JOIN posts q ON q.id = p.replyToPostId AND q.threadId = p.threadId SET p.replyToPostId = NULL WHERE p.replyToPostId IS NOT NULL AND q.id IS NULL');
    await queryRunner.query('UPDATE reports r LEFT JOIN users u ON u.id = r.handledById SET r.handledById = NULL WHERE r.handledById IS NOT NULL AND u.id IS NULL');
    await queryRunner.query('UPDATE audit_logs a LEFT JOIN users u ON u.id = a.actorId SET a.actorId = NULL WHERE a.actorId IS NOT NULL AND u.id IS NULL');
    await queryRunner.query('UPDATE attachments a LEFT JOIN threads t ON t.id = a.threadId SET a.threadId = NULL WHERE a.threadId IS NOT NULL AND t.id IS NULL');
    await queryRunner.query('UPDATE site_settings s LEFT JOIN users u ON u.id = s.updatedById SET s.updatedById = NULL WHERE s.updatedById IS NOT NULL AND u.id IS NULL');

    // Check the full set first: a failed preflight must not leave a half-applied MySQL DDL migration.
    for (const [table, sql] of constraints) {
      const reference = /FOREIGN KEY \(([^)]+)\) REFERENCES (\w+)\(([^)]+)\)/.exec(sql);
      if (!reference) continue;
      const [, column, parent, parentColumn] = reference;
      const orphan = await queryRunner.query(`SELECT COUNT(*) AS count FROM \`${table}\` child LEFT JOIN \`${parent}\` parent ON parent.\`${parentColumn}\` = child.\`${column}\` WHERE child.\`${column}\` IS NOT NULL AND parent.\`${parentColumn}\` IS NULL`);
      if (Number(orphan[0]?.count || 0) > 0) throw new Error(`Cannot add ${table}.${column} foreign key: ${orphan[0].count} orphan row(s) need explicit repair`);
    }
    await queryRunner.query('ALTER TABLE users ADD COLUMN sessionVersion int NOT NULL DEFAULT 0, ADD COLUMN storageQuotaBytes bigint NOT NULL DEFAULT 104857600, ADD COLUMN storageUsedBytes bigint NOT NULL DEFAULT 0');
    await queryRunner.query("ALTER TABLE attachments ADD COLUMN scanStatus enum('pending_scan','clean','rejected') NOT NULL DEFAULT 'pending_scan', ADD KEY IDX_attachments_sha256 (sha256)");
    await queryRunner.query("ALTER TABLE devices ADD COLUMN status enum('active','deleted') NOT NULL DEFAULT 'active'");
    await queryRunner.query('UPDATE users u LEFT JOIN (SELECT uploaderId, SUM(fileSize) AS usedBytes FROM attachments GROUP BY uploaderId) a ON a.uploaderId = u.id SET u.storageUsedBytes = COALESCE(a.usedBytes, 0)');
    for (const [, sql] of constraints) await queryRunner.query(sql);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const [table, sql] of [...constraints].reverse()) {
      const name = /ADD CONSTRAINT (\w+)/.exec(sql)?.[1];
      if (name) await queryRunner.query(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${name}\``);
    }
    await queryRunner.query('ALTER TABLE attachments DROP INDEX IDX_attachments_sha256, DROP COLUMN scanStatus');
    await queryRunner.query('ALTER TABLE devices DROP COLUMN status');
    await queryRunner.query('ALTER TABLE users DROP COLUMN storageUsedBytes, DROP COLUMN storageQuotaBytes, DROP COLUMN sessionVersion');
  }
}
