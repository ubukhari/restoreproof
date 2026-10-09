-- A synthetic database shaped like a small Supabase project, for restoreproof's tests and its
-- recorded run. Every row is generated here; none is anyone's data.
--
-- It has what a restore test must get right: the auth and storage schemas, extensions in their own
-- schema, roles named by row-level security policies, a policy calling auth.uid(), an enum, a
-- domain, a view and a materialized view, a trigger, a partitioned table, an identity column,
-- a foreign key into auth.users, a database-webhook log whose rows the backup leaves out, and a
-- GraphQL schema the backup leaves out entirely.

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

CREATE SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE SCHEMA auth;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  email text UNIQUE NOT NULL,
  encrypted_password text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE SCHEMA storage;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets (id),
  name text,
  owner uuid,
  metadata jsonb
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own objects" ON storage.objects FOR SELECT TO authenticated USING (owner = auth.uid());

CREATE SCHEMA supabase_functions;
CREATE TABLE supabase_functions.hooks (id bigserial PRIMARY KEY, hook_table_id int, created_at timestamptz DEFAULT now());

CREATE SCHEMA graphql;
CREATE TABLE graphql.cache (k text PRIMARY KEY, v jsonb);

CREATE TYPE public.mood AS ENUM ('calm', 'busy', 'away');
CREATE DOMAIN public.handle AS text CHECK (VALUE ~ '^[a-z0-9_]{3,30}$');

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  handle public.handle UNIQUE NOT NULL,
  mood public.mood NOT NULL DEFAULT 'calm',
  bio text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles are public" ON public.profiles FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "own profile" ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());

CREATE FUNCTION public.touch() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER profiles_touch BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.touch();

CREATE TABLE public.notes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  author uuid NOT NULL REFERENCES public.profiles (id),
  body text NOT NULL CHECK (length(body) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_author_created ON public.notes (author, created_at DESC);

CREATE TABLE public.events (
  id bigserial,
  at date NOT NULL,
  kind text NOT NULL,
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);
CREATE TABLE public.events_2026_09 PARTITION OF public.events FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE public.events_2026_10 PARTITION OF public.events FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

CREATE TABLE public.settings (key text PRIMARY KEY, value jsonb NOT NULL);

CREATE VIEW public.active_profiles AS SELECT id, handle FROM public.profiles WHERE mood <> 'away';
CREATE MATERIALIZED VIEW public.notes_per_author AS SELECT author, count(*) AS notes FROM public.notes GROUP BY author;

CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, name text);

-- rows, generated
INSERT INTO auth.users (email, encrypted_password)
  SELECT 'user' || g || '@example.test', extensions.crypt('synthetic', extensions.gen_salt('bf', 4))
  FROM generate_series(1, 400) AS g;
INSERT INTO public.profiles (id, handle, mood)
  SELECT id, 'user_' || row_number() OVER (ORDER BY email), (ARRAY['calm', 'busy', 'away']::public.mood[])[1 + (row_number() OVER (ORDER BY email)) % 3]
  FROM auth.users;
INSERT INTO public.notes (author, body)
  SELECT p.id, 'note ' || g FROM public.profiles p, generate_series(1, 5) AS g;
INSERT INTO public.events (at, kind)
  SELECT date '2026-09-01' + (g % 60), (ARRAY['signup', 'login', 'upload'])[1 + g % 3] FROM generate_series(1, 3000) AS g;
INSERT INTO public.settings VALUES ('theme', '"dark"'), ('limits', '{"notes": 100}');
INSERT INTO storage.buckets VALUES ('avatars', 'avatars', true);
INSERT INTO storage.objects (bucket_id, name, owner, metadata)
  SELECT 'avatars', 'u/' || id || '.png', id, '{"size": 1024}' FROM auth.users LIMIT 120;
INSERT INTO supabase_functions.hooks (hook_table_id) SELECT g FROM generate_series(1, 50) AS g;
INSERT INTO graphql.cache VALUES ('q', '{}');
INSERT INTO supabase_migrations.schema_migrations VALUES ('20260901000000', 'init'), ('20260915000000', 'notes');
REFRESH MATERIALIZED VIEW public.notes_per_author;
ANALYZE;
