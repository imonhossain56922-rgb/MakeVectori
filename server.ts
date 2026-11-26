import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { createApiApp } from './server/app.ts';

const PORT = 3000;

async function startServer() {
  const app = createApiApp();
  const httpServer = http.createServer(app);

  // Attach Vite middleware in dev, or serve static dist/ in production
  if (process.env.NODE_ENV !== 'production') {
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: hmrDisabled ? false : true,
        ws: hmrDisabled ? false : { server: httpServer },
        watch: hmrDisabled ? null : undefined,
      },
      appType: 'spa',
      plugins: hmrDisabled
        ? [
            {
              name: 'disable-vite-client-ws-when-hmr-off',
              enforce: 'post',
              transform(code, id) {
                if (id.endsWith('/dist/client/client.mjs') || id.includes('@vite/client')) {
                  return {
                    code: code.replace(
                      'transport.connect(createHMRHandler(handleMessage));',
                      '/* HMR disabled via DISABLE_HMR=true */'
                    ),
                    map: null,
                  };
                }
              },
            },
          ]
        : [],
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`MakeVectorizer server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
