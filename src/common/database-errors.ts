import { BadRequestException, ConflictException } from '@nestjs/common';

export function rethrowReadableDatabaseError(error: unknown, conflictMessage: string): never {
  const driver = (error as { driverError?: { code?: unknown; errno?: unknown } })?.driverError;
  const code = driver?.code;
  const errno = Number(driver?.errno);
  if (code === 'ER_DUP_ENTRY' || errno === 1062) throw new ConflictException(conflictMessage);
  if (code === 'ER_DATA_TOO_LONG' || errno === 1406) throw new BadRequestException('One of the submitted fields exceeds its allowed length');
  throw error;
}
