import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Board, Post, Thread } from '../database/entities';
import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

export type BoardRole = 'guest' | 'user' | 'moderator' | 'admin';

const roleLevel: Record<BoardRole, number> = { guest: 0, user: 1, moderator: 2, admin: 3 };

export class BoardPolicy {
  static canReadBoard(board: Board, role: BoardRole): boolean {
    if (board.isHidden && role !== 'moderator' && role !== 'admin') return false;
    return board.minimumRole === null || roleLevel[role] >= board.minimumRole;
  }

  static canWriteBoard(board: Board, role: BoardRole): boolean {
    return this.canReadBoard(board, role) && (!board.isReadOnly || role === 'moderator' || role === 'admin');
  }

  static canReadThread(thread: Thread, board: Board, role: BoardRole): boolean {
    if (!this.canReadBoard(board, role)) return false;
    return thread.status === 'visible' || role === 'moderator' || role === 'admin';
  }

  static applyReadableBoardScope<T extends ObjectLiteral>(query: SelectQueryBuilder<T>, threadAlias: string, role: BoardRole, boardAlias = 'readableBoard'): SelectQueryBuilder<T> {
    const minimumRole = roleLevel[role];
    query.innerJoin(Board, boardAlias, `${boardAlias}.id = ${threadAlias}.boardId`)
      .andWhere(`(${boardAlias}.isHidden = false OR :${boardAlias}Role IN ('moderator', 'admin'))`, { [`${boardAlias}Role`]: role })
      .andWhere(`(${boardAlias}.minimumRole IS NULL OR ${boardAlias}.minimumRole <= :${boardAlias}MinimumRole)`, { [`${boardAlias}MinimumRole`]: minimumRole });
    return query;
  }

  static assertBoardReadable(board: Board | null, role: BoardRole): asserts board is Board {
    if (!board || !this.canReadBoard(board, role)) throw new NotFoundException('Board not found');
  }

  static assertBoardWritable(board: Board | null, role: BoardRole): asserts board is Board {
    this.assertBoardReadable(board, role);
    if (!this.canWriteBoard(board, role)) throw new ForbiddenException('This board is read-only');
  }

  static assertThreadReadable(thread: Thread | null, board: Board | null, role: BoardRole): asserts thread is Thread {
    if (!thread || !board || !this.canReadThread(thread, board, role)) throw new NotFoundException('Thread not found');
  }
}

export function wouldCreateBoardCycle(boardId: number, parentId: number | null, boards: Array<Pick<Board, 'id' | 'parentId'>>): boolean {
  const parentById = new Map(boards.map((board) => [board.id, board.parentId]));
  const visited = new Set<number>([boardId]);
  let current = parentId;
  while (current !== null) {
    if (visited.has(current)) return true;
    visited.add(current);
    current = parentById.get(current) ?? null;
  }
  return false;
}

export function presentPost(post: Post, role: BoardRole, author: any): any {
  if (post.status === 'visible' || role === 'moderator' || role === 'admin') return { ...post, author };
  return { id: post.id, threadId: post.threadId, floor: post.floor, status: post.status, createdAt: post.createdAt, content: null, author: null };
}
