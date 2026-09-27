import { MigrationInterface, QueryRunner } from 'typeorm';

export class BetaHardening1760000002000 implements MigrationInterface {
  name = 'BetaHardening1760000002000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const pluginRows = await queryRunner.query("SELECT PLUGIN_STATUS FROM INFORMATION_SCHEMA.PLUGINS WHERE PLUGIN_NAME = 'ngram'") as Array<{ PLUGIN_STATUS?: string }>;
    const ngram = pluginRows.some((row) => row.PLUGIN_STATUS === 'ACTIVE');
    const parser = ngram ? ' WITH PARSER ngram' : '';
    await queryRunner.query(`ALTER TABLE threads DROP INDEX FT_threads_title, ADD FULLTEXT KEY FT_threads_title (title)${parser}`);
    await queryRunner.query(`ALTER TABLE posts DROP INDEX FT_posts_content, ADD FULLTEXT KEY FT_posts_content (content)${parser}`);
    await queryRunner.query(`ALTER TABLE devices DROP INDEX FT_devices_name, ADD FULLTEXT KEY FT_devices_search (name, brand, model)${parser}`);
    await queryRunner.query(`ALTER TABLE software DROP INDEX FT_software_name, ADD FULLTEXT KEY FT_software_search (name, platform, version, developer)${parser}`);
    await queryRunner.query(`ALTER TABLE users ADD FULLTEXT KEY FT_users_search (username, nickname)${parser}`);

    await queryRunner.query("ALTER TABLE devices ADD COLUMN reviewStatus enum('draft','pending_review','published','rejected') NOT NULL DEFAULT 'published' AFTER status");
    await queryRunner.query("ALTER TABLE software MODIFY status enum('pending','pending_review','published','rejected') NOT NULL DEFAULT 'pending_review'");
    await queryRunner.query("UPDATE software SET status = 'pending_review' WHERE status = 'pending'");
    await queryRunner.query("ALTER TABLE software MODIFY status enum('draft','pending_review','published','rejected') NOT NULL DEFAULT 'pending_review'");
    await queryRunner.query("ALTER TABLE compatibility_reports ADD COLUMN status enum('pending','approved','rejected','deleted') NOT NULL DEFAULT 'pending' AFTER result");
    await queryRunner.query("UPDATE compatibility_reports SET status = 'approved'");
    await queryRunner.query('ALTER TABLE posts ADD COLUMN renderedHtml longtext NULL AFTER content, ADD COLUMN renderVersion int NOT NULL DEFAULT 0 AFTER renderedHtml');
    await queryRunner.query("ALTER TABLE attachments MODIFY scanStatus enum('pending_scan','clean','rejected','scan_failed') NOT NULL DEFAULT 'pending_scan'");
    await queryRunner.query("UPDATE attachments SET scanStatus = 'scan_failed' WHERE scanStatus = 'pending_scan'");
    await queryRunner.query("UPDATE users u LEFT JOIN (SELECT p.authorId, COUNT(*) AS visiblePosts FROM posts p INNER JOIN threads t ON t.id = p.threadId AND t.status = 'visible' WHERE p.status = 'visible' GROUP BY p.authorId) counts ON counts.authorId = u.id SET u.postCount = COALESCE(counts.visiblePosts, 0)");
    await queryRunner.query("UPDATE threads t SET replyCount = (SELECT COUNT(*) FROM posts p WHERE p.threadId = t.id AND p.status = 'visible' AND p.floor > 1), lastPostId = (SELECT p.id FROM posts p WHERE p.threadId = t.id AND p.status = 'visible' ORDER BY p.createdAt DESC, p.id DESC LIMIT 1), lastPostAt = (SELECT p.createdAt FROM posts p WHERE p.threadId = t.id AND p.status = 'visible' ORDER BY p.createdAt DESC, p.id DESC LIMIT 1)");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("UPDATE attachments SET scanStatus = 'pending_scan' WHERE scanStatus = 'scan_failed'");
    await queryRunner.query("ALTER TABLE attachments MODIFY scanStatus enum('pending_scan','clean','rejected') NOT NULL DEFAULT 'pending_scan'");
    await queryRunner.query('ALTER TABLE posts DROP COLUMN renderVersion, DROP COLUMN renderedHtml');
    await queryRunner.query('ALTER TABLE compatibility_reports DROP COLUMN status');
    await queryRunner.query("ALTER TABLE software MODIFY status enum('pending','draft','pending_review','published','rejected') NOT NULL DEFAULT 'pending'");
    await queryRunner.query("UPDATE software SET status = 'pending' WHERE status IN ('draft','pending_review')");
    await queryRunner.query("ALTER TABLE software MODIFY status enum('pending','published','rejected') NOT NULL DEFAULT 'pending'");
    await queryRunner.query('ALTER TABLE devices DROP COLUMN reviewStatus');
    await queryRunner.query('ALTER TABLE users DROP INDEX FT_users_search');
    await queryRunner.query('ALTER TABLE software DROP INDEX FT_software_search, ADD FULLTEXT KEY FT_software_name (name)');
    await queryRunner.query('ALTER TABLE devices DROP INDEX FT_devices_search, ADD FULLTEXT KEY FT_devices_name (name, brand, model)');
    await queryRunner.query('ALTER TABLE posts DROP INDEX FT_posts_content, ADD FULLTEXT KEY FT_posts_content (content)');
    await queryRunner.query('ALTER TABLE threads DROP INDEX FT_threads_title, ADD FULLTEXT KEY FT_threads_title (title)');
  }
}
