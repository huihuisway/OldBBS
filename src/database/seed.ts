import 'reflect-metadata';
import * as crypto from 'node:crypto';
import { AppDataSource } from './data-source';
import { Board, Device, Post, Software, Thread, User } from './entities';

async function passwordHash(password: string) {
  const salt = crypto.randomBytes(16);
  const hash = await new Promise<Buffer>((resolve, reject) => crypto.scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));
  return `scrypt$32768$8$1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function seed() {
  if (!process.env.SEED_ADMIN_PASSWORD || process.env.SEED_ADMIN_PASSWORD.length < 12) throw new Error('Set SEED_ADMIN_PASSWORD to a unique password of at least 12 characters.');
  await AppDataSource.initialize();
  const boards = AppDataSource.getRepository(Board);
  const users = AppDataSource.getRepository(User);
  const admin = await users.findOneBy({ username: 'admin' });
  if (!admin) await users.save(users.create({ username: 'admin', nickname: '站务管理员', email: null, passwordHash: await passwordHash(process.env.SEED_ADMIN_PASSWORD), role: 'admin', status: 'active', signature: 'OldBBS 管理员', avatar: null, postCount: 0, lastOnlineAt: null, emailVerified: true, lowBandwidth: false, theme: 'classic', banReason: null }));
  const definitions: Array<[string, string, Array<[string, string]>]> = [
    ['site', '站务', [['announcements', '公告'], ['feedback', '建议与反馈']]],
    ['android', 'Android', [['android-general', 'Android 综合'], ['root-recovery', 'ROOT / Recovery'], ['rom-firmware', 'ROM / 固件'], ['android-apps', 'Android 软件']]],
    ['windows-phone', 'Windows Phone', []],
    ['symbian-s60', 'Symbian / S60', []],
    ['java-brew', 'Java / BREW', []],
    ['computers', '老电脑', [['windows', 'Windows'], ['linux-unix', 'Linux / Unix'], ['macintosh', 'Macintosh']]],
    ['device-collection', '设备收藏', []],
    ['software-games', '软件与游戏', []],
    ['repair-hardware', '维修与硬件', []],
    ['lounge', '闲聊', []],
  ];
  const roots = new Map<string, Board>();
  for (let order = 0; order < definitions.length; order++) {
    const [slug, name] = definitions[order];
    let root = await boards.findOneBy({ slug });
    if (!root) root = await boards.save(boards.create({ slug, name, description: '', parentId: null, sortOrder: order * 10, icon: null, theme: 'classic', isHidden: false, isReadOnly: false, minimumRole: null }));
    roots.set(slug, root);
    for (let childOrder = 0; childOrder < definitions[order][2].length; childOrder++) {
      const [childSlug, childName] = definitions[order][2][childOrder];
      if (!(await boards.existsBy({ slug: childSlug }))) await boards.save(boards.create({ slug: childSlug, name: childName, description: '', parentId: root.id, sortOrder: childOrder * 10, icon: null, theme: 'classic', isHidden: false, isReadOnly: false, minimumRole: null }));
    }
  }

  if (process.env.SEED_TEST_PASSWORD) {
    let testUser = await users.findOneBy({ username: 'oldphone' });
    if (!testUser) testUser = await users.save(users.create({ username: 'oldphone', nickname: '老手机玩家', email: null, passwordHash: await passwordHash(process.env.SEED_TEST_PASSWORD), role: 'user', status: 'active', signature: '设备还在，故事继续。', avatar: null, postCount: 0, lastOnlineAt: null, emailVerified: false, lowBandwidth: false, theme: 'classic', banReason: null }));
    const board = roots.get('android')!;
    if (!(await AppDataSource.getRepository(Thread).existsBy({ slug: 'welcome-to-oldbbs' }))) {
      const thread = await AppDataSource.getRepository(Thread).save({ boardId: board.id, authorId: testUser.id, title: '欢迎来到 OldBBS', slug: 'welcome-to-oldbbs', type: 'normal', status: 'visible', isPinned: true, isFeatured: false, isLocked: false, replyCount: 0, viewCount: 0, lastPostId: null, lastPostAt: new Date(), deviceId: null });
      const post = await AppDataSource.getRepository(Post).save({ threadId: thread.id, authorId: testUser.id, content: '这里是旧设备与旧软件爱好者的中文社区。欢迎分享你的设备、系统、软件和使用记忆。\n\n发帖无需 JavaScript；请在发布前检查链接和下载文件来源。', contentFormat: 'markdown', floor: 1, replyToPostId: null, status: 'visible', deletedAt: null });
      await AppDataSource.getRepository(Thread).update(thread.id, { lastPostId: post.id, lastPostAt: post.createdAt });
      await users.increment({ id: testUser.id }, 'postCount', 1);
    }
    const devices = AppDataSource.getRepository(Device);
    let device = await devices.findOneBy({ slug: 'sony-xperia-x10' });
    if (!device) device = await devices.save({ slug: 'sony-xperia-x10', brand: 'Sony Ericsson', model: 'Xperia X10', name: 'Sony Ericsson Xperia X10', releaseYear: 2010, platform: 'Android', osVersions: 'Android 1.6–2.3', cpu: 'Qualcomm Snapdragon QSD8250', ram: '384 MB', storage: '1 GB', screen: '4.0 inch 854×480', description: 'Sony Ericsson 的早期 Android 旗舰设备。', cover: null, authorId: testUser.id });
    const softwareRepo = AppDataSource.getRepository(Software);
    if (!(await softwareRepo.existsBy({ slug: 'qq-2012' }))) await softwareRepo.save({ slug: 'qq-2012', name: 'QQ 2012', platform: 'Android', version: '2012', developer: 'Tencent', description: '开发种子资料；下载地址需管理员确认并补充。', minimumOs: 'Android 2.1', architectures: 'ARMv6, ARMv7', downloadUrl: null, fileName: null, fileSize: null, sha256: null, status: 'published', authorId: testUser.id });
    console.log(`Development user seeded: oldphone (the password was supplied via SEED_TEST_PASSWORD). Sample device: ${device.name}.`);
  }
  console.log('OldBBS administrator and default board tree are ready.');
  await AppDataSource.destroy();
}

seed().catch(async (error) => { console.error(error); if (AppDataSource.isInitialized) await AppDataSource.destroy(); process.exit(1); });
