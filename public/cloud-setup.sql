-- 盘口手记：在新建的 Supabase 项目 SQL Editor 中运行一次。
-- 仅创建本应用的表、函数和私有图片桶；不需要把数据库密码放进前端。
begin;

create table if not exists public.journal_libraries (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null check (revision >= 1),
  content jsonb not null,
  updated_at timestamptz not null default now()
);
-- Update the old fixed-four-module constraint too when an existing project reruns this file.
alter table public.journal_libraries drop constraint if exists journal_libraries_content_check;
alter table public.journal_libraries add constraint journal_libraries_content_check check (
    content ?& array['schemaVersion','records','conditionGroups']
    and jsonb_typeof(content) = 'object'
    and (content->>'schemaVersion') is not distinct from '1'
    and jsonb_typeof(content->'records') = 'array'
    and jsonb_array_length(content->'records') <= 20000
    and jsonb_typeof(content->'conditionGroups') = 'array'
    and jsonb_array_length(content->'conditionGroups') between 0 and 20
    and octet_length(content::text) <= 16777216
  );
alter table public.journal_libraries enable row level security;
revoke all on public.journal_libraries from public, anon, authenticated;
grant select, insert, update on public.journal_libraries to authenticated;

drop policy if exists journal_read_own on public.journal_libraries;
create policy journal_read_own on public.journal_libraries for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists journal_insert_own on public.journal_libraries;
create policy journal_insert_own on public.journal_libraries for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists journal_update_own on public.journal_libraries;
create policy journal_update_own on public.journal_libraries for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create or replace function public.load_journal(expected_user_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null or expected_user_id is distinct from auth.uid() then
    raise exception 'JOURNAL_ACCOUNT_CHANGED' using errcode = '42501';
  end if;
  return (select jsonb_build_object('revision', revision, 'content', content)
    from public.journal_libraries where user_id = auth.uid());
end;
$$;
revoke all on function public.load_journal(uuid) from public, anon;
grant execute on function public.load_journal(uuid) to authenticated;

drop function if exists public.save_journal(bigint, jsonb);
create or replace function public.save_journal(expected_user_id uuid, expected_revision bigint, next_content jsonb)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare
  next_revision bigint;
  account_id uuid := auth.uid();
begin
  if account_id is null or expected_user_id is distinct from account_id then
    raise exception 'JOURNAL_ACCOUNT_CHANGED' using errcode = '42501';
  end if;
  if expected_revision is null or expected_revision < 0 then
    raise exception 'JOURNAL_INVALID_REVISION';
  end if;
  if next_content is null or jsonb_typeof(next_content) <> 'object'
     or not (next_content ?& array['schemaVersion','records','conditionGroups']) then
    raise exception 'JOURNAL_INVALID_CONTENT';
  end if;
  if expected_revision = 0 then
    insert into public.journal_libraries(user_id, revision, content)
      values(account_id, 1, next_content)
      on conflict(user_id) do nothing
      returning revision into next_revision;
  else
    update public.journal_libraries
      set content = next_content, revision = revision + 1, updated_at = now()
      where user_id = account_id and revision = expected_revision
      returning revision into next_revision;
  end if;
  if next_revision is null then
    raise exception 'JOURNAL_CONFLICT' using errcode = 'P0001';
  end if;
  return next_revision;
end;
$$;
revoke all on function public.save_journal(uuid, bigint, jsonb) from public, anon;
grant execute on function public.save_journal(uuid, bigint, jsonb) to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values('journal-screenshots', 'journal-screenshots', false, 8388608, array['image/png','image/jpeg','image/webp'])
on conflict(id) do update set public = false,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists journal_images_read_own on storage.objects;
create policy journal_images_read_own on storage.objects for select to authenticated
  using (bucket_id = 'journal-screenshots' and (storage.foldername(name))[1] = (select auth.uid()::text));
drop policy if exists journal_images_insert_own on storage.objects;
create policy journal_images_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'journal-screenshots' and (storage.foldername(name))[1] = (select auth.uid()::text));
-- 不授予客户端覆盖或物理删除原图的权限，避免并发编辑/保存重试造成附件丢失。
commit;
