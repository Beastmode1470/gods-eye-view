import {
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  createRecordingStore,
  RECORDING_MAX_ROWS,
  validUtc,
} from '../server/providers/vessels/recording-store.js';

const MAX_POLLS = 1_000_000;
export const IMPORT_HELP = `Usage: node scripts/import-hormuz.mjs --from PATH --db OUTPUT

Read an existing Hormuz SQLite archive without modifying it and append its
recorded polls to a separate fork recording database. Node.js 24.14+ required.
Stop writers to the OUTPUT database first. The original collector may remain
installed; this command neither starts nor changes it. Re-importing successful
poll timestamps is idempotent. No earlier positions are reconstructed.
`;

export function parseImportArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help') {
      options.help = true;
      continue;
    }
    if (!['--from', '--db'].includes(flag))
      throw new Error(`Unknown option: ${flag}`);
    const key = flag.slice(2);
    if (options[key]) throw new Error(`Duplicate option: ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith('--') || !value.trim())
      throw new Error(`${flag} requires a path`);
    options[key] = value;
  }
  if (!options.help && (!options.from || !options.db))
    throw new Error('--from PATH and --db OUTPUT are required');
  return options;
}

function canonicalOutput(filename) {
  const resolved = path.resolve(filename);
  if (existsSync(resolved)) return realpathSync(resolved);
  let ancestor = path.dirname(resolved);
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  return path.join(realpathSync(ancestor), path.relative(ancestor, resolved));
}

function columns(db, table) {
  const names = db.prepare(`PRAGMA table_info("${table}")`).all();
  if (!names.length) throw new Error(`Missing legacy table: ${table}`);
  return new Set(names.map((row) => row.name));
}

function required(names, table, candidates) {
  const found = candidates.find((name) => names.has(name));
  if (!found)
    throw new Error(
      `Unsupported ${table} schema: requires ${candidates.join(' or ')}`,
    );
  return found;
}

function validateFix(row, pollId) {
  const validNumber = (value, bound) =>
    value !== null &&
    value !== '' &&
    Number.isFinite(Number(value)) &&
    Math.abs(Number(value)) <= bound;
  if (
    !/^\d{1,10}$/.test(String(row.mmsi ?? '')) ||
    !validNumber(row.lat, 90) ||
    !validNumber(row.lon, 180) ||
    !validUtc(row.observed_at)
  )
    throw new Error(
      `Invalid recorded position in legacy poll ${pollId}; nothing fabricated`,
    );
}

/** Import a consistent read-only snapshot; each output poll is atomically committed. */
export function importHormuzArchive({ from, db: output }) {
  if (!from || !output) throw new Error('Source and output paths are required');
  const sourcePath = realpathSync(path.resolve(from));
  const sourceStat = statSync(sourcePath);
  if (!sourceStat.isFile())
    throw new Error('Source must be a readable SQLite file');
  const outputPath = canonicalOutput(output);
  const samePath =
    process.platform === 'win32'
      ? sourcePath.toLowerCase() === outputPath.toLowerCase()
      : sourcePath === outputPath;
  const outputStat = existsSync(outputPath) ? statSync(outputPath) : null;
  if (
    samePath ||
    (outputStat &&
      sourceStat.dev === outputStat.dev &&
      sourceStat.ino === outputStat.ino)
  )
    throw new Error(
      'Source and output must be different files; source is never modified',
    );

  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let store;
  const summary = {
    importedPolls: 0,
    duplicatePolls: 0,
    failedPolls: 0,
    skippedUnstampedFailures: 0,
    positions: 0,
    crossingsImported: false,
  };
  try {
    source.exec('PRAGMA query_only=ON; BEGIN;');
    const pollCols = columns(source, 'poll');
    const positionCols = columns(source, 'vessel_position');
    const vesselCols = columns(source, 'vessel');
    const pollKey = required(pollCols, 'poll', ['poll_id', 'id']);
    for (const name of ['data_stamp', 'fetched_at'])
      required(pollCols, 'poll', [name]);
    for (const name of ['poll_id', 'mmsi', 'observed_at', 'lat', 'lon'])
      required(positionCols, 'vessel_position', [name]);
    required(vesselCols, 'vessel', ['mmsi']);
    const count = Number(source.prepare('SELECT COUNT(*) AS n FROM poll').get().n);
    if (count > MAX_POLLS)
      throw new Error(`Archive exceeds ${MAX_POLLS} polls; import aborted`);
    if (
      source
        .prepare(
          'SELECT mmsi FROM vessel GROUP BY mmsi HAVING COUNT(*)>1 LIMIT 1',
        )
        .get()
    )
      throw new Error('Legacy vessel metadata has duplicate MMSI keys');
    if (source.prepare(`SELECT p.poll_id FROM vessel_position p
      LEFT JOIN poll ON poll."${pollKey}"=p.poll_id
      WHERE poll."${pollKey}" IS NULL LIMIT 1`).get())
      throw new Error('Legacy archive has positions without a matching poll');
    const fields = [
      'name', 'ship_category', 'type', 'speed', 'course', 'hdg', 'heading',
      'destination', 'imo', 'flag', 'zone', 'draught', 'dwt', 'length', 'width',
    ];
    const projected = fields.flatMap((name) => {
      if (positionCols.has(name) && vesselCols.has(name))
        return [`COALESCE(p."${name}",v."${name}") AS "${name}"`];
      if (positionCols.has(name)) return [`p."${name}" AS "${name}"`];
      if (vesselCols.has(name)) return [`v."${name}" AS "${name}"`];
      return [];
    });
    const positions = source.prepare(`SELECT p.mmsi,p.lat,p.lon,p.observed_at
      ${projected.length ? ',' + projected.join(',') : ''}
      FROM vessel_position p LEFT JOIN vessel v ON v.mmsi=p.mmsi
      WHERE p.poll_id=? ORDER BY p.observed_at,p.mmsi LIMIT ?`);
    const polls = source.prepare(`SELECT * FROM poll ORDER BY "${pollKey}" LIMIT ? OFFSET ?`);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    store = createRecordingStore({ dbPath: outputPath, source: 'hormuz' });
    for (let offset = 0; offset < count; offset += 500) {
      for (const poll of polls.all(500, offset)) {
        const id = poll[pollKey];
        if (!Number.isSafeInteger(id) || id < 1)
          throw new Error('Legacy poll identifier is not a positive safe integer');
        let error = poll.error || null;
        if (pollCols.has('ok')) {
          if (![0, 1].includes(poll.ok))
            throw new Error(`Invalid legacy success flag in poll ${id}`);
          if (poll.ok === 0)
            error ||= 'Legacy collector reported a failed poll';
        }
        if (
          pollCols.has('status') &&
          !['success', 'ok', '200', 'failed', 'error'].includes(
            String(poll.status),
          )
        )
          throw new Error(`Unsupported legacy poll status in poll ${id}`);
        if (['failed', 'error'].includes(String(poll.status)))
          error ||= 'Legacy collector reported a failed poll';
        if (pollCols.has('http_status') && Number(poll.http_status) !== 200)
          error ||= `Legacy HTTP ${poll.http_status}`;
        if (!validUtc(poll.fetched_at) || (!error && !validUtc(poll.data_stamp)))
          throw new Error(`Invalid legacy timestamps in poll ${id}`);
        // No timestamp-less failures: there is no immutable identity for safe retries.
        if (error && !validUtc(poll.data_stamp)) {
          summary.skippedUnstampedFailures++;
          continue;
        }
        const rows = error ? [] : positions.all(id, RECORDING_MAX_ROWS + 1);
        if (rows.length > RECORDING_MAX_ROWS)
          throw new Error(
            `Legacy poll ${id} exceeds ${RECORDING_MAX_ROWS} positions; not truncated`,
          );
        for (const row of rows) validateFix(row, id);
        const result = store.recordPoll({
          dataStamp: poll.data_stamp,
          fetchedAt: poll.fetched_at,
          sourceLastPoll: poll.source_last_poll ?? null,
          vessels: rows,
          error,
        });
        if (result.duplicate) summary.duplicatePolls++;
        else if (error) summary.failedPolls++;
        else {
          summary.importedPolls++;
          summary.positions += result.positions;
        }
      }
    }
    return summary;
  } finally {
    try {
      store?.close();
    } finally {
      source.close();
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const options = parseImportArgs(process.argv.slice(2));
    if (options.help) console.log(IMPORT_HELP);
    else console.log(JSON.stringify(importHormuzArchive(options), null, 2));
  } catch (error) {
    console.error(
      `Hormuz import failed: ${error.message}. Successful prior polls, if any, remain safely resumable.`,
    );
    process.exitCode = 1;
  }
}
