import type { IncomingMessage, ServerResponse } from 'http';
import { createApiApp } from '../server/app.ts';

export const config = {
  api: {
    bodyParser: false,
  },
};

const app = createApiApp();

export default function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.url && req.url.startsWith('/api/index')) {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      const apiPath = parsed.searchParams.get('__api_path');
      if (apiPath !== null) {
        parsed.searchParams.delete('__api_path');
        const qs = parsed.searchParams.toString();
        const normalizedPath = apiPath.replace(/^\/+/, '');
        req.url = `/api/${normalizedPath}${qs ? `?${qs}` : ''}`;
      }
    } catch {
      // keep original req.url if URL parsing fails
    }
  }
  return app(req as unknown as Parameters<typeof app>[0], res as unknown as Parameters<typeof app>[1]);
}
