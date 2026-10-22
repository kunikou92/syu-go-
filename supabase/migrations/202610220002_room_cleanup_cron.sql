-- Supabase用。PGliteでのテスト時は、このスケジューラー登録を除く。
begin;
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('syu-go-room-cleanup', '* * * * *', 'select app_private.sweep_rooms();');
commit;
