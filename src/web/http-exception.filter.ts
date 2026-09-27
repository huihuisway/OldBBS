import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { safeLocalNext } from '../common/redirect';

@Catch()
export class HtmlExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const detail = exception instanceof HttpException ? exception.getResponse() : 'The request could not be completed.';
    const message = typeof detail === 'string' ? detail : (detail as any)?.message;
    const text = Array.isArray(message) ? message.join(' ') : message;
    if (request.path.startsWith('/api/')) return response.status(status).json({ statusCode: status, message: text || 'Request failed' });
    return response.status(status).render('errors/error.njk', { status, message: text || 'The request could not be completed.', back: safeLocalNext(request.get('referer') || '/') });
  }
}
