-- 可选：云端事件表（Postgres 兼容 BaaS，如 Supabase）
-- 未建表也不影响签到：服务端落库失败只记日志，自动降级为本地 state.json。
--
-- 权限：若开了 RLS，至少给写入角色 INSERT/SELECT 权限，否则报 42501。
-- 说明：本表只记录"哪天哪个账号签到成功/失败"，用于看板的本月累计与最近事件；
--       detail 里可能含积分数量，不含任何 token。

create table if not exists wbmon_events (
  id          bigserial primary key,
  account     text        not null,           -- 账号标签，形如 "WB-主号" / "Trae:Trae-主号" / "码道:码道-主号"
  kind        text        not null,           -- checkin / trae_checkin / trae_fail /
                                              -- codearts_checkin / codearts_auth / codearts_fail /
                                              -- qoder_checkin / qoder_auth / qoder_fail /
                                              -- travel_depart / travel_claim / buddy_adopt / selftest
  detail      text,                           -- 人类可读的一句结果
  extra       jsonb,                          -- 结构化附加信息（积分、设备 id、campaign id 等）
  created_at  timestamptz not null default now()
);

-- 看板按 created_at 倒序取最近事件、按月聚合，两个索引够用
create index if not exists wbmon_events_created_at_idx on wbmon_events (created_at desc);
create index if not exists wbmon_events_kind_idx on wbmon_events (kind);
