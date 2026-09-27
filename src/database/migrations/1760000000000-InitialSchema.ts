import { MigrationInterface, QueryRunner } from 'typeorm';

const statements = [
  `CREATE TABLE users (
    id int NOT NULL AUTO_INCREMENT, username varchar(32) NOT NULL, nickname varchar(64) NOT NULL, email varchar(190) NULL,
    passwordHash varchar(255) NOT NULL, signature text NULL, avatar varchar(500) NULL,
    role enum('user','moderator','admin') NOT NULL DEFAULT 'user', status enum('active','banned','pending') NOT NULL DEFAULT 'active',
    banReason text NULL, postCount int NOT NULL DEFAULT 0, lastOnlineAt datetime NULL, emailVerified tinyint NOT NULL DEFAULT 0,
    lowBandwidth tinyint NOT NULL DEFAULT 0, theme varchar(16) NOT NULL DEFAULT 'classic',
    createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), updatedAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id), UNIQUE KEY IDX_users_username (username), UNIQUE KEY IDX_users_email (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE boards (
    id int NOT NULL AUTO_INCREMENT, slug varchar(80) NOT NULL, name varchar(120) NOT NULL, description text NOT NULL,
    parentId int NULL, sortOrder int NOT NULL DEFAULT 0, icon varchar(255) NULL, theme varchar(32) NOT NULL DEFAULT 'classic',
    isHidden tinyint NOT NULL DEFAULT 0, isReadOnly tinyint NOT NULL DEFAULT 0, minimumRole int NULL,
    createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), updatedAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id), UNIQUE KEY IDX_boards_slug (slug), KEY IDX_boards_parent_order (parentId, sortOrder)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE devices (
    id int NOT NULL AUTO_INCREMENT, slug varchar(180) NOT NULL, brand varchar(100) NOT NULL, model varchar(120) NOT NULL, name varchar(180) NOT NULL,
    releaseYear smallint NULL, platform varchar(80) NOT NULL, osVersions text NULL, cpu varchar(160) NULL, ram varchar(80) NULL,
    storage varchar(100) NULL, screen varchar(120) NULL, description text NOT NULL, cover varchar(500) NULL, authorId int NOT NULL,
    createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), updatedAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id), UNIQUE KEY IDX_devices_slug (slug), KEY IDX_devices_author (authorId), FULLTEXT KEY FT_devices_name (name, brand, model)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE software (
    id int NOT NULL AUTO_INCREMENT, slug varchar(180) NOT NULL, name varchar(180) NOT NULL, platform varchar(80) NOT NULL, version varchar(80) NOT NULL,
    developer varchar(180) NULL, description text NOT NULL, minimumOs varchar(100) NULL, architectures text NULL, downloadUrl varchar(1000) NULL,
    fileName varchar(255) NULL, fileSize bigint NULL, sha256 varchar(64) NULL, status enum('pending','published','rejected') NOT NULL DEFAULT 'pending',
    authorId int NOT NULL, createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), updatedAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id), UNIQUE KEY IDX_software_slug (slug), KEY IDX_software_status_date (status, createdAt), KEY IDX_software_author (authorId), FULLTEXT KEY FT_software_name (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE threads (
    id int NOT NULL AUTO_INCREMENT, boardId int NOT NULL, authorId int NOT NULL, deviceId int NULL, softwareId int NULL, title varchar(180) NOT NULL, slug varchar(220) NOT NULL,
    type varchar(24) NOT NULL DEFAULT 'normal', status enum('visible','deleted','hidden') NOT NULL DEFAULT 'visible', isPinned tinyint NOT NULL DEFAULT 0,
    isFeatured tinyint NOT NULL DEFAULT 0, isLocked tinyint NOT NULL DEFAULT 0, replyCount int NOT NULL DEFAULT 0, viewCount int NOT NULL DEFAULT 0,
    lastPostId int NULL, lastPostAt datetime NULL, createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), updatedAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id), KEY IDX_threads_board_last (boardId, lastPostAt), KEY IDX_threads_slug (slug), KEY IDX_threads_author (authorId),
    KEY IDX_threads_device (deviceId), KEY IDX_threads_software (softwareId), KEY IDX_threads_status_date (status, createdAt), FULLTEXT KEY FT_threads_title (title)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE posts (
    id int NOT NULL AUTO_INCREMENT, threadId int NOT NULL, authorId int NOT NULL, content longtext NOT NULL, contentFormat varchar(16) NOT NULL DEFAULT 'markdown',
    floor int NOT NULL, replyToPostId int NULL, status enum('visible','deleted','hidden') NOT NULL DEFAULT 'visible',
    createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), updatedAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), deletedAt datetime NULL,
    PRIMARY KEY (id), UNIQUE KEY IDX_posts_thread_floor (threadId, floor), KEY IDX_posts_author_date (authorId, createdAt), KEY IDX_posts_thread_date (threadId, createdAt),
    FULLTEXT KEY FT_posts_content (content)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE compatibility_reports (
    id int NOT NULL AUTO_INCREMENT, deviceId int NOT NULL, softwareId int NOT NULL, authorId int NOT NULL, systemVersion varchar(100) NOT NULL,
    result enum('working','partial','broken','unknown') NOT NULL, notes text NOT NULL, createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id), KEY IDX_compat_device_software (deviceId, softwareId), KEY IDX_compat_author (authorId, createdAt)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE bookmarks (id int NOT NULL AUTO_INCREMENT, userId int NOT NULL, threadId int NOT NULL, createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id), UNIQUE KEY IDX_bookmarks_user_thread (userId, threadId)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE follows (id int NOT NULL AUTO_INCREMENT, userId int NOT NULL, targetUserId int NOT NULL, createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id), UNIQUE KEY IDX_follows_pair (userId, targetUserId)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE notifications (id int NOT NULL AUTO_INCREMENT, userId int NOT NULL, type varchar(40) NOT NULL, title varchar(255) NOT NULL, body text NOT NULL, url varchar(500) NULL, isRead tinyint NOT NULL DEFAULT 0, createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id), KEY IDX_notifications_user_read_date (userId, isRead, createdAt)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE conversations (id int NOT NULL AUTO_INCREMENT, userAId int NOT NULL, userBId int NOT NULL, hiddenByA tinyint NOT NULL DEFAULT 0, hiddenByB tinyint NOT NULL DEFAULT 0, lastMessageAt datetime NULL, createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id), UNIQUE KEY IDX_conversation_pair (userAId, userBId)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE messages (id int NOT NULL AUTO_INCREMENT, conversationId int NOT NULL, senderId int NOT NULL, body text NOT NULL, isRead tinyint NOT NULL DEFAULT 0, hiddenAt datetime NULL, createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id), KEY IDX_messages_conversation_date (conversationId, createdAt), KEY IDX_messages_sender (senderId)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE reports (id int NOT NULL AUTO_INCREMENT, reporterId int NOT NULL, targetType varchar(32) NOT NULL, targetId int NOT NULL, reason text NOT NULL, status enum('open','resolved','dismissed') NOT NULL DEFAULT 'open', handledById int NULL, createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), updatedAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), PRIMARY KEY (id), KEY IDX_reports_status_date (status, createdAt), KEY IDX_reports_target (targetType, targetId)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE audit_logs (id int NOT NULL AUTO_INCREMENT, actorId int NULL, action varchar(100) NOT NULL, targetType varchar(40) NOT NULL, targetId int NULL, metadata json NULL, ip varchar(45) NULL, createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id), KEY IDX_audit_target_date (targetType, targetId, createdAt), KEY IDX_audit_actor_date (actorId, createdAt)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE terminal_access_keys (id int NOT NULL AUTO_INCREMENT, userId int NOT NULL, name varchar(80) NOT NULL, keyHash varchar(64) NOT NULL, scope varchar(16) NOT NULL DEFAULT 'terminal', lastUsedAt datetime NULL, lastIp varchar(45) NULL, revokedAt datetime NULL, createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id), UNIQUE KEY IDX_terminal_key_hash (keyHash), KEY IDX_terminal_keys_user (userId, revokedAt)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE ssh_keys (id int NOT NULL AUTO_INCREMENT, userId int NOT NULL, name varchar(80) NOT NULL, publicKey text NOT NULL, fingerprint varchar(128) NOT NULL, lastUsedAt datetime NULL, lastIp varchar(45) NULL, revokedAt datetime NULL, createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id), UNIQUE KEY IDX_ssh_fingerprint (fingerprint), KEY IDX_ssh_keys_user (userId, revokedAt)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE login_attempts (id int NOT NULL AUTO_INCREMENT, identity varchar(190) NOT NULL, ip varchar(45) NOT NULL, succeeded tinyint NOT NULL, createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id), KEY IDX_login_identity_date (identity, createdAt), KEY IDX_login_ip_date (ip, createdAt)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE tags (id int NOT NULL AUTO_INCREMENT, name varchar(48) NOT NULL, slug varchar(64) NOT NULL, createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id), UNIQUE KEY IDX_tags_slug (slug)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE thread_tags (id int NOT NULL AUTO_INCREMENT, threadId int NOT NULL, tagId int NOT NULL, PRIMARY KEY (id), UNIQUE KEY IDX_thread_tags_pair (threadId, tagId), KEY IDX_thread_tags_tag (tagId)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE attachments (id int NOT NULL AUTO_INCREMENT, storageKey varchar(120) NOT NULL, originalName varchar(255) NOT NULL, mimeType varchar(120) NOT NULL, fileSize int NOT NULL, sha256 varchar(64) NOT NULL, uploaderId int NOT NULL, threadId int NULL, createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id), UNIQUE KEY IDX_attachments_storage_key (storageKey), KEY IDX_attachments_uploader_date (uploaderId, createdAt), KEY IDX_attachments_thread (threadId)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE email_tokens (id int NOT NULL AUTO_INCREMENT, userId int NOT NULL, type enum('verify_email','reset_password') NOT NULL, tokenHash varchar(64) NOT NULL, expiresAt datetime NOT NULL, usedAt datetime NULL, createdAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id), UNIQUE KEY IDX_email_tokens_hash (tokenHash), KEY IDX_email_tokens_user_type_expiry (userId, type, expiresAt)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE site_settings (\`key\` varchar(100) NOT NULL, value text NOT NULL, updatedById int NULL, updatedAt datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), PRIMARY KEY (\`key\`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

export class InitialSchema1760000000000 implements MigrationInterface {
  name = 'InitialSchema1760000000000';
  async up(queryRunner: QueryRunner): Promise<void> { for (const statement of statements) await queryRunner.query(statement); }
  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['site_settings', 'email_tokens', 'attachments', 'thread_tags', 'tags', 'login_attempts', 'ssh_keys', 'terminal_access_keys', 'audit_logs', 'reports', 'messages', 'conversations', 'notifications', 'follows', 'bookmarks', 'compatibility_reports', 'posts', 'threads', 'software', 'devices', 'boards', 'users']) await queryRunner.query(`DROP TABLE IF EXISTS ${table}`);
  }
}
