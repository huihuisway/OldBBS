import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PublicUser } from '../auth/auth.service';
import { Board, Post, Thread, User } from '../database/entities';
import { BoardPolicy } from './board-policy';

export class ModerationPolicy {
  static assertModerator(actor: PublicUser): void {
    if (actor.status !== 'active' || !['moderator', 'admin'].includes(actor.role)) {
      throw new ForbiddenException('Moderator role is required');
    }
  }

  static assertCanModerateUser(actor: PublicUser, target: User): void {
    this.assertModerator(actor);
    if (actor.id === target.id) throw new ForbiddenException('You cannot moderate your own account');
    if (actor.role === 'moderator' && target.role !== 'user') {
      throw new ForbiddenException('Moderators may only moderate regular user accounts');
    }
  }

  static assertCanManageBoard(actor: PublicUser, board: Board | null): asserts board is Board {
    this.assertModerator(actor);
    if (!board) throw new NotFoundException('Board not found');
    if (actor.role === 'moderator' && !BoardPolicy.canReadBoard(board, 'moderator')) {
      throw new NotFoundException('Board not found');
    }
  }

  static assertCanModerateThread(actor: PublicUser, thread: Thread | null, board: Board | null): asserts thread is Thread {
    this.assertModerator(actor);
    if (!thread || !board) throw new NotFoundException('Thread not found');
    this.assertCanManageBoard(actor, board);
  }

  static assertCanModeratePost(actor: PublicUser, post: Post | null, thread: Thread | null, board: Board | null): asserts post is Post {
    this.assertModerator(actor);
    if (!post || !thread || !board) throw new NotFoundException('Post not found');
    this.assertCanManageBoard(actor, board);
  }
}
