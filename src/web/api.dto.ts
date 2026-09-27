import { BadRequestException } from '@nestjs/common';

type ObjectBody = Record<string, unknown>;

function objectBody(value: unknown): ObjectBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Request body must be an object');
  return value as ObjectBody;
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new BadRequestException(`${field} must contain 1–${max} characters`);
  return value;
}

function optionalId(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException(`${field} must be a positive integer`);
  return id;
}

export class CreateThreadDto {
  boardId!: number;
  title!: string;
  content!: string;
  deviceId?: number;
  softwareId?: number;
  tags!: string[];

  static parse(value: unknown): CreateThreadDto {
    const body = objectBody(value);
    const dto = new CreateThreadDto();
    dto.boardId = optionalId(body.boardId, 'boardId') ?? 0;
    if (!dto.boardId) throw new BadRequestException('boardId must be a positive integer');
    dto.title = requiredText(body.title, 'title', 180);
    dto.content = requiredText(body.content, 'content', 100000);
    dto.deviceId = optionalId(body.deviceId, 'deviceId');
    dto.softwareId = optionalId(body.softwareId, 'softwareId');
    const tags = Array.isArray(body.tags) ? body.tags : typeof body.tags === 'string' ? body.tags.split(',') : [];
    if (tags.some((tag) => typeof tag !== 'string')) throw new BadRequestException('tags must be strings');
    dto.tags = (tags as string[]).map((tag) => tag.trim().slice(0, 48)).filter(Boolean).slice(0, 8);
    return dto;
  }
}

export class CreatePostDto {
  threadId!: number;
  content!: string;
  replyToPostId?: number;

  static parse(value: unknown): CreatePostDto {
    const body = objectBody(value);
    const dto = new CreatePostDto();
    dto.threadId = optionalId(body.threadId, 'threadId') ?? 0;
    if (!dto.threadId) throw new BadRequestException('threadId must be a positive integer');
    dto.content = requiredText(body.content, 'content', 100000);
    dto.replyToPostId = optionalId(body.replyToPostId, 'replyToPostId');
    return dto;
  }
}
