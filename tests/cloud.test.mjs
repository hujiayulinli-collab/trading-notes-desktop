import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  conditionGroups,
  mergeConditionGroups,
  newTrade,
} from '../lib/journal.ts';
import {
  CloudJournalClient,
  validateCloudConfig,
} from '../lib/journal-cloud.ts';
import { inspectCloudBackup } from '../lib/journal-backup.ts';
import { JournalStore } from '../server/storage.mjs';
import sharp from 'sharp';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const content = (title = 'A 的手记') => ({
  schemaVersion: 1,
  records: [{ ...newTrade(), symbol: 'XAUUSD', title }],
  conditionGroups: conditionGroups(),
});

void test('自定义条件兼容旧库、持久保存、备份合并、重复及越界校验', async () => {
  await fs.mkdir('test-results', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('test-results/conditions-'));
  const store = await new JournalStore(root).init();
  const groups = conditionGroups();
  groups[2].options.push('5m 吞没确认');
  const trade = { ...newTrade(), tags: ['旧条件'] };
  await store.save([trade], 0, groups);
  const reopened = await new JournalStore(root).init();
  assert.deepEqual(reopened.snapshot().conditionGroups, groups);
  const backup = await reopened.exportBackup();
  const otherRoot = await fs.mkdtemp(
    path.resolve('test-results/conditions-target-'),
  );
  const other = await new JournalStore(otherRoot).init();
  await other.importBackup(backup, 0);
  assert.deepEqual(other.snapshot().conditionGroups, groups);
  assert.deepEqual(other.snapshot().records[0].tags, ['旧条件']);
  const edited = conditionGroups(groups);
  edited[0].options = [];
  await other.save(other.snapshot().records, 1, edited);
  // Older clients omit the new field; saving must preserve existing presets.
  await other.save(other.snapshot().records, 2);
  assert.deepEqual(other.snapshot().conditionGroups, edited);
  const olderBackup = { ...backup };
  delete olderBackup.conditionGroups;
  await other.importBackup(olderBackup, 3);
  assert.deepEqual(other.snapshot().conditionGroups, edited);
  const restored = await inspectCloudBackup(backup, [], conditionGroups());
  assert.deepEqual(restored.groups, groups);
  const duplicate = conditionGroups();
  duplicate[1].options.push('15m FVG');
  assert.throws(() => conditionGroups(duplicate), /重复/);
  assert.equal(
    conditionGroups([{ title: '其他', options: [] }])[0].title,
    '其他',
  );
  const tooMany = conditionGroups();
  tooMany[0].options = Array.from({ length: 51 }, (_, i) => `条件 ${i}`);
  assert.throws(() => conditionGroups(tooMany), /50/);
  assert.deepEqual(mergeConditionGroups(groups, undefined), groups);
  // Existing libraries without conditionGroups are upgraded in memory, with records intact.
  const legacyRoot = await fs.mkdtemp(
    path.resolve('test-results/conditions-legacy-'),
  );
  await fs.mkdir(path.join(legacyRoot, 'data'));
  await fs.writeFile(
    path.join(legacyRoot, 'data/journal.json'),
    JSON.stringify({ schemaVersion: 1, revision: 4, records: [trade] }),
  );
  const legacy = await new JournalStore(legacyRoot).init();
  assert.deepEqual(legacy.snapshot().conditionGroups, conditionGroups());
  await legacy.save([trade], 4, groups);
  assert.equal(legacy.snapshot().records[0].id, trade.id);
});

void test('连接配置只接受 HTTPS 项目地址及前端公钥', () => {
  const valid = {
    url: 'https://example.supabase.co/',
    key: 'sb_publishable_example_123456789',
  };
  assert.equal(validateCloudConfig(valid).url, 'https://example.supabase.co');
  for (const url of [
    'http://example.supabase.co',
    'https://evil.example',
    'https://example.supabase.co@evil.example',
    'https://example.supabase.co/?token=secret',
  ])
    assert.throws(() => validateCloudConfig({ ...valid, url }));
  assert.throws(() =>
    validateCloudConfig({ ...valid, key: 'sb_secret_do_not_use_this_key' }),
  );
  const jwt = (role) =>
    `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ role }))}.signature`;
  assert.throws(() =>
    validateCloudConfig({ ...valid, key: jwt('service_role') }),
  );
  assert.equal(
    validateCloudConfig({ ...valid, key: jwt('anon') }).key,
    jwt('anon'),
  );
});

