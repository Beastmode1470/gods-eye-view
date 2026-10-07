import { resolveHormuzUrl } from './hormuz-proxy.mjs';

/** Resolve opt-in recording without reading or exposing private environment values. */
export function resolveRecordingConfig(env = process.env) {
  const source = String(env.AIS_RECORDING_SOURCE || '')
    .trim()
    .toLowerCase();
  if (!['', 'hormuz', 'aisstream'].includes(source))
    throw new Error('AIS_RECORDING_SOURCE must be blank, hormuz, or aisstream');
  const external = resolveHormuzUrl(env.HORMUZ_API_URL);
  if (external && source)
    throw new Error(
      'HORMUZ_API_URL and AIS_RECORDING_SOURCE are mutually exclusive',
    );
  return {
    source: external ? 'hormuz' : source,
    external,
    enabled: Boolean(source || external),
    dbPath: String(
      env.AIS_RECORDING_DB || '.gev-cache/ais-history.sqlite',
    ).trim(),
  };
}

/** Deny recording storage through normal static paths and Vite /@fs paths. */
export function isRecordingStoragePath(url) {
  let path;
  try {
    path = decodeURIComponent(
      new URL(url, 'http://localhost').pathname,
    ).replaceAll('\\', '/');
  } catch {
    return true;
  }
  return (
    /(?:^|\/)\.gev-cache(?:\/|$)/i.test(path) ||
    /\.(?:sqlite(?:3)?|db)(?:-(?:wal|shm|journal))?(?:\/|$)/i.test(path)
  );
}

/** Install before Vite static middleware in dev and preview, even in live mode. */
export function recordingPrivacyPlugin(enabled = false) {
  const install = (server) => {
    server.middlewares.use((req, res, next) => {
      if (isRecordingStoragePath(req.url)) {
        res.statusCode = 403;
        res.end('Recording storage is not browser content');
        return;
      }
      if (
        enabled &&
        /^\/(?:api\/(?:openai|realtime)(?:\/|$)|mcp(?:\/|$))/.test(req.url)
      ) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error:
              'Voice/AI uploads and MCP disabled in local AIS recording mode',
          }),
        );
        return;
      }
      next();
    });
  };
  return {
    name: 'recording-storage-privacy',
    config(config) {
      const deny = config.server?.fs?.deny || [];
      return {
        server: {
          fs: {
            deny: [
              ...deny,
              '**/.gev-cache/**',
              '**/*.sqlite',
              '**/*.sqlite-*',
              '**/*.sqlite3',
              '**/*.db',
              '**/*.db-*',
            ],
          },
        },
      };
    },
    configResolved(config) {
      if (!enabled) return;
      for (const options of [config.server, config.preview]) {
        if (!['localhost', '127.0.0.1', '::1'].includes(options.host))
          throw new Error('AIS recording requires a loopback server binding');
      }
    },
    configureServer: install,
    configurePreviewServer: install,
  };
}
