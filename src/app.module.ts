import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from './auth/auth.service';
import { CommunityService } from './community/community.service';
import { SearchService } from './community/search.service';
import { MessagingService } from './community/messaging.service';
import { CatalogService } from './community/catalog.service';
import { ModerationService } from './community/moderation.service';
import { TerminalAccountService } from './community/terminal-account.service';
import * as entities from './database/entities';
import { AppDataSource } from './database/data-source';
import { WebController } from './web/web.controller';
import { ApiController } from './web/api.controller';
import { TerminalController } from './terminal/terminal.controller';
import { ATTACHMENT_SCANNER, ClamAvAttachmentScanner, DevelopmentAttachmentScanner, DisabledAttachmentScanner, StorageService } from './storage/storage.service';
import { config } from './config';
import { RateLimitService } from './common/rate-limit.service';

@Module({
  imports: [TypeOrmModule.forRoot({ ...AppDataSource.options }), TypeOrmModule.forFeature(Object.values(entities))],
  controllers: [WebController, ApiController],
  providers: [AuthService, SearchService, MessagingService, CatalogService, ModerationService, TerminalAccountService, CommunityService, StorageService, TerminalController,
    RateLimitService,
    { provide: ATTACHMENT_SCANNER, useFactory: () => config.attachmentScanner === 'clamav' ? new ClamAvAttachmentScanner() : config.attachmentScanner === 'development' ? new DevelopmentAttachmentScanner() : new DisabledAttachmentScanner() }],
})
export class AppModule {}