void test('本地完整备份往返云端适配器，原图校验、重复导入与条件不丢失', async (t) => {
  const originalBitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async (blob) => {
    const metadata = await sharp(
      Buffer.from(await blob.arrayBuffer()),
    ).metadata();
    return { width: metadata.width, height: metadata.height, close() {} };
  };
  t.after(() => {
    if (originalBitmap) globalThis.createImageBitmap = originalBitmap;
    else delete globalThis.createImageBitmap;
  });
  await fs.mkdir('test-results', { recursive: true });
  const sourceRoot = await fs.mkdtemp(
    path.resolve('test-results/cloud-source-'),
  );
  const source = await new JournalStore(sourceRoot).init();
  const png = await sharp({
    create: { width: 3, height: 3, channels: 3, background: '#345c48' },
  })
    .png()
    .toBuffer();
  const shot = await source.upload({
    name: '入场原图.png',
    mime: 'image/png',
    data: png.toString('base64'),
  });
  const groups = conditionGroups();
  groups[3].options.push('4H 顺势');
  groups[0].title = 'OB';
  groups.push({ id: 'custom-liquidity', title: '流动性', options: ['扫前高'] });
  const trade = {
    ...newTrade(),
    symbol: 'NQ',
    category: 'review',
    entryScore: 0,
    entryAutoText: '4H 顺势',
    notes: { entry: '4H 顺势', execution: '', lessons: '', improvement: '' },
    screenshots: [shot],
    tags: ['4H 顺势'],
  };
  await source.save([trade], 0, groups, 0.5);
  const backup = await source.exportBackup();
  const files = new Map();
  let library = null;
  const rpc = async (name, args) => {
    if (args.expected_user_id !== a)
      return { data: null, error: { message: 'JOURNAL_ACCOUNT_CHANGED' } };
    if (name === 'load_journal')
      return { data: structuredClone(library), error: null };
    if (args.expected_revision !== (library?.revision || 0))
      return { data: null, error: { message: 'JOURNAL_CONFLICT' } };
    library = {
      revision: args.expected_revision + 1,
      content: structuredClone(args.next_content),
    };
    return { data: library.revision, error: null };
  };
  const mock = {
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: a } } },
        error: null,
      }),
    },
    rpc,
    storage: {
      from: (bucket) => {
        assert.equal(bucket, 'journal-screenshots');
        return {
          upload: async (file, bytes, options) => {
            assert.ok(file.startsWith(a + '/'));
            assert.equal(options.upsert, false);
            assert.equal(files.has(file), false);
            files.set(file, new Blob([bytes], { type: options.contentType }));
            return { error: null };
          },
          download: async (file) => ({
            data: files.get(file),
            error: files.has(file) ? null : { message: 'missing image' },
          }),
        };
      },
    },
  };
  const cloud = new CloudJournalClient(mock, a, 'owner@example.com');
  const preview = await cloud.request('/api/import/preview', 'POST', backup);
  assert.equal(preview.added, 1);
  const imported = await cloud.request('/api/import', 'POST', {
    backup,
    revision: 0,
  });
  assert.notEqual(imported.records[0].screenshots[0].id, shot.id);
  assert.deepEqual(imported.conditionGroups, groups);
  assert.equal(imported.baseRiskPercent, 0.5);
  assert.equal(imported.records[0].entryScore, 0);
  assert.equal((await cloud.load()).baseRiskPercent, 0.5);
  const again = await cloud.request('/api/import', 'POST', {
    backup,
    revision: 1,
  });
  assert.equal(again.added, 0);
  assert.equal(again.skipped, 1);
  assert.equal(files.size, 1);
  const exported = await cloud.request('/api/backup');
  assert.equal(exported.baseRiskPercent, 0.5);
  assert.equal(exported.assets[0].data, png.toString('base64'));
  assert.equal(exported.assets[0].sha256, backup.assets[0].sha256);
  const targetRoot = await fs.mkdtemp(
    path.resolve('test-results/cloud-target-'),
  );
  const target = await new JournalStore(targetRoot).init();
  await target.importBackup(exported, 0);
  assert.deepEqual(target.snapshot().conditionGroups, groups);
  assert.equal(target.snapshot().baseRiskPercent, 0.5);
  assert.deepEqual(target.snapshot().records[0].tags, ['4H 顺势']);
  assert.equal(target.snapshot().records[0].category, 'review');
  assert.equal(target.snapshot().records[0].entryScore, 0);
  assert.equal(target.snapshot().records[0].entryAutoText, '4H 顺势');
  assert.equal(target.snapshot().records[0].notes.entry, '4H 顺势');
  assert.deepEqual(
    await fs.readFile(
      target.assetPath(target.snapshot().records[0].screenshots[0]),
    ),
    png,
  );
  const bad = structuredClone(backup);
  bad.assets[0].sha256 = 'bad-hash';
  await assert.rejects(
    () => cloud.request('/api/import', 'POST', { backup: bad, revision: 2 }),
    /校验失败/,
  );
  assert.equal(library.revision, 2);
  assert.equal(files.size, 1);
});

