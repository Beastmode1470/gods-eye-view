import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DB = path.join(ROOT, '.gev-cache', 'ais-history.sqlite');
const HELP = `Usage: node scripts/collect-ais.mjs --source hormuz|aisstream [options]

Collect public Hormuz snapshots or your own AISStream subscription into a local SQLite database.

Options:
  --source SOURCE      hormuz or aisstream (defaults to AIS_RECORDING_SOURCE)
  --db PATH            SQLite database path (default: .gev-cache/ais-history.sqlite)
  --interval SECONDS   Poll cadence (Hormuz >=600, AISStream >=10; source defaults apply)
  --port PORT          Loopback API port (default: 8808)
  --once               Collect one Hormuz snapshot and exit
  --help               Show this help

Reads only this checkout's .env and .env.local. Existing process environment values win.
`;

function loadLocalEnvironment(environment = process.env) {
  const fromFiles = {};
  for (const name of ['.env', '.env.local']) {
    const filename = path.join(ROOT, name);
    let text;
    try {
      text = readFileSync(filename, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new Error(`Could not read ${name}: ${error.message}`);
    }
    let parsed;
    try {
      parsed = parseEnv(text);
    } catch {
      throw new Error(`Could not parse ${name}`);
    }
    Object.assign(fromFiles, parsed);
  }
  for (const [key, value] of Object.entries(fromFiles)) {
    if (environment[key] === undefined) environment[key] = value;
  }
  return environment;
}

function parseArgs(argv, environment) {
  const options = {
    source: environment.AIS_RECORDING_SOURCE || '',
    dbPath: environment.AIS_RECORDING_DB || DEFAULT_DB,
    interval: environment.AIS_RECORDING_INTERVAL_SECONDS || '',
    port: 8808,
    once: false,
    help: false,
  };
  const seen = new Set();
  const values = new Map([
    ['--source', 'source'],
    ['--db', 'dbPath'],
    ['--interval', 'interval'],
    ['--port', 'port'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') {
      if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
      seen.add(flag);
      options.help = true;
      continue;
    }
    if (flag === '--once') {
      if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
      seen.add(flag);
      options.once = true;
      continue;
    }
    const key = values.get(flag);
    if (!key) throw new Error(`Unknown option: ${flag}`);
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    const value = argv[index + 1];
    if (!value || value.startsWith('--'))
      throw new Error(`${flag} requires a value`);
    options[key] = value;
    index += 1;
  }
  if (options.help) return options;
  options.source = String(options.source).trim().toLowerCase();
  if (!['hormuz', 'aisstream'].includes(options.source)) {
    throw new Error(
      '--source hormuz|aisstream is required (or set AIS_RECORDING_SOURCE)',
    );
  }
  if (options.once && options.source !== 'hormuz') {
    throw new Error('--once is supported only for --source hormuz');
  }
  if (!String(options.dbPath).trim())
    throw new Error('--db path must not be empty');
  options.dbPath = path.resolve(process.cwd(), String(options.dbPath));
  const minInterval = options.source === 'hormuz' ? 600 : 10;
  if (options.interval !== '') {
    if (
      !/^\d+$/.test(String(options.interval)) ||
      Number(options.interval) < minInterval ||
      Number(options.interval) > 86_400
    ) {
      throw new Error(
        `--interval must be an integer from ${minInterval} to 86400 for ${options.source}`,
      );
    }
    options.interval = String(Number(options.interval));
  } else {
    options.interval = options.source === 'hormuz' ? '900' : '60';
  }
  if (
    !/^\d+$/.test(String(options.port)) ||
    Number(options.port) < 1 ||
    Number(options.port) > 65_535
  ) {
    throw new Error('--port must be an integer from 1 to 65535');
  }
  options.port = Number(options.port);
  return options;
}

function printSummary(controller) {
  const stats = controller.store.stats().collection;
  console.log(
    JSON.stringify({
      source: controller.source,
      status: controller.health.status,
      error: controller.health.error,
      polls: stats.polls,
      successfulPolls: stats.successful_polls,
      failedPolls: stats.failed_polls,
      positions: stats.positions,
      firstObservedAt: stats.first_observed_at,
      lastObservedAt: stats.last_observed_at,
    }),
  );
}

export async function runCollector(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const env = loadLocalEnvironment(environment);
  const options = parseArgs(argv, env);
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  const { createRecordingController } =
    await import('../server/providers/vessels/recording.js');
  const effectiveEnv = {
    ...env,
    AIS_RECORDING_SOURCE: options.source,
    AIS_RECORDING_DB: options.dbPath,
    AIS_RECORDING_INTERVAL_SECONDS: options.interval,
  };
  const controller = createRecordingController({
    source: options.source,
    dbPath: options.dbPath,
    env: effectiveEnv,
  });
  if (options.once) {
    try {
      await controller.recordPoll();
      printSummary(controller);
      return controller.health.status === 'recorded' ? 0 : 1;
    } finally {
      await controller.stop();
    }
  }

  const server = createServer((req, res) => {
    controller.handleRequest(req, res, () => {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'Not found' }));
    });
  });
  server.on('error', (error) => {
    console.error(`AIS recorder HTTP server failed: ${error.message}`);
    process.exitCode = 1;
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', resolve);
  }).catch(async (error) => {
    await controller.stop();
    throw error;
  });
  controller.start();
  console.log(
    `AIS recorder listening at http://127.0.0.1:${options.port} (${options.source})`,
  );
  console.log(
    'API: /api/vessels, /api/vessels/track, /api/hormuz/history, /api/hormuz/polls, /api/hormuz/snapshot, /api/hormuz/stats',
  );

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Stopping AIS recorder (${signal})`);
    const serverClosed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    await Promise.all([serverClosed, controller.stop()]);
  };
  const onSignal = (signal) => {
    shutdown(signal).catch((error) => {
      console.error(`AIS recorder shutdown failed: ${error.message}`);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  server.once('close', () => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  });
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runCollector()
    .then((status) => {
      if (status) process.exitCode = status;
    })
    .catch((error) => {
      console.error(`AIS recorder failed: ${error.message}`);
      process.exitCode = 1;
    });
}

export { parseArgs as parseCollectorArgs };
