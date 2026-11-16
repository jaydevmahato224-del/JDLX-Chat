-- ═══════════════════════════════════════════════════════════════════════════
-- JDLX Chat — Supabase Realtime PRIVATE-CHANNEL RLS
--
-- Run this ONCE in: Supabase Dashboard → SQL Editor.
-- Required for private channels to authorize joins.
--
-- Prerequisite: SUPABASE_JWT_SECRET (the project signing key) is set on the
-- JDLX Chat backend so it can mint per-user Realtime JWTs carrying:
--   { role: 'authenticated', sub: <chat_user_id>,
--     chat_user_id: <id>, allowed_topics: ["chat_room_<id>", "chat_user_<id>"] }
--
-- With these policies a client can only read/write broadcast messages on the
-- topics listed in its own token. Until these policies are applied, private
-- joins fail and the app automatically falls back to public channels after
-- two attempts (no breakage — but messages keep riding public channels).
--
-- The backend publishes with a short-lived service-role token, which bypasses
-- RLS — server-side broadcast dispatch is unaffected by this file.
-- ═══════════════════════════════════════════════════════════════════════════

drop policy if exists "jdlx_chat_allowed_topics_read" on realtime.messages;
drop policy if exists "jdlx_chat_allowed_topics_write" on realtime.messages;

-- READ: a signed-in chat client may receive messages only on topics its own
-- token authorizes (rooms it participates in + its personal user topic).
create policy "jdlx_chat_allowed_topics_read"
on realtime.messages
for select
to authenticated
using (
  realtime.topic() = any (
    array(
      select jsonb_array_elements_text(
        coalesce(auth.jwt() -> 'allowed_topics', '[]'::jsonb)
      )
    )
  )
);

-- WRITE: a client may broadcast (reactions / receipts / pings) only on topics
-- its own token authorizes. Message content itself is never written by
-- clients — new messages arrive via the backend's service-role dispatch.
create policy "jdlx_chat_allowed_topics_write"
on realtime.messages
for insert
to authenticated
with check (
  realtime.topic() = any (
    array(
      select jsonb_array_elements_text(
        coalesce(auth.jwt() -> 'allowed_topics', '[]'::jsonb)
      )
    )
  )
);