void test('真实 PostgreSQL 执行建库、用户隔离、图片策略和多设备 CAS，适配器绑定预期账号', async () => {
  const db = new PGlite();
  try {
    // Minimal equivalents of Supabase-owned schemas, roles and auth.uid().
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create schema auth;
      create schema storage;
      create table auth.users(id uuid primary key);
      insert into auth.users values('${a}'),('${b}');
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects(id bigint generated always as identity primary key, bucket_id text, name text);
      create function storage.foldername(name text) returns text[] language sql immutable as $$
        select string_to_array(name, '/')
      $$;
      alter table storage.objects enable row level security;
      grant usage on schema public, auth, storage to anon, authenticated;
      grant select, insert, update, delete on storage.objects to authenticated;
      grant usage on sequence storage.objects_id_seq to authenticated;
    `);
    const migration = await fs.readFile('supabase/setup.sql', 'utf8');
    await db.exec(migration);
    await db.exec(migration); // Safe rerun does not wipe records or fail on existing policies.
    const switchUser = async (id, role = 'authenticated') => {
      await db.exec('reset role');
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
        id,
      ]);
      await db.exec(`set role ${role}`);
    };
    const save = async (id, revision, value) =>
      (
        await db.query(
          'select public.save_journal($1, $2, $3::jsonb) as revision',
          [id, revision, JSON.stringify(value)],
        )
      ).rows[0].revision;
    await switchUser('', 'anon');
    await assert.rejects(
      () => db.query('select * from public.journal_libraries'),
      /permission denied/,
    );
    await assert.rejects(() => save(a, 0, content()), /permission denied/);
    await switchUser(a);
    assert.equal(await save(a, 0, content()), 1);
    await assert.rejects(
      () => save(a, 0, content('另一设备首次保存')),
      /JOURNAL_CONFLICT/,
    );
    assert.equal(await save(a, 1, content('已保存新版')), 2);
    await assert.rejects(
      () => save(a, 1, content('过期设备')),
      /JOURNAL_CONFLICT/,
    );
    await assert.rejects(() => save(a, -1, content()), /INVALID_REVISION/);
    await assert.rejects(
      () => save(a, 2, { ...content(), schemaVersion: null }),
      /check constraint/,
    );
    assert.equal(
      (await db.query('select content from public.journal_libraries')).rows[0]
        .content.records[0].title,
      '已保存新版',
    );
    await db.query(
      'insert into storage.objects(bucket_id, name) values($1, $2)',
      ['journal-screenshots', `${a}/original.png`],
    );
    await assert.rejects(
      () =>
        db.query(
          'insert into storage.objects(bucket_id, name) values($1, $2)',
          ['journal-screenshots', `${b}/wrong.png`],
        ),
      /row-level security/,
    );
    await switchUser(b);
    assert.equal(
      (await db.query('select * from public.journal_libraries')).rows.length,
      0,
    );
    assert.equal(
      (await db.query('select * from storage.objects')).rows.length,
      0,
    );
    await assert.rejects(
      () => db.query('select public.load_journal($1)', [a]),
      /ACCOUNT_CHANGED/,
    );
    await assert.rejects(
      () => save(a, 2, content('串账号')),
      /ACCOUNT_CHANGED/,
    );
    assert.equal(await save(b, 0, content('B 的手记')), 1);
    await assert.rejects(
      () => db.query('update public.journal_libraries set user_id=$1', [a]),
      /row-level security/,
    );
    await switchUser(a);
    await db.query('delete from storage.objects where name=$1', [
      `${a}/original.png`,
    ]);
    assert.equal(
      (await db.query('select * from storage.objects')).rows.length,
      1,
    );
    await db.query('update storage.objects set name=$1 where name=$2', [
      `${a}/replacement.png`,
      `${a}/original.png`,
    ]);
    assert.equal(
      (await db.query('select name from storage.objects')).rows[0].name,
      `${a}/original.png`,
    );
    // Upgrade an existing fixed-four-module database without changing its records.
    await db.exec('reset role');
    await db.exec(`alter table public.journal_libraries drop constraint journal_libraries_content_check;
      alter table public.journal_libraries add constraint journal_libraries_content_check
      check (jsonb_array_length(content->'conditionGroups') = 4);`);
    await db.exec(migration);
    await db.exec(migration);
    await switchUser(a);
    // Use the actual adapter with a database-backed RPC transport.
    let sessionUser = a;
    let switchAfterCheck = false;
    const mock = {
      auth: {
        getSession: async () => {
          const user = sessionUser;
          if (switchAfterCheck) sessionUser = b;
          return { data: { session: { user: { id: user } } }, error: null };
        },
      },
      rpc: async (name, args) => {
        await switchUser(sessionUser);
        try {
          const data =
            name === 'save_journal'
              ? await save(
                  args.expected_user_id,
                  args.expected_revision,
                  args.next_content,
                )
              : (
                  await db.query('select public.load_journal($1) as data', [
                    args.expected_user_id,
                  ])
                ).rows[0].data;
          return { data, error: null };
        } catch (error) {
          return {
            data: null,
            error: { message: error.message, code: error.code },
          };
        }
      },
    };
    const adapter = new CloudJournalClient(mock, a, 'a@example.com');
    const loaded = await adapter.load();
    assert.equal(loaded.revision, 2);
    const customGroups = conditionGroups();
    customGroups[0].title = 'OB';
    customGroups.push({
      id: 'custom-liquidity',
      title: '流动性',
      options: ['扫前低'],
    });
    const saved = await adapter.save({
      ...loaded,
      conditionGroups: customGroups,
      records: content('适配器正常保存').records.map((trade) => ({
        ...trade,
        entryScore: 100,
      })),
    });
    assert.equal(saved.revision, 3);
    const reloaded = await adapter.load();
    assert.deepEqual(reloaded.conditionGroups, customGroups);
    assert.equal(reloaded.records[0].entryScore, 100);
    await assert.rejects(
      () =>
        save(a, 3, {
          ...content(),
          conditionGroups: Array.from({ length: 21 }, (_, i) => ({
            title: `模块${i}`,
            options: [],
          })),
        }),
      /check constraint/,
    );
    switchAfterCheck = true;
    await assert.rejects(
      () => adapter.save({ ...saved, revision: 1 }),
      /权限|登录|账号/,
    );
    assert.equal(
      (await db.query('select content from public.journal_libraries')).rows[0]
        .content.records[0].title,
      'B 的手记',
    );
    await assert.rejects(() => adapter.authorize(), /登录已失效/);
  } finally {
    await db.close();
  }
});
