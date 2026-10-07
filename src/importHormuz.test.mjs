import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { importHormuzArchive, parseImportArgs } from '../scripts/import-hormuz.mjs';

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gev-import-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const from = path.join(dir, 'legacy.sqlite');
  const output = path.join(dir, 'recording.sqlite');
  const db = new DatabaseSync(from);
  db.exec(`
    CREATE TABLE poll(id INTEGER PRIMARY KEY,data_stamp TEXT,fetched_at TEXT,source_last_poll TEXT,error TEXT);
    CREATE TABLE vessel(mmsi TEXT PRIMARY KEY,name TEXT,ship_category TEXT,flag TEXT);
    CREATE TABLE vessel_position(poll_id INTEGER,mmsi TEXT,observed_at TEXT,lat REAL,lon REAL,speed REAL,hdg REAL);
    INSERT INTO vessel VALUES('123456789','PUBLIC FIXTURE','Cargo','Test');
    INSERT INTO poll VALUES(1,'2026-10-01T19:30:00-05:00','2026-10-01T19:31:00-05:00',NULL,NULL);
    INSERT INTO poll VALUES(2,'2026-10-02T01:00:00Z','2026-10-02T01:01:00Z',NULL,NULL);
    INSERT INTO vessel_position VALUES(1,'123456789','2026-10-01T19:29:00-05:00',26,56,4,90);
  `);
  db.close();
  return { from, db: output };
}

test('imports recorded instants/metadata and exact empty polls, never changes source, retries are idempotent', (t) => {
  const options = fixture(t);
  const before = readFileSync(options.from);
  assert.deepEqual(importHormuzArchive(options), {
    importedPolls: 2,
    duplicatePolls: 0,
    failedPolls: 0,
    skippedUnstampedFailures: 0,
    positions: 1,
    crossingsImported: false,
  });
  assert.deepEqual(readFileSync(options.from), before);
  assert.equal(importHormuzArchive(options).duplicatePolls, 2);
  const db = new DatabaseSync(options.db, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM polls').get().n, 2);
    const position = db.prepare('SELECT * FROM positions').get();
    assert.equal(position.observed_at, '2026-10-02T00:29:00.000Z');
    assert.equal(JSON.parse(position.payload).name, 'PUBLIC FIXTURE');
    assert.equal(JSON.parse(position.payload).heading, 90);
    assert.equal(db.prepare('SELECT source FROM recording_config').get().source, 'hormuz');
  } finally {
    db.close();
  }
});

test('rejects same file, unknown schemas, active output writer and invalid fixes', (t) => {
  const options = fixture(t);
  assert.throws(() => importHormuzArchive({from: options.from, db: options.from}), /different files/);
  writeFileSync(`${options.db}.writer.lock`, 'fixture writer');
  assert.throws(() => importHormuzArchive(options), /already has a writer/);
  rmSync(`${options.db}.writer.lock`);
  const db = new DatabaseSync(options.from);
  db.exec('UPDATE vessel_position SET lat=200');
  db.close();
  assert.throws(() => importHormuzArchive(options), /Invalid recorded position/);
  const unknown = path.join(path.dirname(options.from), 'unknown.sqlite');
  const other = new DatabaseSync(unknown);
  other.exec('CREATE TABLE unrelated(value TEXT)');
  other.close();
  assert.throws(() => importHormuzArchive({from: unknown, db: options.db}), /Missing legacy table/);
});

test('CLI requires explicit separate paths, rejects unknown and repeated options', () => {
  assert.deepEqual(parseImportArgs(['--from', 'old.sqlite', '--db', 'new.sqlite']), {
    from: 'old.sqlite', db: 'new.sqlite',
  });

  test('stamped failures retain provenance; unstamped failures are explicitly skipped', (t) => {
    const options = fixture(t);
    const legacy = new DatabaseSync(options.from);
    legacy.exec(`
      INSERT INTO poll VALUES(3,'2026-10-03T01:00:00Z','2026-10-03T01:01:00Z',NULL,'Fixture timeout');
      INSERT INTO poll VALUES(4,NULL,'2026-10-03T02:00:00Z',NULL,'Fixture missing stamp');
    `);
    legacy.close();
    const summary = importHormuzArchive(options);
    assert.equal(summary.failedPolls, 1);
    assert.equal(summary.skippedUnstampedFailures, 1);
    const db = new DatabaseSync(options.db, { readOnly: true });
    try {
      assert.equal(
        db.prepare("SELECT error FROM polls WHERE status='failed'").get().error,
        'Fixture timeout',
      );
    } finally {
      db.close();
    }
  });

  test('over-limit individual polls fail explicitly without silently truncating', (t) => {
    const options = fixture(t);
    const legacy = new DatabaseSync(options.from);
    legacy.exec(`
      WITH RECURSIVE fixes(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM fixes WHERE n<50001)
      INSERT INTO vessel_position
      SELECT 2, '123456789', '2026-10-02T01:00:00Z', 26, 56, 4, 90 FROM fixes;
    `);
    legacy.close();
    assert.throws(() => importHormuzArchive(options), /exceeds 50000 positions/);
    // The earlier committed frame survives and a corrected source can resume.
    const db = new DatabaseSync(options.db, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM polls').get().n, 1);
    } finally {
      db.close();
    }
  });
  assert.equal(parseImportArgs(['--help']).help, true);
  for (const args of [[], ['--from'], ['--unknown'], ['--from', 'a', '--from', 'b']])
    assert.throws(() => parseImportArgs(args));
});
