import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { CommunityService } from '../community/community.service';
import { CreatePostDto, CreateThreadDto } from './api.dto';

type ApiRequest = Request & { session: any };

@Controller('api/v1')
export class ApiController {
  constructor(private readonly auth: AuthService, private readonly community: CommunityService) {}

  @Get('boards') async boards(@Req() req: ApiRequest) { return { data: await this.community.listBoards(false, req.session?.user?.role || 'guest') }; }

  @Get('boards/:slug') async board(@Param('slug') slug: string, @Query('page') page: string, @Req() req: ApiRequest) {
    const result = await this.community.listBoardThreads(slug, this.positive(page), req.session?.user?.role || 'guest');
    return { data: result, meta: { page: result.page, page_size: 30, total: result.count } };
  }

  @Get('threads') async threads(@Query('board') board: string, @Query('page') page: string, @Req() req: ApiRequest) {
    const role = req.session?.user?.role || 'guest';
    const pageNumber = this.positive(page);
    if (board) {
      const result = await this.community.listBoardThreads(board, pageNumber, role);
      return { data: result.threads, board: result.board, meta: { page: result.page, page_size: 30, total: result.count } };
    }
    const result = await this.community.latest(pageNumber, role);
    return { data: result.threads, meta: { page: result.page, page_size: 20, total: result.count } };
  }

  @Get('threads/:id') async thread(@Param('id', ParseIntPipe) id: number, @Query('page') page: string, @Req() req: ApiRequest) {
    const result = await this.community.threadPage(id, this.positive(page), req.session?.user?.role || 'guest');
    return { data: result, meta: { page: result.page, page_size: 20, total: result.count } };
  }

  @Get('devices') async devices(@Query('page') page: string, @Query('q') query: string) { return this.community.listDevices(this.positive(page), query || ''); }
  @Get('devices/:slug') async device(@Param('slug') slug: string, @Req() req: ApiRequest) { return { data: await this.community.devicePage(slug, req.session?.user?.role || 'guest') }; }
  @Get('software') async software(@Query('page') page: string, @Query('q') query: string) { return this.community.listSoftware(this.positive(page), query || ''); }
  @Get('software/:slug') async softwareItem(@Param('slug') slug: string, @Req() req: ApiRequest) { return { data: await this.community.softwarePage(slug, req.session?.user?.role || 'guest') }; }
  @Get('search') async search(@Query('q') query: string, @Query('page') page: string, @Req() req: ApiRequest) {
    const data = await this.community.search(query || '', req.session?.user?.role || 'guest', this.positive(page));
    return { data, meta: { page: data.page, page_size: data.pageSize, counts: data.counts } };
  }

  @Post('threads') async createThread(@Body() raw: unknown, @Req() req: ApiRequest) {
    const user = this.auth.assertRole(req.session?.user, ['user', 'moderator', 'admin']);
    const body = CreateThreadDto.parse(raw);
    const thread = await this.community.createThread(user, body.boardId, body.title, body.content, body.deviceId, body.softwareId, body.tags);
    return { data: thread };
  }

  @Post('posts') async createPost(@Body() raw: unknown, @Req() req: ApiRequest) {
    const user = this.auth.assertRole(req.session?.user, ['user', 'moderator', 'admin']);
    const body = CreatePostDto.parse(raw);
    const post = await this.community.createPost(user, body.threadId, body.content, body.replyToPostId);
    return { data: post };
  }

  private positive(value: string | undefined): number {
    if (value === undefined) return 1;
    if (!/^[1-9]\d*$/.test(value)) throw new BadRequestException('page must be a positive integer');
    return Math.min(Number(value), 10000);
  }
}
