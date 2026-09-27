import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { AuthService } from '../auth/auth.service';
import { mysqlBooleanTerms } from '../common/fulltext';
import { Board, Device, Post, Software, Tag, Thread, ThreadTag, User } from '../database/entities';
import { BoardPolicy, BoardRole } from './board-policy';

@Injectable()
export class SearchService {
  private ngramParser?: Promise<boolean>;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @InjectRepository(Thread) private readonly threads: Repository<Thread>,
    @InjectRepository(Post) private readonly posts: Repository<Post>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Board) private readonly boards: Repository<Board>,
    @InjectRepository(Device) private readonly devices: Repository<Device>,
    @InjectRepository(Software) private readonly software: Repository<Software>,
    @InjectRepository(ThreadTag) private readonly threadTags: Repository<ThreadTag>,
    private readonly auth: AuthService,
  ) {}

  async search(query: string, userRole: BoardRole = 'guest', page = 1, pageSize = 25) {
    const q = query.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
    const safePage = Math.max(1, Math.min(10000, Math.trunc(page) || 1));
    const take = Math.max(1, Math.min(50, Math.trunc(pageSize) || 25));
    const empty = { query: q, threads: [], posts: [], users: [], devices: [], software: [], page: safePage, pageSize: take, counts: { threads: 0, posts: 0, users: 0, devices: 0, software: 0 } };
    if (Array.from(q).length < 2) return empty;

    const ngram = await this.hasNgramParser();
    const terms = mysqlBooleanTerms(q, ngram);
    if (!terms) return empty;
    const [threads, posts, users, devices, software] = await Promise.all([
      this.scopedTextSearch(this.threads.createQueryBuilder('t').where('t.status = :visible', { visible: 'visible' }), 't', userRole, 'MATCH(t.title) AGAINST (:term IN BOOLEAN MODE)', terms, safePage, take),
      this.scopedPostSearch(terms, userRole, safePage, take),
      this.users.createQueryBuilder('u').where('u.status = :active', { active: 'active' }).andWhere('MATCH(u.username, u.nickname) AGAINST (:term IN BOOLEAN MODE)', { term: terms })
        .orderBy('u.id', 'DESC').skip((safePage - 1) * take).take(take).getManyAndCount(),
      this.devices.createQueryBuilder('d').where('d.status = :active AND d.reviewStatus = :published', { active: 'active', published: 'published' }).andWhere('MATCH(d.name, d.brand, d.model) AGAINST (:term IN BOOLEAN MODE)', { term: terms })
        .orderBy('d.id', 'DESC').skip((safePage - 1) * take).take(take).getManyAndCount(),
      this.software.createQueryBuilder('s').where('s.status = :published', { published: 'published' }).andWhere('MATCH(s.name, s.platform, s.version, s.developer) AGAINST (:term IN BOOLEAN MODE)', { term: terms })
        .orderBy('s.id', 'DESC').skip((safePage - 1) * take).take(take).getManyAndCount(),
    ]);
    const [threadRows, threadCount] = threads;
    const [postRows, postCount] = posts;
    const threadResults = await this.enrichThreads(threadRows);
    const postAuthors = postRows.length ? await this.users.find({ where: { id: In([...new Set(postRows.map((post) => post.authorId))]) } }) : [];
    const authorById = new Map(postAuthors.map((user) => [user.id, this.auth.publicUser(user)]));
    return {
      query: q,
      threads: threadResults,
      posts: postRows.map((post) => ({ ...post, author: authorById.get(post.authorId) })),
      users: users[0].map((user) => this.auth.publicUser(user)),
      devices: devices[0],
      software: software[0],
      page: safePage,
      pageSize: take,
      counts: { threads: threadCount, posts: postCount, users: users[1], devices: devices[1], software: software[1] },
    };
  }

  private async scopedTextSearch(query: any, alias: string, role: BoardRole, condition: string, term: string, page: number, take: number) {
    BoardPolicy.applyReadableBoardScope(query, alias, role);
    return query.andWhere(condition, { term }).orderBy(`${alias}.lastPostAt`, 'DESC').addOrderBy(`${alias}.id`, 'DESC')
      .skip((page - 1) * take).take(take).getManyAndCount();
  }

  private async scopedPostSearch(term: string, role: BoardRole, page: number, take: number) {
    const query = this.posts.createQueryBuilder('p').innerJoin(Thread, 't', 't.id = p.threadId AND t.status = :threadStatus', { threadStatus: 'visible' })
      .where('p.status = :postStatus', { postStatus: 'visible' }).andWhere('MATCH(p.content) AGAINST (:term IN BOOLEAN MODE)', { term });
    BoardPolicy.applyReadableBoardScope(query, 't', role);
    return query.orderBy('p.createdAt', 'DESC').addOrderBy('p.id', 'DESC').skip((page - 1) * take).take(take).getManyAndCount();
  }

  private async hasNgramParser(): Promise<boolean> {
    this.ngramParser ??= this.db.query("SELECT PLUGIN_STATUS FROM INFORMATION_SCHEMA.PLUGINS WHERE PLUGIN_NAME = 'ngram'")
      .then((rows: Array<{ PLUGIN_STATUS?: string }>) => rows.some((row) => row.PLUGIN_STATUS === 'ACTIVE'))
      .catch(() => false);
    return this.ngramParser;
  }

  private async enrichThreads(threads: Thread[]) {
    if (!threads.length) return [];
    const ids = [...new Set(threads.map((thread) => thread.authorId))];
    const boardIds = [...new Set(threads.map((thread) => thread.boardId))];
    const [authors, boards] = await Promise.all([this.users.find({ where: { id: In(ids) } }), this.boards.find({ where: { id: In(boardIds) } })]);
    const authorById = new Map(authors.map((author) => [author.id, this.auth.publicUser(author)]));
    const boardById = new Map(boards.map((board) => [board.id, board]));
    const tags = await this.threadTags.createQueryBuilder('tt').innerJoin(Tag, 'tag', 'tag.id = tt.tagId')
      .select('tt.threadId', 'threadId').addSelect('tag.id', 'id').addSelect('tag.name', 'name').addSelect('tag.slug', 'slug')
      .where('tt.threadId IN (:...ids)', { ids: threads.map((thread) => thread.id) }).getRawMany<{ threadId: number; id: number; name: string; slug: string }>();
    return threads.map((thread) => ({ ...thread, author: authorById.get(thread.authorId), board: boardById.get(thread.boardId), tags: tags.filter((tag) => Number(tag.threadId) === thread.id) }));
  }
}
