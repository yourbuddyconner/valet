CREATE TABLE "orgs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sso_team_groups" jsonb,
	"created_at" bigint NOT NULL,
	"bare_skill_commands" boolean NOT NULL DEFAULT false,
	"allow_public_artifacts" boolean NOT NULL DEFAULT false,
	"allow_anonymous_image_bakes" boolean NOT NULL DEFAULT false,
	"allow_personal_installations" boolean NOT NULL DEFAULT true,
	"model_tiers" jsonb,
	"approved_models" jsonb,
	"reasoning_settings" jsonb
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"default_model" text,
	"default_reasoning" text,
	"new_thread_behavior" text DEFAULT 'keep_current' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_unique" ON "user" ("email");
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	FOREIGN KEY ("user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_unique" ON "session" ("token");
--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" ("user_id");
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	FOREIGN KEY ("user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" ("user_id");
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");
--> statement-breakpoint
CREATE TABLE "sso_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"oidc_config" text,
	"saml_config" text,
	"user_id" text,
	"provider_id" text NOT NULL,
	"organization_id" text,
	"domain" text NOT NULL,
	FOREIGN KEY ("user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sso_provider_providerId_unique" ON "sso_provider" ("provider_id");
--> statement-breakpoint
CREATE TABLE "apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer DEFAULT 86400000,
	"rate_limit_max" integer DEFAULT 10,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"permissions" text,
	"metadata" text,
	"team_id" text
);
--> statement-breakpoint
CREATE INDEX "apikey_configId_idx" ON "apikey" ("config_id");
--> statement-breakpoint
CREATE INDEX "apikey_referenceId_idx" ON "apikey" ("reference_id");
--> statement-breakpoint
CREATE INDEX "apikey_key_idx" ON "apikey" ("key");
--> statement-breakpoint
CREATE INDEX "apikey_teamId_idx" ON "apikey" ("team_id");
--> statement-breakpoint
CREATE TABLE "oauth_application" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"icon" text,
	"metadata" text,
	"client_id" text,
	"client_secret" text,
	"redirect_urls" text,
	"type" text,
	"disabled" boolean DEFAULT false,
	"user_id" text,
	"created_at" timestamp,
	"updated_at" timestamp,
	FOREIGN KEY ("user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_application_clientId_unique" ON "oauth_application" ("client_id");
--> statement-breakpoint
CREATE INDEX "oauthApplication_userId_idx" ON "oauth_application" ("user_id");
--> statement-breakpoint
CREATE TABLE "oauth_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"client_id" text,
	"user_id" text,
	"scopes" text,
	"created_at" timestamp,
	"updated_at" timestamp,
	FOREIGN KEY ("client_id") REFERENCES "oauth_application"("client_id") ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY ("user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_access_token_accessToken_unique" ON "oauth_access_token" ("access_token");
--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_access_token_refreshToken_unique" ON "oauth_access_token" ("refresh_token");
--> statement-breakpoint
CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauth_access_token" ("client_id");
--> statement-breakpoint
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauth_access_token" ("user_id");
--> statement-breakpoint
CREATE TABLE "oauth_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text,
	"user_id" text,
	"scopes" text,
	"created_at" timestamp,
	"updated_at" timestamp,
	"consent_given" boolean,
	FOREIGN KEY ("client_id") REFERENCES "oauth_application"("client_id") ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY ("user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "oauthConsent_clientId_idx" ON "oauth_consent" ("client_id");
--> statement-breakpoint
CREATE INDEX "oauthConsent_userId_idx" ON "oauth_consent" ("user_id");
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"email" text,
	"role" text DEFAULT 'member' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"accepted_by" text,
	"accepted_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX "invites_code_hash_unique" ON "invites" ("code_hash");
--> statement-breakpoint
CREATE INDEX "idx_invites_email" ON "invites" ("email");
--> statement-breakpoint
CREATE TABLE "sandbox_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_tokens_token_hash_unique" ON "sandbox_tokens" ("token_hash");
--> statement-breakpoint
CREATE INDEX "idx_sandbox_tokens_hash" ON "sandbox_tokens" ("token_hash");
--> statement-breakpoint
CREATE TABLE "org_members" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" bigint,
	PRIMARY KEY("org_id", "user_id")
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"workspace" text NOT NULL,
	"title" text,
	"status" text DEFAULT 'active' NOT NULL,
	"owner_type" text DEFAULT 'user' NOT NULL,
	"owner_id" text DEFAULT '' NOT NULL,
	"credential_owner_mode" text,
	"profile" text DEFAULT 'headless' NOT NULL,
	"docker" boolean DEFAULT false NOT NULL,
	"kubernetes" boolean DEFAULT false NOT NULL,
	"sandbox_resource_overrides" jsonb,
	"kind" text DEFAULT 'code' NOT NULL,
	"bake_id" text,
	"hibernated_sandbox_id" text,
	"sandbox_reclaimed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_activity_at" bigint
);
--> statement-breakpoint
CREATE INDEX "agent_sessions_user" ON "agent_sessions" ("user_id");
--> statement-breakpoint
CREATE INDEX "agent_sessions_status" ON "agent_sessions" ("status");
--> statement-breakpoint
CREATE TABLE "session_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"title" text,
	"created_at" bigint NOT NULL,
	"last_user_activity_at" bigint,
	"archived_at" bigint
);
--> statement-breakpoint
CREATE INDEX "session_threads_session" ON "session_threads" ("session_id");
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"thread_id" text,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"parts" jsonb,
	"author_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "messages_session" ON "messages" ("session_id");
--> statement-breakpoint
CREATE INDEX "messages_thread" ON "messages" ("thread_id");
--> statement-breakpoint
CREATE INDEX "messages_created" ON "messages" ("created_at");
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"slack_home_channel_id" text,
	"origin" text DEFAULT 'local' NOT NULL,
	"external_id" text,
	"created_at" bigint NOT NULL,
	"default_model" text,
	"default_reasoning" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "teams_org_name" ON "teams" ("org_id","name");
--> statement-breakpoint
CREATE UNIQUE INDEX "teams_org_external" ON "teams" ("org_id","origin","external_id");
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	PRIMARY KEY("team_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX "team_members_user" ON "team_members" ("user_id");
--> statement-breakpoint
CREATE TABLE "team_join_eligibilities" (
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"observed_at" bigint NOT NULL,
	PRIMARY KEY("team_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX "team_join_eligibilities_user" ON "team_join_eligibilities" ("user_id");
--> statement-breakpoint
CREATE TABLE "assistants" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"personality" text,
	"behavior" text,
	"model" text,
	"reasoning" text,
	"session_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"archived_at" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "assistants_session" ON "assistants" ("session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "assistants_workspace" ON "assistants" ("org_id","owner_type","owner_id");
--> statement-breakpoint
CREATE INDEX "assistants_owner" ON "assistants" ("org_id","owner_type","owner_id");
--> statement-breakpoint
CREATE TABLE "child_watches" (
	"child_session_id" text PRIMARY KEY NOT NULL,
	"queue_item_id" text NOT NULL,
	"parent_session_id" text NOT NULL,
	"parent_thread_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"settled" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"dismissed_at" bigint,
	"settled_at" bigint,
	"sandbox_reclaimed_at" bigint,
	"parked_sandbox_id" text,
	"origin_json" text
);
--> statement-breakpoint
CREATE INDEX "child_watches_parent" ON "child_watches" ("parent_session_id");
--> statement-breakpoint
CREATE INDEX "child_watches_settled" ON "child_watches" ("settled");
--> statement-breakpoint
CREATE INDEX "child_watches_retention" ON "child_watches" ("settled_at") WHERE "settled" = true AND "sandbox_reclaimed_at" IS NULL;
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"urgency" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"href" text,
	"session_id" text,
	"created_at" bigint NOT NULL,
	"read_at" bigint
);
--> statement-breakpoint
CREATE INDEX "notifications_user_read" ON "notifications" ("user_id","read_at");
--> statement-breakpoint
CREATE TABLE "user_notification_preferences" (
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"web" boolean DEFAULT true NOT NULL,
	"team_dm" boolean DEFAULT false NOT NULL,
	PRIMARY KEY("user_id", "kind")
);
--> statement-breakpoint
CREATE TABLE "event_drop_log" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"reason" text NOT NULL,
	"conversation_key" text,
	"event_key" text,
	"event_metadata" jsonb,
	"detail" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "event_drop_log_org" ON "event_drop_log" ("org_id");
--> statement-breakpoint
CREATE INDEX "event_drop_log_page" ON "event_drop_log" ("org_id","created_at","id");
--> statement-breakpoint
CREATE INDEX "event_drop_log_event_key" ON "event_drop_log" ("org_id","event_key","created_at");
--> statement-breakpoint
CREATE TABLE "channel_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"channel_type" text NOT NULL,
	"conversation_key" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"session_id" text NOT NULL,
	"thread_key_template" text NOT NULL,
	"queue_mode" text NOT NULL,
	"trigger_mode" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_bindings_conversation" ON "channel_bindings" ("org_id","channel_type","conversation_key");
--> statement-breakpoint
CREATE TABLE "user_identity_links" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"notify_attention" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_identity_links_provider_external" ON "user_identity_links" ("provider","external_id");
--> statement-breakpoint
CREATE TABLE "identity_link_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "identity_link_codes_provider" ON "identity_link_codes" ("provider","code_hash");
--> statement-breakpoint
-- Open streaming messages, one row per provider stream the api has started
-- and not yet stopped. The engine's `text_delta` plane is ephemeral: it is
-- never appended to the event log and is never replayed. So an api that dies
-- mid-stream cannot reconstruct the text, and the reader is left with a
-- message that shimmers forever. This table is the only durable trace of
-- "a stream is open", and it exists so the next boot can close it.
--
-- Not Slack-specific: any transport that implements the start/append/stop
-- triple gets swept by the same code.
CREATE TABLE "channel_active_streams" (
	"channel_type" text NOT NULL,
	"conversation_key" text NOT NULL,
	"message_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"session_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"engine_message_id" text,
	"org_id" text NOT NULL,
	"started_at" bigint NOT NULL,
	CONSTRAINT "channel_active_streams_pk" PRIMARY KEY("channel_type","conversation_key","message_id")
);
--> statement-breakpoint
CREATE INDEX "channel_active_streams_started" ON "channel_active_streams" ("started_at");
--> statement-breakpoint
CREATE TABLE "memory_files" (
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"path" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" text NOT NULL,
	"type" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"tags" text DEFAULT '[]' NOT NULL,
	"resource" text DEFAULT '' NOT NULL,
	"extras" text DEFAULT '{}' NOT NULL,
	"sensitivity" text DEFAULT 'private' NOT NULL,
	"origin" text DEFAULT '' NOT NULL,
	"expires" bigint,
	"pinned" boolean DEFAULT false NOT NULL,
	"actor_user_id" text DEFAULT '' NOT NULL,
	"source_session_id" text DEFAULT '' NOT NULL,
	"org_id" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	-- Repository mirror bookkeeping. A row with a `source_id` mirrors one file
	-- under `.valet/memory/` and lands under `lib/`, which `assertWritablePath`
	-- already reserves for mounted libraries, so the product refuses to write
	-- it without a new guard. NOT `origin` above, which is OKF provenance of
	-- the fact and is already spent.
	"source_id" text,
	"upstream_path" text,
	"content_sha" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	PRIMARY KEY("owner_type", "owner_id", "path")
);
--> statement-breakpoint
-- `search_vector` generated column (spec decision 9): weighted tsvector,
-- computed automatically by Postgres on every INSERT/UPDATE — the manual
-- fts5-sync helper (`syncFts` in services/memory.ts) is deleted in Task 9,
-- which ports the memory service off this manual sync onto this column.
-- Weights: A=title, B=description, C=path+tags (concatenated as text — see
-- the "tags stays text" note in schema/index.pg.ts), D=content. `path` gets
-- its own weight class (C, shared with tags) rather than collapsing into
-- `content`'s class (D) — a path-term match must rank above a body mention,
-- matching bm25's old per-column weights (path 5, content 1) which never
-- shared a class either.
-- `path`/`tags` are run through `regexp_replace(..., '[^a-zA-Z0-9]+', ' ', 'g')`
-- before `to_tsvector` — without it, Postgres's parser classifies a
-- slash-containing string like `instruments/xylophone/setup.md` as a single
-- "file"-type token (`'instruments/xylophone/setup.md':2C`, verified by
-- inspecting the raw tsvector in a scratch PGlite instance) instead of
-- splitting it into searchable words, so a path-term query would never
-- match at all. The regexp explodes both path segments and the
-- `tags` column's JSON-array punctuation (`["a","b"]`) into space-separated
-- words the parser tokenizes normally.
ALTER TABLE "memory_files" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (
	setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
	setweight(to_tsvector('english', coalesce("description", '')), 'B') ||
	setweight(to_tsvector('english', regexp_replace(coalesce("path", '') || ' ' || coalesce("tags", ''), '[^a-zA-Z0-9]+', ' ', 'g')), 'C') ||
	setweight(to_tsvector('english', coalesce("content", '')), 'D')
) STORED;
--> statement-breakpoint
CREATE INDEX "memory_files_search_vector_idx" ON "memory_files" USING gin ("search_vector");
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"org_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"source_session_id" text DEFAULT '' NOT NULL,
	"source_thread_id" text,
	"source_memory_path" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" text NOT NULL,
	"format" text DEFAULT 'markdown' NOT NULL,
	"rendered" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT '' NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"shared_version" bigint,
	"visibility" text DEFAULT 'org' NOT NULL,
	"public_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"revoked_at" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_token_unique" ON "artifacts" ("token");
--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_owner_path_unique" ON "artifacts" ("owner_type","owner_id","source_memory_path");
--> statement-breakpoint
CREATE TABLE "artifact_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"version" bigint NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"format" text DEFAULT 'markdown' NOT NULL,
	"content" text NOT NULL,
	"rendered" text DEFAULT '' NOT NULL,
	"actor_user_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_versions_unique" ON "artifact_versions" ("artifact_id","version");
--> statement-breakpoint
CREATE TABLE "artifact_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"version" bigint NOT NULL,
	"vdid" text,
	"parent_id" text,
	"body" text NOT NULL,
	"author_user_id" text NOT NULL,
	"sent_to_session" text,
	"resolved_at" bigint,
	"resolved_by" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "artifact_comments_artifact" ON "artifact_comments" ("artifact_id");
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"origin" text NOT NULL,
	"source_id" text,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"frontmatter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_sha" text NOT NULL,
	"upstream_path" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "skills_owner" ON "skills" ("org_id","owner_type","owner_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "skills_owner_name" ON "skills" ("org_id","owner_type","owner_id","name");
--> statement-breakpoint
CREATE TABLE "skill_invocations" (
  "id" text PRIMARY KEY NOT NULL,
  "created_at" bigint NOT NULL,
  "org_id" text NOT NULL,
  "session_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "invoker_user_id" text,
  "invocation_entry_id" text,
  "path" text NOT NULL,
  "skill_key" text NOT NULL,
  "skill_name" text NOT NULL,
  "stored_skill_id" text,
  "plugin_name" text,
  "origin" text NOT NULL,
  "content_sha" text NOT NULL,
  "injected_characters" integer NOT NULL,
  "estimated_body_tokens" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "skill_invocations_org_created" ON "skill_invocations" ("org_id","created_at");
--> statement-breakpoint
CREATE INDEX "skill_invocations_session_thread_created" ON "skill_invocations" ("session_id","thread_id","created_at");
--> statement-breakpoint
CREATE INDEX "skill_invocations_skill_created" ON "skill_invocations" ("skill_key","created_at");
--> statement-breakpoint
CREATE TABLE "skill_context_attributions" (
  "skill_invocation_id" text NOT NULL,
  "llm_request_id" text NOT NULL,
  "session_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "created_at" bigint NOT NULL,
  "estimated_skill_tokens" integer NOT NULL,
  CONSTRAINT "skill_context_attributions_skill_invocation_id_llm_request_id_pk"
    PRIMARY KEY("skill_invocation_id","llm_request_id")
);
--> statement-breakpoint
CREATE TABLE "skill_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"created_by" text,
	"repo_full_name" text NOT NULL,
	"ref" text DEFAULT '' NOT NULL,
	"subpath" text DEFAULT '' NOT NULL,
	"kinds" jsonb DEFAULT '["skills"]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint NOT NULL,
	"last_sha" text,
	"last_manifest_hash" text,
	"discovery_scan" text,
	"sync_revision" bigint DEFAULT 0 NOT NULL,
	"last_synced_at" bigint,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "skill_sources_owner" ON "skill_sources" ("org_id","owner_type","owner_id");
--> statement-breakpoint
CREATE INDEX "skill_sources_due" ON "skill_sources" ("enabled","next_attempt_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "skill_sources_repo" ON "skill_sources" ("org_id","owner_type","owner_id","repo_full_name","subpath");
--> statement-breakpoint
CREATE TABLE "workflow_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	-- Repository mirror columns. A `repo` row is the mirror of one workflow
	-- file and is read-only in the product: editing the file is the edit, and
	-- deleting the file is the delete. Identity is (source_id, upstream_path)
	-- and nothing else, so a rename deletes one workflow and creates another.
	"origin" text DEFAULT 'local' NOT NULL,
	"source_id" text,
	"upstream_path" text,
	"content_sha" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workflow_definitions_owner" ON "workflow_definitions" ("org_id","owner_type","owner_id");--> statement-breakpoint
-- One mirrored row per file per source. Partial, because a `local` row has
-- no source and no path, and NULLs would not collide anyway.
CREATE UNIQUE INDEX "workflow_definitions_source_path" ON "workflow_definitions" ("source_id","upstream_path") WHERE "source_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "workflow_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	-- Which write produced this version, and from which commit. Both NULL on
	-- every version a product edit wrote, and on every row older than the
	-- repository mirror.
	"origin" text,
	"source_commit" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_wf_version" ON "workflow_versions" ("workflow_id","version");
--> statement-breakpoint
-- Templates mirrored from a repository. A row is a copy of one template
-- file; installing it produces an ordinary local workflow, which is the
-- difference between this table and `workflow_definitions`.
CREATE TABLE "workflow_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	-- The id the FILE declares, which the gallery and the install route use.
	-- Distinct from `id`, which is this row.
	"template_id" text NOT NULL,
	"origin" text DEFAULT 'local' NOT NULL,
	"source_id" text,
	"upstream_path" text NOT NULL,
	"content_sha" text,
	"template" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
-- One template id per owner: the gallery lists by id, and two rows claiming
-- one id would make which one installs undefined.
CREATE UNIQUE INDEX "workflow_templates_owner_template" ON "workflow_templates" ("org_id","owner_type","owner_id","template_id");
--> statement-breakpoint
-- One mirrored row per file per source. Partial, matching the definitions
-- table: a local row has no source.
CREATE UNIQUE INDEX "workflow_templates_source_path" ON "workflow_templates" ("source_id","upstream_path") WHERE "source_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"definition_version_id" text NOT NULL,
	"definition" jsonb NOT NULL,
	"params" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"outcome" text,
	"waiting_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"wake_at" bigint,
	"wake_requested" boolean DEFAULT false NOT NULL,
	"lease_owner_id" text,
	"lease_expires_at" bigint,
	"attempt" integer DEFAULT 0 NOT NULL,
	"owner_type" text DEFAULT 'user' NOT NULL,
	"owner_id" text DEFAULT '' NOT NULL,
	"actor_user_id" text,
	"sandbox_reclaimed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workflow_runs_status_updated" ON "workflow_runs" ("status","updated_at");
--> statement-breakpoint
CREATE INDEX "workflow_runs_workflow" ON "workflow_runs" ("workflow_id");
--> statement-breakpoint
CREATE TABLE "workflow_checkpoints" (
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"iteration" integer DEFAULT 0 NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"effects" jsonb,
	"error" text,
	"created_at" bigint NOT NULL,
	PRIMARY KEY("run_id", "node_id", "iteration")
);
--> statement-breakpoint
CREATE INDEX "workflow_checkpoints_run" ON "workflow_checkpoints" ("run_id");
--> statement-breakpoint
CREATE TABLE "workflow_signals" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
	"run_id" text NOT NULL,
	"signal_id" text NOT NULL,
	"signal_type" text NOT NULL,
	"payload" jsonb,
	"created_at" bigint NOT NULL,
	"consumed_at" bigint,
	"consumed_by" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_signals_run_signal" ON "workflow_signals" ("run_id","signal_id");
--> statement-breakpoint
CREATE INDEX "workflow_signals_run" ON "workflow_signals" ("run_id");
--> statement-breakpoint
CREATE TABLE "credentials" (
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"service" text NOT NULL,
	"type" text NOT NULL,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"api_key_enc" text,
	"expires_at" bigint,
	"scopes" jsonb,
	"metadata" jsonb,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	PRIMARY KEY("owner_type", "owner_id", "service")
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_clients" (
	"service" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_enc" text,
	"authorization_endpoint" text NOT NULL,
	"token_endpoint" text NOT NULL,
	"registration_endpoint" text,
	"registered_scopes" jsonb,
	"scopes_supported" jsonb,
	"metadata" jsonb,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"service" text,
	"action_id" text,
	"risk_level" text,
	"mode" text NOT NULL,
	"param_matchers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"applies_in" text DEFAULT 'any' NOT NULL,
	"origin" text NOT NULL,
	"managed_by" text,
	"expires_at" bigint,
	"revoked_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "action_policies_one_of_target" CHECK ((("service" IS NOT NULL)::int + ("action_id" IS NOT NULL)::int + ("risk_level" IS NOT NULL)::int) = 1)
);
--> statement-breakpoint
CREATE INDEX "action_policies_org_revoked" ON "action_policies" ("org_id","revoked_at");
--> statement-breakpoint
CREATE TABLE "runtime_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"session_id" text,
	"workflow_execution_id" text,
	"policy_key" text NOT NULL,
	"mode" text DEFAULT 'allow' NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"revoked_at" bigint,
	CONSTRAINT "runtime_grants_one_of_scope" CHECK ((("session_id" IS NOT NULL)::int + ("workflow_execution_id" IS NOT NULL)::int) = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_grants_session_policy_key" ON "runtime_grants" ("org_id","session_id","policy_key") WHERE "session_id" IS NOT NULL AND "revoked_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_grants_execution_policy_key" ON "runtime_grants" ("org_id","workflow_execution_id","policy_key") WHERE "workflow_execution_id" IS NOT NULL AND "revoked_at" IS NULL;
--> statement-breakpoint
CREATE TABLE "action_policy_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"service" text,
	"action_id" text,
	"risk_level" text,
	"mode" text NOT NULL,
	"param_matchers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "action_policy_overrides_one_of_target" CHECK ((("service" IS NOT NULL)::int + ("action_id" IS NOT NULL)::int + ("risk_level" IS NOT NULL)::int) = 1)
);
--> statement-breakpoint
CREATE INDEX "action_policy_overrides_org_user" ON "action_policy_overrides" ("org_id","user_id");
--> statement-breakpoint
CREATE TABLE "action_invocations" (
	"invocation_id" text PRIMARY KEY NOT NULL,
	"result" jsonb,
	"result_truncated" boolean,
	"created_at" bigint NOT NULL,
	"service" text,
	"action_id" text,
	"risk_level" text,
	"resolved_mode" text,
	"base_mode" text,
	"matched_policy_id" text,
	"matched_grant_id" text,
	"matched_override_id" text,
	"status" text,
	"session_id" text,
	"workflow_execution_id" text,
	"user_id" text,
	"org_id" text,
	"params" jsonb,
	"params_truncated" boolean,
	"duration_ms" bigint,
	"error" text,
	"started_at" bigint,
	"resolved_by" text
);
--> statement-breakpoint
CREATE INDEX "action_invocations_session" ON "action_invocations" ("session_id");
--> statement-breakpoint
CREATE INDEX "action_invocations_org_created" ON "action_invocations" ("org_id","created_at");
--> statement-breakpoint
CREATE TABLE "llm_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "llm_providers_org" ON "llm_providers" ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "llm_providers_org_kind_singleton" ON "llm_providers" ("org_id","kind") WHERE "kind" <> 'openai_compatible';
--> statement-breakpoint
CREATE TABLE "model_registry_cache" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"etag" text,
	"last_modified" bigint,
	"checked_at" bigint,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_repos" (
	"session_id" text NOT NULL,
	"host" text DEFAULT 'github' NOT NULL,
	"full_name" text NOT NULL,
	"clone_url" text NOT NULL,
	"ref" text,
	"resolved_ref" text,
	"auth" text DEFAULT 'auto' NOT NULL,
	"position" integer NOT NULL,
	"target_dir" text
);
--> statement-breakpoint
CREATE INDEX "session_repos_session" ON "session_repos" ("session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "session_repos_session_position" ON "session_repos" ("session_id","position");
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"installation_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"repository_selection" text,
	"suspended" boolean DEFAULT false NOT NULL,
	"linked_user_id" text,
	"cached_token" text,
	"cached_token_expires_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_installations_org_installation" ON "github_installations" ("org_id","installation_id");
--> statement-breakpoint
CREATE INDEX "github_installations_org_account" ON "github_installations" ("org_id","account_login");
--> statement-breakpoint
CREATE TABLE "image_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL CHECK (kind IN ('external','base','repo')),
	"parent_id" text REFERENCES image_sources(id),
	"name" text NOT NULL,
	"external_ref" text,
	"pull_secret_name" text,
	"setup_commands" jsonb,
	"profile" text CHECK (profile IS NULL OR profile IN ('headless','full')),
	"repo_host" text,
	"repo_full_name" text,
	"clone_url" text,
	"sandbox_resources" jsonb,
	"schedule" text NOT NULL DEFAULT 'nightly' CHECK (schedule IN ('nightly','off')),
	"enabled" boolean NOT NULL DEFAULT TRUE,
	"last_bound_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "image_sources_org_repo" ON "image_sources" ("org_id","repo_host","repo_full_name") WHERE kind = 'repo';
--> statement-breakpoint
CREATE UNIQUE INDEX "image_sources_org_base_profile" ON "image_sources" ("org_id","profile") WHERE kind = 'base';
--> statement-breakpoint
CREATE TABLE "bakes" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL REFERENCES image_sources(id) ON DELETE CASCADE,
	"identity_hash" text NOT NULL,
	"commit_sha" text,
	"image_ref" text NOT NULL,
	"status" text NOT NULL CHECK (status IN ('queued','building','pushed','failed')),
	"builder_backend" text,
	"recipe" jsonb,
	"error" text,
	"log_tail" text,
	"started_at" bigint,
	"finished_at" bigint,
	"size_bytes" BIGINT,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "bakes_source_status_created" ON "bakes" ("source_id","status","created_at");
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"service" text NOT NULL,
	"event_key" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"actor" jsonb,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" bigint NOT NULL,
	"received_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "events_service_dedupe" ON "events" ("service","dedupe_key");
--> statement-breakpoint
CREATE INDEX "events_org_received" ON "events" ("org_id","received_at");
--> statement-breakpoint
CREATE INDEX "events_org_key" ON "events" ("org_id","event_key");
--> statement-breakpoint
CREATE TABLE "event_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"event_keys" jsonb NOT NULL,
	"filters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"target" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	-- Who may invoke a team assistant by mention: 'team' (the owning team's
	-- current members) or 'organization' (any current member of the
	-- organization). NULL reads as 'team', so every row written before this
	-- column keeps its meaning. Only a team assistant target may set it.
	"audience" text,
	-- `repo` rows are armed from a mirrored workflow file. The sync updates
	-- and deletes only these, so a trigger a person armed on the same
	-- workflow is never touched.
	"origin" text DEFAULT 'local' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "event_subscriptions_org_enabled" ON "event_subscriptions" ("org_id","enabled");
--> statement-breakpoint
CREATE TABLE "followed_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"channel_type" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_activity_at" bigint NOT NULL,
	"last_seen_ts" text,
	-- The mention rule that bound this thread. The follow router reads that
	-- rule's CURRENT invocation audience, so a rule narrowed back to the team
	-- narrows the threads it opened, and a disabled or deleted rule narrows
	-- them too. NULL, like a rule that is gone, reads as team-only.
	"subscription_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "followed_threads_key" ON "followed_threads" ("org_id","channel_type","channel_id","thread_ts");
--> statement-breakpoint
CREATE TABLE "workflow_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_type" text DEFAULT 'user' NOT NULL,
	"owner_id" text NOT NULL,
	"target_kind" text DEFAULT 'workflow' NOT NULL,
	"workflow_id" text,
	"prompt" text,
	"name" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"input" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	-- `repo` rows are armed from a mirrored workflow file. The sync updates
	-- and deletes only these, so a schedule a person armed on the same
	-- workflow is never touched.
	"origin" text DEFAULT 'local' NOT NULL,
	"last_fired_at" bigint,
	"next_fire_at" bigint NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workflow_schedules_due" ON "workflow_schedules" ("enabled","next_fire_at");
--> statement-breakpoint
CREATE INDEX "workflow_schedules_workflow" ON "workflow_schedules" ("workflow_id");
--> statement-breakpoint
CREATE TABLE "workflow_webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"org_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_webhooks_workflow" ON "workflow_webhooks" ("workflow_id");
--> statement-breakpoint
CREATE TABLE "event_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint NOT NULL,
	"last_error" text,
	"delivered_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "event_deliveries_due" ON "event_deliveries" ("status","next_attempt_at");
--> statement-breakpoint
CREATE INDEX "event_deliveries_event" ON "event_deliveries" ("event_id");
--> statement-breakpoint
CREATE TABLE "linear_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"workspace_name" text NOT NULL,
	"webhook_id" text,
	"connected_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "linear_installations_org_workspace" ON "linear_installations" ("org_id","workspace_id");
--> statement-breakpoint
CREATE TABLE "llm_proxy_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" bigint NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"team_id" text,
	"api_key_id" text NOT NULL,
	"provider_kind" text NOT NULL,
	"model" text,
	"harness" text,
	"endpoint" text NOT NULL,
	"provider_response_id" text,
	"previous_response_id" text,
	"stream" boolean NOT NULL,
	"status_code" integer NOT NULL,
	"request_body" text NOT NULL,
	"response_body" text,
	"input_tokens" bigint NOT NULL DEFAULT 0,
	"output_tokens" bigint NOT NULL DEFAULT 0,
	"cache_read_tokens" bigint NOT NULL DEFAULT 0,
	"cache_write_tokens" bigint NOT NULL DEFAULT 0,
	"total_tokens" bigint NOT NULL DEFAULT 0,
	"cost_usd" double precision,
	"latency_ms" integer,
	"error" text,
	"parsed" jsonb,
	"parse_version" integer,
	"parse_error" text
);
--> statement-breakpoint
CREATE INDEX "llm_proxy_requests_org_created" ON "llm_proxy_requests" ("org_id", "created_at");
--> statement-breakpoint
CREATE INDEX "llm_proxy_requests_user_created" ON "llm_proxy_requests" ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX "llm_proxy_requests_team_created" ON "llm_proxy_requests" ("team_id", "created_at");
--> statement-breakpoint
-- ── Plugin store (docs/specs/2026-08-29-plugin-store-design.md) ───────────
--
-- One core table for plugin-owned persistence, so a plugin persists config,
-- settings, and moderate collections with zero further migrations. `plugin`
-- is the owning plugin's name ("valet" for core-owned data); a scoped view
-- never crosses plugins. `doc` is opaque jsonb the plugin validates itself.
CREATE TABLE "plugin_store" (
	"id" text PRIMARY KEY NOT NULL,
	"plugin" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"collection" text NOT NULL,
	"key" text NOT NULL,
	"doc" jsonb NOT NULL,
	"revision" integer NOT NULL DEFAULT 1,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_store_identity_unique" ON "plugin_store" ("plugin","scope_type","scope_id","collection","key");
--> statement-breakpoint
CREATE INDEX "plugin_store_list" ON "plugin_store" ("plugin","scope_type","scope_id","collection");
--> statement-breakpoint
CREATE INDEX "plugin_store_doc_gin" ON "plugin_store" USING gin ("doc");
--> statement-breakpoint
-- ── Valet Security (docs/specs/2026-08-27-valet-security-design.md) ───────
--
-- One security engagement per kind='security' session. Cells dispatch
-- persona child sessions; the engagement tree (security_files) is the
-- personas' shared virtual filesystem, append-only by (path, revision).
CREATE TABLE "security_engagements" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"status" text DEFAULT 'planning' NOT NULL,
	"repo_full_name" text NOT NULL,
	"repo_ref" text DEFAULT '' NOT NULL,
	"plan" text DEFAULT '' NOT NULL,
	"parent_engagement_id" text,
	"base_ref" text,
	"changed_paths" text,
	"focus" text,
	"invariants" text,
	"categories" text,
	"config_personas" text,
	"config_persona_markdown" text,
	"config_tools" text,
	"authorized_scope" text,
	"has_repo_config" boolean DEFAULT false NOT NULL,
	"report_markdown" text,
	"report_json" text,
	"report_generated_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "security_engagements_session_unique" ON "security_engagements" ("session_id");
--> statement-breakpoint
CREATE INDEX "security_engagements_parent" ON "security_engagements" ("parent_engagement_id");
--> statement-breakpoint
CREATE TABLE "security_cells" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"persona" text NOT NULL,
	"mode" text DEFAULT 'fresh' NOT NULL,
	"goal" text NOT NULL,
	"dir" text NOT NULL,
	"reads" text DEFAULT '[]' NOT NULL,
	"review" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"compacted_at" bigint,
	"child_session_id" text,
	"dispatched_at" bigint,
	"settled_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "security_cells_engagement_ordinal_unique" ON "security_cells" ("engagement_id", "ordinal");
--> statement-breakpoint
CREATE INDEX "security_cells_child_session" ON "security_cells" ("child_session_id");
--> statement-breakpoint
CREATE TABLE "security_files" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"cell_id" text NOT NULL,
	"path" text NOT NULL,
	"revision" integer NOT NULL,
	"content" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "security_files_path_revision_unique" ON "security_files" ("engagement_id", "path", "revision");
--> statement-breakpoint
CREATE TABLE "security_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"cell_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"file" text,
	"line" integer,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"status_reason" text,
	"status_actor" text,
	"recurring" boolean DEFAULT false NOT NULL,
	"carried_from_finding_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "security_findings_engagement" ON "security_findings" ("engagement_id");
--> statement-breakpoint
CREATE TABLE "security_finding_links" (
	"id" text PRIMARY KEY NOT NULL,
	"finding_id" text NOT NULL,
	"engagement_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "security_finding_links_provider_unique" ON "security_finding_links" ("finding_id", "provider");
--> statement-breakpoint
-- One row per sec_handoff spawn: the fix session opened from a finding.
-- No unique constraint — a finding may spawn several fix sessions.
CREATE TABLE "security_handoffs" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"finding_id" text NOT NULL,
	"child_session_id" text NOT NULL,
	"title" text NOT NULL,
	"task" text,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "security_handoffs_engagement" ON "security_handoffs" ("engagement_id");
--> statement-breakpoint
CREATE INDEX "security_handoffs_finding" ON "security_handoffs" ("finding_id");
--> statement-breakpoint
-- One row per human note on a finding (spec §Re-scan / iterate). No unique
-- constraint — a finding may carry a thread of many comments. author_user_id
-- is always a user id: commenting is a human action, never the runner's.
CREATE TABLE "security_finding_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"finding_id" text NOT NULL,
	"engagement_id" text NOT NULL,
	"body" text NOT NULL,
	"author_user_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "security_finding_comments_finding" ON "security_finding_comments" ("finding_id");
--> statement-breakpoint
CREATE INDEX "security_finding_comments_engagement" ON "security_finding_comments" ("engagement_id");
--> statement-breakpoint
-- One row per coverage claim a persona records (NOT_ASSESSED ledger, M-P2d).
-- status is 'assessed' or 'not_assessed'; a not_assessed row carries a reason
-- naming the consequence. No unique constraint — a cell records one row per
-- area. The close manifest rolls these into a coverage summary + gap list.
CREATE TABLE "security_coverage" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"cell_id" text NOT NULL,
	"area" text NOT NULL,
	"status" text NOT NULL,
	"tool" text,
	"reason" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "security_coverage_engagement" ON "security_coverage" ("engagement_id");
--> statement-breakpoint
CREATE INDEX "security_coverage_cell" ON "security_coverage" ("cell_id");
--> statement-breakpoint
-- One row per need a persona records (pivot-coordinator + needs loop, M-P4c).
-- kind classes what is blocked; status tracks it through the loop
-- (open -> auto_resolved | needs_human -> answered | dismissed); resolution
-- records the auto-resolution note or the human answer. No unique constraint —
-- a cell may record several needs. The coordinator auto-resolves only
-- already-authorized items; the rest surface to the human, then re-run.
CREATE TABLE "security_needs" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"cell_id" text NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"created_at" bigint NOT NULL,
	"resolved_at" bigint
);
--> statement-breakpoint
CREATE INDEX "security_needs_engagement" ON "security_needs" ("engagement_id");
--> statement-breakpoint
CREATE INDEX "security_needs_cell" ON "security_needs" ("cell_id");
--> statement-breakpoint
-- ── cost_entries ──────────────────────────────────────────────────────────
--
-- One row per billable assistant turn, with the owner resolved. This is the
-- ONLY definition of cost attribution: Grafana queries this view directly
-- and `/api/usage/summary` aggregates the same columns, so the dashboard and
-- the in-app card cannot disagree.
--
-- It reads `engine_entries` (engine schema), so `applyAppMigrations` applies
-- the engine schema first — see `packages/api/src/lib/drizzle.ts`.
--
-- Owner resolution covers the two session kinds that produce turns:
--
--   1. Interactive, orchestrator, and child sessions have an `agent_sessions`
--      row that carries `org_id` + `user_id` directly.
--   2. Workflow sessions have NO `agent_sessions` row (they belong to
--      `workflow_runs`, not the sessions UI). Their id is
--      `wf:{runId}:{nodeId}`, or `wf:{runId}:{nodeId}:{iteration}` inside a
--      foreach body, so position 2 holds the run id in both shapes.
--      `workflow_runs` has no `org_id` column, so the org comes from the
--      parent `workflow_definitions` row.
--
-- An entry that resolves to no org is EXCLUDED. A row with an unknown org
-- could not be scoped to a tenant, and `wf:invoke:{invocationId}` (the
-- action-invocation context id) matches no run.
--
-- `user_id` is the individual to bill. A team-owned or org-owned workflow run
-- has no acting user, so `user_id` is NULL there and `owner_type`/`owner_id`
-- carry the principal instead. Such rows count toward org totals and are
-- absent from per-user totals.
--
-- `cost_total` NULL means UNPRICED, never free: the engine omits cost for
-- custom/OpenRouter providers and dev fakes rather than writing 0. Read
-- `priced` before you read `cost_total` as a complete number.
CREATE VIEW "cost_entries" AS
SELECT
	e."id"                                                     AS "entry_id",
	e."session_id"                                             AS "session_id",
	e."created_at"                                             AS "created_at",
	e."model"                                                  AS "model",
	COALESCE(s."org_id", d."org_id")                           AS "org_id",
	CASE
		WHEN s."id" IS NOT NULL THEN s."user_id"
		WHEN r."owner_type" = 'user' THEN NULLIF(r."owner_id", '')
	END                                                        AS "user_id",
	COALESCE(s."owner_type", r."owner_type")                   AS "owner_type",
	NULLIF(COALESCE(s."owner_id", r."owner_id"), '')           AS "owner_id",
	r."workflow_id"                                            AS "workflow_id",
	r."id"                                                     AS "workflow_run_id",
	COALESCE((e."usage"::jsonb->>'input')::bigint, 0)          AS "input_tokens",
	COALESCE((e."usage"::jsonb->>'output')::bigint, 0)         AS "output_tokens",
	COALESCE((e."usage"::jsonb->>'cacheRead')::bigint, 0)      AS "cache_read_tokens",
	COALESCE((e."usage"::jsonb->>'cacheWrite')::bigint, 0)     AS "cache_write_tokens",
	COALESCE((e."usage"::jsonb->>'total')::bigint, 0)          AS "total_tokens",
	(e."cost"::jsonb->>'total')::float8                        AS "cost_total",
	((e."cost"::jsonb->>'total') IS NOT NULL)                  AS "priced",
	-- Valet use case, derived from the session id shape so the one cost
	-- definition can be broken down by activity kind (usage dashboard).
	CASE
		WHEN e."session_id" LIKE 'orchestrator:%' THEN 'orchestrator'
		WHEN e."session_id" LIKE 'wf:%'           THEN 'workflow'
		ELSE 'session'
	END                                                        AS "use_case",
	NULL::text                                                  AS "provider"
FROM "engine_entries" e
LEFT JOIN "agent_sessions" s
	ON s."id" = e."session_id"
LEFT JOIN "workflow_runs" r
	ON e."session_id" LIKE 'wf:%'
	AND r."id" = split_part(e."session_id", ':', 2)
LEFT JOIN "workflow_definitions" d
	ON d."id" = r."workflow_id"
WHERE e."usage" IS NOT NULL
	AND COALESCE(s."org_id", d."org_id") IS NOT NULL
UNION ALL
SELECT
	p."id" AS "entry_id", NULL AS "session_id", p."created_at" AS "created_at", p."model" AS "model",
	p."org_id" AS "org_id", p."user_id" AS "user_id",
        CASE WHEN p."team_id" IS NOT NULL THEN 'team' ELSE 'user' END AS "owner_type",
        COALESCE(p."team_id", p."user_id") AS "owner_id",
	NULL AS "workflow_id", NULL AS "workflow_run_id",
	p."input_tokens", p."output_tokens", p."cache_read_tokens", p."cache_write_tokens", p."total_tokens",
	p."cost_usd" AS "cost_total", (p."cost_usd" IS NOT NULL) AS "priced", 'proxy' AS "use_case", p."provider_kind" AS "provider"
FROM "llm_proxy_requests" p
-- Only rows that carry usage count as billable turns — mirrors the engine
-- side's `WHERE e."usage" IS NOT NULL`. Excludes failed/4xx proxy calls and
-- non-completion passthroughs (0 tokens), which would otherwise inflate
-- `/api/usage` turn counts.
WHERE p."total_tokens" > 0;
--> statement-breakpoint
CREATE TABLE "ratings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"session_id" text NOT NULL,
	"thread_id" text,
	"rating" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ratings_user_target" ON "ratings" ("user_id","target_type","target_id");
--> statement-breakpoint
CREATE INDEX "ratings_session" ON "ratings" ("session_id");
--> statement-breakpoint
CREATE INDEX "ratings_type_rating" ON "ratings" ("target_type","rating");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_deletion_requests" (
  "id" text PRIMARY KEY NOT NULL, "org_id" text NOT NULL, "team_id" text NOT NULL,
  "resource_type" text NOT NULL, "resource_id" text NOT NULL, "resource_label" text NOT NULL,
  "requested_by" text NOT NULL, "reason" text, "requested_at" bigint NOT NULL,
  "expires_at" bigint NOT NULL, "status" text NOT NULL DEFAULT 'pending',
  "decided_by" text, "decided_at" bigint, "decision_note" text, "last_refusal" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "team_deletion_requests_pending" ON "team_deletion_requests" ("team_id", "resource_type", "resource_id") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_deletion_requests_team_status" ON "team_deletion_requests" ("team_id", "status");

--> statement-breakpoint
-- usage analytics projection v1
DO $migration$
BEGIN
  -- usage analytics install
  -- Fresh databases are empty. Existing databases use the batched repair.
  LOCK TABLE engine_entries IN SHARE ROW EXCLUSIVE MODE;
  CREATE TABLE IF NOT EXISTS usage_entry_facts (
    entry_id text PRIMARY KEY REFERENCES engine_entries(id) ON DELETE CASCADE,
    session_id text NOT NULL,
    workflow_run_id text,
    created_at bigint NOT NULL,
    model text,
    usage jsonb,
    cost jsonb,
    tool_calls bigint NOT NULL,
    pull_requests bigint NOT NULL,
    reviews bigint NOT NULL,
    hourly_accounted boolean NOT NULL DEFAULT false
  );
  ALTER TABLE usage_entry_facts ADD COLUMN IF NOT EXISTS hourly_accounted boolean NOT NULL DEFAULT false;
  CREATE INDEX IF NOT EXISTS usage_entry_facts_window ON usage_entry_facts(created_at, session_id);
  CREATE INDEX IF NOT EXISTS usage_entry_facts_session_window ON usage_entry_facts(session_id, created_at);
  CREATE INDEX IF NOT EXISTS usage_entry_facts_workflow_window ON usage_entry_facts(workflow_run_id, created_at)
    WHERE workflow_run_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS usage_entry_facts_cost_window ON usage_entry_facts(created_at, session_id) WHERE usage IS NOT NULL;
  CREATE INDEX IF NOT EXISTS usage_entry_facts_tools_window ON usage_entry_facts(created_at, session_id) WHERE tool_calls > 0;
  CREATE INDEX IF NOT EXISTS usage_entry_facts_outcomes_window ON usage_entry_facts(created_at, session_id) WHERE pull_requests > 0 OR reviews > 0;

  CREATE OR REPLACE FUNCTION valet_usage_fact(e engine_entries) RETURNS usage_entry_facts
  LANGUAGE sql IMMUTABLE AS $fact$
    SELECT e.id, e.session_id,
      CASE WHEN e.session_id LIKE 'wf:%' THEN split_part(e.session_id, ':', 2) END,
      e.created_at, e.model, e.usage::jsonb, e.cost::jsonb,
      COUNT(*) FILTER (WHERE p->>'type' = 'tool_call' AND p->>'status' IN ('completed', 'error')),
      COUNT(*) FILTER (WHERE p->>'type' = 'tool_call' AND p->>'toolName' = 'bash'
        AND p->>'status' = 'completed' AND p->'result'->'details'->'outcome'->>'kind' = 'pull_request_created'),
      COUNT(*) FILTER (WHERE p->>'type' = 'tool_call' AND p->>'toolName' = 'bash'
        AND p->>'status' = 'completed' AND p->'result'->'details'->'outcome'->>'kind' = 'review_submitted'), false
    FROM jsonb_array_elements(CASE WHEN e.entry_type = 'message' AND e.role = 'assistant'
      THEN COALESCE(replace(e.parts, chr(92) || 'u0000', chr(92) || 'uFFFD')::jsonb, '[]'::jsonb)
      ELSE '[]'::jsonb END) p
  $fact$;

  DROP TRIGGER IF EXISTS engine_entries_usage_fact ON engine_entries;
  CREATE OR REPLACE FUNCTION valet_sync_usage_fact() RETURNS trigger LANGUAGE plpgsql AS $sync$
  BEGIN
    INSERT INTO usage_entry_facts SELECT f.* FROM new_entries e CROSS JOIN LATERAL valet_usage_fact(e) f
    ON CONFLICT (entry_id) DO UPDATE SET
      session_id = EXCLUDED.session_id, workflow_run_id = EXCLUDED.workflow_run_id,
      created_at = EXCLUDED.created_at, model = EXCLUDED.model, usage = EXCLUDED.usage,
      cost = EXCLUDED.cost, tool_calls = EXCLUDED.tool_calls,
      pull_requests = EXCLUDED.pull_requests, reviews = EXCLUDED.reviews;
    RETURN NULL;
  END $sync$;
  CREATE OR REPLACE TRIGGER engine_entries_usage_fact
    AFTER INSERT ON engine_entries REFERENCING NEW TABLE AS new_entries
    FOR EACH STATEMENT EXECUTE FUNCTION valet_sync_usage_fact();
  CREATE OR REPLACE TRIGGER engine_entries_usage_fact_update
    AFTER UPDATE ON engine_entries REFERENCING NEW TABLE AS new_entries
    FOR EACH STATEMENT EXECUTE FUNCTION valet_sync_usage_fact();

  -- usage analytics backfill
  INSERT INTO usage_entry_facts SELECT f.* FROM engine_entries e
    CROSS JOIN LATERAL valet_usage_fact(e) f ON CONFLICT (entry_id) DO NOTHING;

  -- usage analytics publish
  -- Separate ownership branches let PostgreSQL push scope filters into each join.
  CREATE OR REPLACE VIEW usage_entries AS
    SELECT f.entry_id, f.session_id, r.id AS workflow_run_id, f.created_at, f.model, f.usage, f.cost,
      f.tool_calls, f.pull_requests, f.reviews, s.org_id, s.user_id, s.owner_type, NULLIF(s.owner_id, '') AS owner_id,
      r.workflow_id,
      CASE WHEN f.session_id LIKE 'orchestrator:%' THEN 'orchestrator'
        WHEN f.session_id LIKE 'wf:%' THEN 'workflow' ELSE 'session' END AS use_case
    FROM usage_entry_facts f JOIN agent_sessions s ON s.id = f.session_id
    LEFT JOIN workflow_runs r ON r.id = f.workflow_run_id
    UNION ALL
    SELECT f.entry_id, f.session_id, r.id, f.created_at, f.model, f.usage, f.cost,
      f.tool_calls, f.pull_requests, f.reviews, d.org_id, CASE WHEN r.owner_type = 'user' THEN NULLIF(r.owner_id, '') END,
      r.owner_type, NULLIF(r.owner_id, ''), r.workflow_id, 'workflow'::text
    FROM usage_entry_facts f JOIN workflow_runs r ON r.id = f.workflow_run_id
    JOIN workflow_definitions d ON d.id = r.workflow_id
    WHERE NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = f.session_id);

  CREATE OR REPLACE VIEW cost_entries AS
    SELECT entry_id, session_id, created_at, model, org_id, user_id, owner_type, owner_id,
      workflow_id, workflow_run_id,
      COALESCE((usage->>'input')::bigint,0) AS input_tokens,
      COALESCE((usage->>'output')::bigint,0) AS output_tokens,
      COALESCE((usage->>'cacheRead')::bigint,0) AS cache_read_tokens,
      COALESCE((usage->>'cacheWrite')::bigint,0) AS cache_write_tokens,
      COALESCE((usage->>'total')::bigint,0) AS total_tokens,
      (cost->>'total')::float8 AS cost_total, (cost->>'total') IS NOT NULL AS priced,
      use_case, NULL::text AS provider
    FROM usage_entries WHERE usage IS NOT NULL
    UNION ALL
    SELECT id, NULL, created_at, model, org_id, user_id,
      CASE WHEN team_id IS NOT NULL THEN 'team' ELSE 'user' END,
      COALESCE(team_id,user_id), NULL, NULL,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
      cost_usd, cost_usd IS NOT NULL, 'proxy', provider_kind
    FROM llm_proxy_requests p WHERE total_tokens > 0;

  -- usage analytics indexes
  CREATE INDEX IF NOT EXISTS action_invocations_usage_time
    ON action_invocations(org_id, (COALESCE(started_at, created_at)))
    WHERE status IN ('completed', 'error') AND duration_ms IS NOT NULL;
  CREATE INDEX IF NOT EXISTS skill_context_attributions_window
    ON skill_context_attributions(created_at, skill_invocation_id);
  CREATE INDEX IF NOT EXISTS agent_sessions_usage_scope
    ON agent_sessions(org_id, user_id, id);
  CREATE INDEX IF NOT EXISTS skill_invocations_usage_window ON skill_invocations(created_at, session_id);
  CREATE INDEX IF NOT EXISTS action_invocations_outcome_time
    ON action_invocations(org_id, (COALESCE(started_at, created_at)))
    WHERE status = 'completed' AND duration_ms IS NOT NULL
      AND action_id IN ('github.create_pull_request', 'github.create_review', 'slack.send_message',
        'slack.reply_to_origin', 'slack.dm_owner', 'slack.dm_user');
  ANALYZE usage_entry_facts;
END $migration$;

--> statement-breakpoint
DO $hourly$ BEGIN
-- usage hourly install
ALTER TABLE llm_proxy_requests ADD COLUMN IF NOT EXISTS hourly_accounted boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS usage_hourly (
 dimensions jsonb NOT NULL, source_kind text NOT NULL, session_id text,
 org_id text, user_id text, team_id text, model text, provider text, created_at bigint NOT NULL,
 turns bigint NOT NULL,
 unpriced_turns bigint NOT NULL,
 positive_turns bigint NOT NULL,
 input_tokens bigint NOT NULL,
 output_tokens bigint NOT NULL,
 cache_read_tokens bigint NOT NULL,
 cache_write_tokens bigint NOT NULL,
 total_tokens bigint NOT NULL,
 cost_total numeric NOT NULL,
 tool_calls bigint NOT NULL,
 pull_requests bigint NOT NULL,
 reviews bigint NOT NULL, PRIMARY KEY (dimensions,created_at)
);
CREATE TABLE IF NOT EXISTS usage_hourly_progress(source_kind text PRIMARY KEY, watermark text NOT NULL);
INSERT INTO usage_hourly_progress VALUES ('engine',''),('proxy','') ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS usage_hourly_window ON usage_hourly(created_at,session_id);
CREATE INDEX IF NOT EXISTS usage_hourly_session_window ON usage_hourly(session_id,created_at);
CREATE INDEX IF NOT EXISTS usage_hourly_org_window ON usage_hourly(org_id,created_at);

CREATE OR REPLACE FUNCTION valet_entry_hour(e usage_entry_facts) RETURNS usage_hourly LANGUAGE sql IMMUTABLE AS $entry$
 SELECT jsonb_build_array('engine',e.session_id,e.model), 'engine'::text,e.session_id,
 NULL::text,NULL::text,NULL::text,e.model,NULL::text,(floor(e.created_at::numeric/3600000)*3600000)::bigint,
 (e.usage IS NOT NULL)::int::bigint,
 (e.usage IS NOT NULL AND (e.cost->>'total') IS NULL)::int::bigint,
 (e.usage IS NOT NULL AND COALESCE((e.usage->>'total')::bigint,0)>0)::int::bigint,
 COALESCE((e.usage->>'input')::bigint,0),
 COALESCE((e.usage->>'output')::bigint,0),
 COALESCE((e.usage->>'cacheRead')::bigint,0),
 COALESCE((e.usage->>'cacheWrite')::bigint,0),
 COALESCE((e.usage->>'total')::bigint,0), CASE WHEN e.usage IS NOT NULL THEN COALESCE((e.cost->>'total')::numeric,0) ELSE 0 END,
 e.tool_calls,e.pull_requests,e.reviews
$entry$;
CREATE OR REPLACE FUNCTION valet_proxy_hour(p llm_proxy_requests) RETURNS usage_hourly LANGUAGE sql IMMUTABLE AS $proxy$
 SELECT jsonb_build_array('proxy',p.org_id,p.user_id,p.team_id,p.model,p.provider_kind,p.harness), 'proxy'::text,NULL::text,
 p.org_id,p.user_id,p.team_id,p.model,p.provider_kind,(floor(p.created_at::numeric/3600000)*3600000)::bigint,
 (p.total_tokens>0)::int::bigint,(p.total_tokens>0 AND p.cost_usd IS NULL)::int::bigint,0::bigint,
 CASE WHEN p.total_tokens>0 THEN COALESCE(p.input_tokens,0) ELSE 0 END,
 CASE WHEN p.total_tokens>0 THEN COALESCE(p.output_tokens,0) ELSE 0 END,
 CASE WHEN p.total_tokens>0 THEN COALESCE(p.cache_read_tokens,0) ELSE 0 END,
 CASE WHEN p.total_tokens>0 THEN COALESCE(p.cache_write_tokens,0) ELSE 0 END,
 CASE WHEN p.total_tokens>0 THEN COALESCE(p.total_tokens,0) ELSE 0 END,CASE WHEN p.total_tokens>0 THEN COALESCE(p.cost_usd::numeric,0) ELSE 0 END,
 0::bigint,0::bigint,0::bigint
$proxy$;

CREATE OR REPLACE FUNCTION valet_mark_usage_hour() RETURNS trigger LANGUAGE plpgsql AS $mark$
BEGIN
 IF TG_OP <> 'INSERT' AND NOT OLD.hourly_accounted
   AND current_setting('transaction_isolation') <> 'read committed' THEN
  RAISE EXCEPTION 'Usage backfill accounting requires READ COMMITTED. Retry this transaction with READ COMMITTED isolation.'
    USING ERRCODE='40001';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 NEW.hourly_accounted := true; RETURN NEW;
END $mark$;
CREATE INDEX IF NOT EXISTS usage_hourly_empty ON usage_hourly(created_at) WHERE turns=0 AND tool_calls=0 AND pull_requests=0 AND reviews=0;
CREATE INDEX IF NOT EXISTS usage_hourly_outcomes ON usage_hourly(created_at,session_id) WHERE pull_requests>0 OR reviews>0;
DROP TRIGGER IF EXISTS usage_entry_facts_hourly ON usage_entry_facts;
CREATE OR REPLACE TRIGGER usage_entry_facts_hourly_mark BEFORE INSERT OR UPDATE OR DELETE ON usage_entry_facts
 FOR EACH ROW EXECUTE FUNCTION valet_mark_usage_hour();
CREATE OR REPLACE FUNCTION valet_sync_entry_hour_insert() RETURNS trigger LANGUAGE plpgsql AS $sync$
BEGIN
 WITH changes AS MATERIALIZED (SELECT h.*, 1 AS direction FROM new_rows n CROSS JOIN LATERAL valet_entry_hour(n) h), deltas AS (
 SELECT dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,SUM(direction*turns) AS turns,SUM(direction*unpriced_turns) AS unpriced_turns,SUM(direction*positive_turns) AS positive_turns,SUM(direction*input_tokens) AS input_tokens,SUM(direction*output_tokens) AS output_tokens,SUM(direction*cache_read_tokens) AS cache_read_tokens,SUM(direction*cache_write_tokens) AS cache_write_tokens,SUM(direction*total_tokens) AS total_tokens,SUM(direction*cost_total) AS cost_total,SUM(direction*tool_calls) AS tool_calls,SUM(direction*pull_requests) AS pull_requests,SUM(direction*reviews) AS reviews
 FROM changes GROUP BY dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at)
 INSERT INTO usage_hourly(dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,turns,unpriced_turns,positive_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,tool_calls,pull_requests,reviews) SELECT dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,turns,unpriced_turns,positive_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,tool_calls,pull_requests,reviews FROM deltas
 WHERE turns<>0 OR tool_calls<>0 OR pull_requests<>0 OR reviews<>0 OR positive_turns<>0 OR total_tokens<>0 OR cost_total<>0 OR unpriced_turns<>0 OR input_tokens<>0 OR output_tokens<>0 OR cache_read_tokens<>0 OR cache_write_tokens<>0
 ORDER BY dimensions,created_at
 ON CONFLICT(dimensions,created_at) DO UPDATE SET
 turns=usage_hourly.turns+EXCLUDED.turns,
 unpriced_turns=usage_hourly.unpriced_turns+EXCLUDED.unpriced_turns,
 positive_turns=usage_hourly.positive_turns+EXCLUDED.positive_turns,
 input_tokens=usage_hourly.input_tokens+EXCLUDED.input_tokens,
 output_tokens=usage_hourly.output_tokens+EXCLUDED.output_tokens,
 cache_read_tokens=usage_hourly.cache_read_tokens+EXCLUDED.cache_read_tokens,
 cache_write_tokens=usage_hourly.cache_write_tokens+EXCLUDED.cache_write_tokens,
 total_tokens=usage_hourly.total_tokens+EXCLUDED.total_tokens,
 cost_total=usage_hourly.cost_total+EXCLUDED.cost_total,
 tool_calls=usage_hourly.tool_calls+EXCLUDED.tool_calls,
 pull_requests=usage_hourly.pull_requests+EXCLUDED.pull_requests,
 reviews=usage_hourly.reviews+EXCLUDED.reviews;
 DELETE FROM usage_hourly WHERE turns=0 AND tool_calls=0 AND pull_requests=0 AND reviews=0;
 RETURN NULL;
END $sync$;
CREATE OR REPLACE TRIGGER usage_entry_facts_hourly_insert AFTER INSERT ON usage_entry_facts
 REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION valet_sync_entry_hour_insert();
CREATE OR REPLACE FUNCTION valet_sync_entry_hour_update() RETURNS trigger LANGUAGE plpgsql AS $sync$
BEGIN
 WITH changes AS MATERIALIZED (SELECT h.*, -1 AS direction FROM old_rows o CROSS JOIN LATERAL valet_entry_hour(o) h WHERE o.hourly_accounted OR o.entry_id <= (SELECT watermark FROM usage_hourly_progress WHERE source_kind='engine') UNION ALL SELECT h.*, 1 AS direction FROM new_rows n CROSS JOIN LATERAL valet_entry_hour(n) h), deltas AS (
 SELECT dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,SUM(direction*turns) AS turns,SUM(direction*unpriced_turns) AS unpriced_turns,SUM(direction*positive_turns) AS positive_turns,SUM(direction*input_tokens) AS input_tokens,SUM(direction*output_tokens) AS output_tokens,SUM(direction*cache_read_tokens) AS cache_read_tokens,SUM(direction*cache_write_tokens) AS cache_write_tokens,SUM(direction*total_tokens) AS total_tokens,SUM(direction*cost_total) AS cost_total,SUM(direction*tool_calls) AS tool_calls,SUM(direction*pull_requests) AS pull_requests,SUM(direction*reviews) AS reviews
 FROM changes GROUP BY dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at)
 INSERT INTO usage_hourly(dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,turns,unpriced_turns,positive_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,tool_calls,pull_requests,reviews) SELECT dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,turns,unpriced_turns,positive_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,tool_calls,pull_requests,reviews FROM deltas
 WHERE turns<>0 OR tool_calls<>0 OR pull_requests<>0 OR reviews<>0 OR positive_turns<>0 OR total_tokens<>0 OR cost_total<>0 OR unpriced_turns<>0 OR input_tokens<>0 OR output_tokens<>0 OR cache_read_tokens<>0 OR cache_write_tokens<>0
 ORDER BY dimensions,created_at
 ON CONFLICT(dimensions,created_at) DO UPDATE SET
 turns=usage_hourly.turns+EXCLUDED.turns,
 unpriced_turns=usage_hourly.unpriced_turns+EXCLUDED.unpriced_turns,
 positive_turns=usage_hourly.positive_turns+EXCLUDED.positive_turns,
 input_tokens=usage_hourly.input_tokens+EXCLUDED.input_tokens,
 output_tokens=usage_hourly.output_tokens+EXCLUDED.output_tokens,
 cache_read_tokens=usage_hourly.cache_read_tokens+EXCLUDED.cache_read_tokens,
 cache_write_tokens=usage_hourly.cache_write_tokens+EXCLUDED.cache_write_tokens,
 total_tokens=usage_hourly.total_tokens+EXCLUDED.total_tokens,
 cost_total=usage_hourly.cost_total+EXCLUDED.cost_total,
 tool_calls=usage_hourly.tool_calls+EXCLUDED.tool_calls,
 pull_requests=usage_hourly.pull_requests+EXCLUDED.pull_requests,
 reviews=usage_hourly.reviews+EXCLUDED.reviews;
 DELETE FROM usage_hourly WHERE turns=0 AND tool_calls=0 AND pull_requests=0 AND reviews=0;
 RETURN NULL;
END $sync$;
CREATE OR REPLACE TRIGGER usage_entry_facts_hourly_update AFTER UPDATE ON usage_entry_facts
 REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION valet_sync_entry_hour_update();
CREATE OR REPLACE FUNCTION valet_sync_entry_hour_delete() RETURNS trigger LANGUAGE plpgsql AS $sync$
BEGIN
 WITH changes AS MATERIALIZED (SELECT h.*, -1 AS direction FROM old_rows o CROSS JOIN LATERAL valet_entry_hour(o) h WHERE o.hourly_accounted OR o.entry_id <= (SELECT watermark FROM usage_hourly_progress WHERE source_kind='engine')), deltas AS (
 SELECT dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,SUM(direction*turns) AS turns,SUM(direction*unpriced_turns) AS unpriced_turns,SUM(direction*positive_turns) AS positive_turns,SUM(direction*input_tokens) AS input_tokens,SUM(direction*output_tokens) AS output_tokens,SUM(direction*cache_read_tokens) AS cache_read_tokens,SUM(direction*cache_write_tokens) AS cache_write_tokens,SUM(direction*total_tokens) AS total_tokens,SUM(direction*cost_total) AS cost_total,SUM(direction*tool_calls) AS tool_calls,SUM(direction*pull_requests) AS pull_requests,SUM(direction*reviews) AS reviews
 FROM changes GROUP BY dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at)
 INSERT INTO usage_hourly(dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,turns,unpriced_turns,positive_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,tool_calls,pull_requests,reviews) SELECT dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,turns,unpriced_turns,positive_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,tool_calls,pull_requests,reviews FROM deltas
 WHERE turns<>0 OR tool_calls<>0 OR pull_requests<>0 OR reviews<>0 OR positive_turns<>0 OR total_tokens<>0 OR cost_total<>0 OR unpriced_turns<>0 OR input_tokens<>0 OR output_tokens<>0 OR cache_read_tokens<>0 OR cache_write_tokens<>0
 ORDER BY dimensions,created_at
 ON CONFLICT(dimensions,created_at) DO UPDATE SET
 turns=usage_hourly.turns+EXCLUDED.turns,
 unpriced_turns=usage_hourly.unpriced_turns+EXCLUDED.unpriced_turns,
 positive_turns=usage_hourly.positive_turns+EXCLUDED.positive_turns,
 input_tokens=usage_hourly.input_tokens+EXCLUDED.input_tokens,
 output_tokens=usage_hourly.output_tokens+EXCLUDED.output_tokens,
 cache_read_tokens=usage_hourly.cache_read_tokens+EXCLUDED.cache_read_tokens,
 cache_write_tokens=usage_hourly.cache_write_tokens+EXCLUDED.cache_write_tokens,
 total_tokens=usage_hourly.total_tokens+EXCLUDED.total_tokens,
 cost_total=usage_hourly.cost_total+EXCLUDED.cost_total,
 tool_calls=usage_hourly.tool_calls+EXCLUDED.tool_calls,
 pull_requests=usage_hourly.pull_requests+EXCLUDED.pull_requests,
 reviews=usage_hourly.reviews+EXCLUDED.reviews;
 DELETE FROM usage_hourly WHERE turns=0 AND tool_calls=0 AND pull_requests=0 AND reviews=0;
 RETURN NULL;
END $sync$;
CREATE OR REPLACE TRIGGER usage_entry_facts_hourly_delete AFTER DELETE ON usage_entry_facts
 REFERENCING OLD TABLE AS old_rows  FOR EACH STATEMENT EXECUTE FUNCTION valet_sync_entry_hour_delete();
DROP TRIGGER IF EXISTS llm_proxy_requests_hourly ON llm_proxy_requests;
CREATE OR REPLACE TRIGGER llm_proxy_requests_hourly_mark BEFORE INSERT OR UPDATE OR DELETE ON llm_proxy_requests
 FOR EACH ROW EXECUTE FUNCTION valet_mark_usage_hour();
CREATE OR REPLACE FUNCTION valet_sync_proxy_hour_insert() RETURNS trigger LANGUAGE plpgsql AS $sync$
BEGIN
 WITH changes AS MATERIALIZED (SELECT h.*, 1 AS direction FROM new_rows n CROSS JOIN LATERAL valet_proxy_hour(n) h), deltas AS (
 SELECT dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,SUM(direction*turns) AS turns,SUM(direction*unpriced_turns) AS unpriced_turns,SUM(direction*positive_turns) AS positive_turns,SUM(direction*input_tokens) AS input_tokens,SUM(direction*output_tokens) AS output_tokens,SUM(direction*cache_read_tokens) AS cache_read_tokens,SUM(direction*cache_write_tokens) AS cache_write_tokens,SUM(direction*total_tokens) AS total_tokens,SUM(direction*cost_total) AS cost_total,SUM(direction*tool_calls) AS tool_calls,SUM(direction*pull_requests) AS pull_requests,SUM(direction*reviews) AS reviews
 FROM changes GROUP BY dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at)
 INSERT INTO usage_hourly(dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,turns,unpriced_turns,positive_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,tool_calls,pull_requests,reviews) SELECT dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,turns,unpriced_turns,positive_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,tool_calls,pull_requests,reviews FROM deltas
 WHERE turns<>0 OR tool_calls<>0 OR pull_requests<>0 OR reviews<>0 OR positive_turns<>0 OR total_tokens<>0 OR cost_total<>0 OR unpriced_turns<>0 OR input_tokens<>0 OR output_tokens<>0 OR cache_read_tokens<>0 OR cache_write_tokens<>0
 ORDER BY dimensions,created_at
 ON CONFLICT(dimensions,created_at) DO UPDATE SET
 turns=usage_hourly.turns+EXCLUDED.turns,
 unpriced_turns=usage_hourly.unpriced_turns+EXCLUDED.unpriced_turns,
 positive_turns=usage_hourly.positive_turns+EXCLUDED.positive_turns,
 input_tokens=usage_hourly.input_tokens+EXCLUDED.input_tokens,
 output_tokens=usage_hourly.output_tokens+EXCLUDED.output_tokens,
 cache_read_tokens=usage_hourly.cache_read_tokens+EXCLUDED.cache_read_tokens,
 cache_write_tokens=usage_hourly.cache_write_tokens+EXCLUDED.cache_write_tokens,
 total_tokens=usage_hourly.total_tokens+EXCLUDED.total_tokens,
 cost_total=usage_hourly.cost_total+EXCLUDED.cost_total,
 tool_calls=usage_hourly.tool_calls+EXCLUDED.tool_calls,
 pull_requests=usage_hourly.pull_requests+EXCLUDED.pull_requests,
 reviews=usage_hourly.reviews+EXCLUDED.reviews;
 DELETE FROM usage_hourly WHERE turns=0 AND tool_calls=0 AND pull_requests=0 AND reviews=0;
 RETURN NULL;
END $sync$;
CREATE OR REPLACE TRIGGER llm_proxy_requests_hourly_insert AFTER INSERT ON llm_proxy_requests
 REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION valet_sync_proxy_hour_insert();
CREATE OR REPLACE FUNCTION valet_sync_proxy_hour_update() RETURNS trigger LANGUAGE plpgsql AS $sync$
BEGIN
 WITH changes AS MATERIALIZED (SELECT h.*, -1 AS direction FROM old_rows o CROSS JOIN LATERAL valet_proxy_hour(o) h WHERE o.hourly_accounted OR o.id <= (SELECT watermark FROM usage_hourly_progress WHERE source_kind='proxy') UNION ALL SELECT h.*, 1 AS direction FROM new_rows n CROSS JOIN LATERAL valet_proxy_hour(n) h), deltas AS (
 SELECT dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,SUM(direction*turns) AS turns,SUM(direction*unpriced_turns) AS unpriced_turns,SUM(direction*positive_turns) AS positive_turns,SUM(direction*input_tokens) AS input_tokens,SUM(direction*output_tokens) AS output_tokens,SUM(direction*cache_read_tokens) AS cache_read_tokens,SUM(direction*cache_write_tokens) AS cache_write_tokens,SUM(direction*total_tokens) AS total_tokens,SUM(direction*cost_total) AS cost_total,SUM(direction*tool_calls) AS tool_calls,SUM(direction*pull_requests) AS pull_requests,SUM(direction*reviews) AS reviews
 FROM changes GROUP BY dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at)
 INSERT INTO usage_hourly(dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,turns,unpriced_turns,positive_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,tool_calls,pull_requests,reviews) SELECT dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,turns,unpriced_turns,positive_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,tool_calls,pull_requests,reviews FROM deltas
 WHERE turns<>0 OR tool_calls<>0 OR pull_requests<>0 OR reviews<>0 OR positive_turns<>0 OR total_tokens<>0 OR cost_total<>0 OR unpriced_turns<>0 OR input_tokens<>0 OR output_tokens<>0 OR cache_read_tokens<>0 OR cache_write_tokens<>0
 ORDER BY dimensions,created_at
 ON CONFLICT(dimensions,created_at) DO UPDATE SET
 turns=usage_hourly.turns+EXCLUDED.turns,
 unpriced_turns=usage_hourly.unpriced_turns+EXCLUDED.unpriced_turns,
 positive_turns=usage_hourly.positive_turns+EXCLUDED.positive_turns,
 input_tokens=usage_hourly.input_tokens+EXCLUDED.input_tokens,
 output_tokens=usage_hourly.output_tokens+EXCLUDED.output_tokens,
 cache_read_tokens=usage_hourly.cache_read_tokens+EXCLUDED.cache_read_tokens,
 cache_write_tokens=usage_hourly.cache_write_tokens+EXCLUDED.cache_write_tokens,
 total_tokens=usage_hourly.total_tokens+EXCLUDED.total_tokens,
 cost_total=usage_hourly.cost_total+EXCLUDED.cost_total,
 tool_calls=usage_hourly.tool_calls+EXCLUDED.tool_calls,
 pull_requests=usage_hourly.pull_requests+EXCLUDED.pull_requests,
 reviews=usage_hourly.reviews+EXCLUDED.reviews;
 DELETE FROM usage_hourly WHERE turns=0 AND tool_calls=0 AND pull_requests=0 AND reviews=0;
 RETURN NULL;
END $sync$;
CREATE OR REPLACE TRIGGER llm_proxy_requests_hourly_update AFTER UPDATE ON llm_proxy_requests
 REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION valet_sync_proxy_hour_update();
CREATE OR REPLACE FUNCTION valet_sync_proxy_hour_delete() RETURNS trigger LANGUAGE plpgsql AS $sync$
BEGIN
 WITH changes AS MATERIALIZED (SELECT h.*, -1 AS direction FROM old_rows o CROSS JOIN LATERAL valet_proxy_hour(o) h WHERE o.hourly_accounted OR o.id <= (SELECT watermark FROM usage_hourly_progress WHERE source_kind='proxy')), deltas AS (
 SELECT dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,SUM(direction*turns) AS turns,SUM(direction*unpriced_turns) AS unpriced_turns,SUM(direction*positive_turns) AS positive_turns,SUM(direction*input_tokens) AS input_tokens,SUM(direction*output_tokens) AS output_tokens,SUM(direction*cache_read_tokens) AS cache_read_tokens,SUM(direction*cache_write_tokens) AS cache_write_tokens,SUM(direction*total_tokens) AS total_tokens,SUM(direction*cost_total) AS cost_total,SUM(direction*tool_calls) AS tool_calls,SUM(direction*pull_requests) AS pull_requests,SUM(direction*reviews) AS reviews
 FROM changes GROUP BY dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at)
 INSERT INTO usage_hourly(dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,turns,unpriced_turns,positive_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,tool_calls,pull_requests,reviews) SELECT dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,turns,unpriced_turns,positive_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,tool_calls,pull_requests,reviews FROM deltas
 WHERE turns<>0 OR tool_calls<>0 OR pull_requests<>0 OR reviews<>0 OR positive_turns<>0 OR total_tokens<>0 OR cost_total<>0 OR unpriced_turns<>0 OR input_tokens<>0 OR output_tokens<>0 OR cache_read_tokens<>0 OR cache_write_tokens<>0
 ORDER BY dimensions,created_at
 ON CONFLICT(dimensions,created_at) DO UPDATE SET
 turns=usage_hourly.turns+EXCLUDED.turns,
 unpriced_turns=usage_hourly.unpriced_turns+EXCLUDED.unpriced_turns,
 positive_turns=usage_hourly.positive_turns+EXCLUDED.positive_turns,
 input_tokens=usage_hourly.input_tokens+EXCLUDED.input_tokens,
 output_tokens=usage_hourly.output_tokens+EXCLUDED.output_tokens,
 cache_read_tokens=usage_hourly.cache_read_tokens+EXCLUDED.cache_read_tokens,
 cache_write_tokens=usage_hourly.cache_write_tokens+EXCLUDED.cache_write_tokens,
 total_tokens=usage_hourly.total_tokens+EXCLUDED.total_tokens,
 cost_total=usage_hourly.cost_total+EXCLUDED.cost_total,
 tool_calls=usage_hourly.tool_calls+EXCLUDED.tool_calls,
 pull_requests=usage_hourly.pull_requests+EXCLUDED.pull_requests,
 reviews=usage_hourly.reviews+EXCLUDED.reviews;
 DELETE FROM usage_hourly WHERE turns=0 AND tool_calls=0 AND pull_requests=0 AND reviews=0;
 RETURN NULL;
END $sync$;
CREATE OR REPLACE TRIGGER llm_proxy_requests_hourly_delete AFTER DELETE ON llm_proxy_requests
 REFERENCING OLD TABLE AS old_rows  FOR EACH STATEMENT EXECUTE FUNCTION valet_sync_proxy_hour_delete();
-- usage daily install
LOCK TABLE usage_hourly IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE IF NOT EXISTS usage_daily (LIKE usage_hourly INCLUDING DEFAULTS, PRIMARY KEY(dimensions,created_at));
CREATE INDEX IF NOT EXISTS usage_daily_window ON usage_daily(created_at,session_id);
CREATE INDEX IF NOT EXISTS usage_daily_session_window ON usage_daily(session_id,created_at);
CREATE INDEX IF NOT EXISTS usage_daily_org_window ON usage_daily(org_id,created_at);
CREATE INDEX IF NOT EXISTS usage_daily_empty ON usage_daily(created_at) WHERE turns=0 AND tool_calls=0 AND pull_requests=0 AND reviews=0;
CREATE INDEX IF NOT EXISTS usage_daily_outcomes ON usage_daily(created_at,session_id) WHERE pull_requests>0 OR reviews>0;
IF to_regclass('usage_daily_ready') IS NULL THEN
 IF EXISTS(SELECT 1 FROM usage_daily) THEN
  RAISE EXCEPTION 'Daily usage readiness is missing for an existing projection. Restore its readiness view from backup before restarting the API.';
 END IF;
 INSERT INTO usage_daily (dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,turns,unpriced_turns,positive_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,tool_calls,pull_requests,reviews) SELECT dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider, (floor(created_at::numeric/86400000)*86400000)::bigint,SUM(turns),SUM(unpriced_turns),SUM(positive_turns),SUM(input_tokens),SUM(output_tokens),SUM(cache_read_tokens),SUM(cache_write_tokens),SUM(total_tokens),SUM(cost_total),SUM(tool_calls),SUM(pull_requests),SUM(reviews)
 FROM usage_hourly GROUP BY 1,2,3,4,5,6,7,8,9;
END IF;
CREATE OR REPLACE FUNCTION valet_daily_insert() RETURNS trigger LANGUAGE plpgsql AS $daily$
BEGIN
 WITH changes AS (SELECT n.*,1 AS direction FROM new_hours n), deltas AS (
 SELECT dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,(floor(created_at::numeric/86400000)*86400000)::bigint AS created_at,
 SUM(direction*turns) AS turns,SUM(direction*unpriced_turns) AS unpriced_turns,SUM(direction*positive_turns) AS positive_turns,SUM(direction*input_tokens) AS input_tokens,SUM(direction*output_tokens) AS output_tokens,SUM(direction*cache_read_tokens) AS cache_read_tokens,SUM(direction*cache_write_tokens) AS cache_write_tokens,SUM(direction*total_tokens) AS total_tokens,SUM(direction*cost_total) AS cost_total,SUM(direction*tool_calls) AS tool_calls,SUM(direction*pull_requests) AS pull_requests,SUM(direction*reviews) AS reviews
 FROM changes GROUP BY 1,2,3,4,5,6,7,8,9)
 INSERT INTO usage_daily(dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,turns,unpriced_turns,positive_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,tool_calls,pull_requests,reviews) SELECT dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,turns,unpriced_turns,positive_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,tool_calls,pull_requests,reviews FROM deltas WHERE turns<>0 OR unpriced_turns<>0 OR positive_turns<>0 OR input_tokens<>0 OR output_tokens<>0 OR cache_read_tokens<>0 OR cache_write_tokens<>0 OR total_tokens<>0 OR cost_total<>0 OR tool_calls<>0 OR pull_requests<>0 OR reviews<>0
 ORDER BY dimensions,created_at ON CONFLICT(dimensions,created_at) DO UPDATE SET
 turns=usage_daily.turns+EXCLUDED.turns,unpriced_turns=usage_daily.unpriced_turns+EXCLUDED.unpriced_turns,positive_turns=usage_daily.positive_turns+EXCLUDED.positive_turns,input_tokens=usage_daily.input_tokens+EXCLUDED.input_tokens,output_tokens=usage_daily.output_tokens+EXCLUDED.output_tokens,cache_read_tokens=usage_daily.cache_read_tokens+EXCLUDED.cache_read_tokens,cache_write_tokens=usage_daily.cache_write_tokens+EXCLUDED.cache_write_tokens,total_tokens=usage_daily.total_tokens+EXCLUDED.total_tokens,cost_total=usage_daily.cost_total+EXCLUDED.cost_total,tool_calls=usage_daily.tool_calls+EXCLUDED.tool_calls,pull_requests=usage_daily.pull_requests+EXCLUDED.pull_requests,reviews=usage_daily.reviews+EXCLUDED.reviews;
 DELETE FROM usage_daily WHERE turns=0 AND tool_calls=0 AND pull_requests=0 AND reviews=0;
 RETURN NULL;
END $daily$;
CREATE OR REPLACE TRIGGER usage_hourly_daily_insert AFTER INSERT ON usage_hourly
 REFERENCING NEW TABLE AS new_hours FOR EACH STATEMENT EXECUTE FUNCTION valet_daily_insert();
CREATE OR REPLACE FUNCTION valet_daily_update() RETURNS trigger LANGUAGE plpgsql AS $daily$
BEGIN
 WITH changes AS (SELECT o.*,-1 AS direction FROM old_hours o UNION ALL SELECT n.*,1 AS direction FROM new_hours n), deltas AS (
 SELECT dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,(floor(created_at::numeric/86400000)*86400000)::bigint AS created_at,
 SUM(direction*turns) AS turns,SUM(direction*unpriced_turns) AS unpriced_turns,SUM(direction*positive_turns) AS positive_turns,SUM(direction*input_tokens) AS input_tokens,SUM(direction*output_tokens) AS output_tokens,SUM(direction*cache_read_tokens) AS cache_read_tokens,SUM(direction*cache_write_tokens) AS cache_write_tokens,SUM(direction*total_tokens) AS total_tokens,SUM(direction*cost_total) AS cost_total,SUM(direction*tool_calls) AS tool_calls,SUM(direction*pull_requests) AS pull_requests,SUM(direction*reviews) AS reviews
 FROM changes GROUP BY 1,2,3,4,5,6,7,8,9)
 INSERT INTO usage_daily(dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,turns,unpriced_turns,positive_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,tool_calls,pull_requests,reviews) SELECT dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,turns,unpriced_turns,positive_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,tool_calls,pull_requests,reviews FROM deltas WHERE turns<>0 OR unpriced_turns<>0 OR positive_turns<>0 OR input_tokens<>0 OR output_tokens<>0 OR cache_read_tokens<>0 OR cache_write_tokens<>0 OR total_tokens<>0 OR cost_total<>0 OR tool_calls<>0 OR pull_requests<>0 OR reviews<>0
 ORDER BY dimensions,created_at ON CONFLICT(dimensions,created_at) DO UPDATE SET
 turns=usage_daily.turns+EXCLUDED.turns,unpriced_turns=usage_daily.unpriced_turns+EXCLUDED.unpriced_turns,positive_turns=usage_daily.positive_turns+EXCLUDED.positive_turns,input_tokens=usage_daily.input_tokens+EXCLUDED.input_tokens,output_tokens=usage_daily.output_tokens+EXCLUDED.output_tokens,cache_read_tokens=usage_daily.cache_read_tokens+EXCLUDED.cache_read_tokens,cache_write_tokens=usage_daily.cache_write_tokens+EXCLUDED.cache_write_tokens,total_tokens=usage_daily.total_tokens+EXCLUDED.total_tokens,cost_total=usage_daily.cost_total+EXCLUDED.cost_total,tool_calls=usage_daily.tool_calls+EXCLUDED.tool_calls,pull_requests=usage_daily.pull_requests+EXCLUDED.pull_requests,reviews=usage_daily.reviews+EXCLUDED.reviews;
 DELETE FROM usage_daily WHERE turns=0 AND tool_calls=0 AND pull_requests=0 AND reviews=0;
 RETURN NULL;
END $daily$;
CREATE OR REPLACE TRIGGER usage_hourly_daily_update AFTER UPDATE ON usage_hourly
 REFERENCING OLD TABLE AS old_hours NEW TABLE AS new_hours FOR EACH STATEMENT EXECUTE FUNCTION valet_daily_update();
CREATE OR REPLACE FUNCTION valet_daily_delete() RETURNS trigger LANGUAGE plpgsql AS $daily$
BEGIN
 WITH changes AS (SELECT o.*,-1 AS direction FROM old_hours o), deltas AS (
 SELECT dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,(floor(created_at::numeric/86400000)*86400000)::bigint AS created_at,
 SUM(direction*turns) AS turns,SUM(direction*unpriced_turns) AS unpriced_turns,SUM(direction*positive_turns) AS positive_turns,SUM(direction*input_tokens) AS input_tokens,SUM(direction*output_tokens) AS output_tokens,SUM(direction*cache_read_tokens) AS cache_read_tokens,SUM(direction*cache_write_tokens) AS cache_write_tokens,SUM(direction*total_tokens) AS total_tokens,SUM(direction*cost_total) AS cost_total,SUM(direction*tool_calls) AS tool_calls,SUM(direction*pull_requests) AS pull_requests,SUM(direction*reviews) AS reviews
 FROM changes GROUP BY 1,2,3,4,5,6,7,8,9)
 INSERT INTO usage_daily(dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,turns,unpriced_turns,positive_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,tool_calls,pull_requests,reviews) SELECT dimensions,source_kind,session_id,org_id,user_id,team_id,model,provider,created_at,turns,unpriced_turns,positive_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,tool_calls,pull_requests,reviews FROM deltas WHERE turns<>0 OR unpriced_turns<>0 OR positive_turns<>0 OR input_tokens<>0 OR output_tokens<>0 OR cache_read_tokens<>0 OR cache_write_tokens<>0 OR total_tokens<>0 OR cost_total<>0 OR tool_calls<>0 OR pull_requests<>0 OR reviews<>0
 ORDER BY dimensions,created_at ON CONFLICT(dimensions,created_at) DO UPDATE SET
 turns=usage_daily.turns+EXCLUDED.turns,unpriced_turns=usage_daily.unpriced_turns+EXCLUDED.unpriced_turns,positive_turns=usage_daily.positive_turns+EXCLUDED.positive_turns,input_tokens=usage_daily.input_tokens+EXCLUDED.input_tokens,output_tokens=usage_daily.output_tokens+EXCLUDED.output_tokens,cache_read_tokens=usage_daily.cache_read_tokens+EXCLUDED.cache_read_tokens,cache_write_tokens=usage_daily.cache_write_tokens+EXCLUDED.cache_write_tokens,total_tokens=usage_daily.total_tokens+EXCLUDED.total_tokens,cost_total=usage_daily.cost_total+EXCLUDED.cost_total,tool_calls=usage_daily.tool_calls+EXCLUDED.tool_calls,pull_requests=usage_daily.pull_requests+EXCLUDED.pull_requests,reviews=usage_daily.reviews+EXCLUDED.reviews;
 DELETE FROM usage_daily WHERE turns=0 AND tool_calls=0 AND pull_requests=0 AND reviews=0;
 RETURN NULL;
END $daily$;
CREATE OR REPLACE TRIGGER usage_hourly_daily_delete AFTER DELETE ON usage_hourly
 REFERENCING OLD TABLE AS old_hours  FOR EACH STATEMENT EXECUTE FUNCTION valet_daily_delete();
CREATE OR REPLACE VIEW usage_daily_entries AS
 SELECT h.*, s.org_id AS scope_org_id,s.user_id AS scope_user_id,s.owner_type,NULLIF(s.owner_id,'') AS owner_id,
 r.id AS workflow_run_id,r.workflow_id,
 CASE WHEN h.session_id LIKE 'orchestrator:%' THEN 'orchestrator'
 WHEN h.session_id LIKE 'wf:%' THEN 'workflow' ELSE 'session' END AS use_case
 FROM usage_daily h JOIN agent_sessions s ON s.id=h.session_id
 LEFT JOIN workflow_runs r ON h.session_id LIKE 'wf:%' AND r.id=split_part(h.session_id,':',2)
 WHERE h.source_kind='engine'
 UNION ALL
 SELECT h.*,d.org_id,CASE WHEN r.owner_type='user' THEN NULLIF(r.owner_id,'') END,r.owner_type,NULLIF(r.owner_id,''),
 r.id,r.workflow_id,'workflow'::text
 FROM usage_daily h JOIN workflow_runs r ON h.session_id LIKE 'wf:%' AND r.id=split_part(h.session_id,':',2)
 JOIN workflow_definitions d ON d.id=r.workflow_id
 WHERE h.source_kind='engine' AND NOT EXISTS(SELECT 1 FROM agent_sessions s WHERE s.id=h.session_id)
 UNION ALL
 SELECT h.*,h.org_id,h.user_id,CASE WHEN h.team_id IS NOT NULL THEN 'team' ELSE 'user' END,
 COALESCE(h.team_id,h.user_id),NULL,NULL,'proxy'
 FROM usage_daily h WHERE h.source_kind='proxy';
CREATE OR REPLACE VIEW usage_daily_ready AS SELECT 1 AS version FROM usage_daily WHERE false;
ANALYZE usage_daily;
-- usage daily end

-- usage hourly backfill
UPDATE usage_entry_facts SET hourly_accounted=true WHERE NOT hourly_accounted;
UPDATE llm_proxy_requests SET hourly_accounted=true WHERE NOT hourly_accounted;
-- usage hourly publish
CREATE OR REPLACE VIEW usage_hourly_entries AS
 SELECT h.*, s.org_id AS scope_org_id,s.user_id AS scope_user_id,s.owner_type,NULLIF(s.owner_id,'') AS owner_id,
 r.id AS workflow_run_id,r.workflow_id,
 CASE WHEN h.session_id LIKE 'orchestrator:%' THEN 'orchestrator'
 WHEN h.session_id LIKE 'wf:%' THEN 'workflow' ELSE 'session' END AS use_case
 FROM usage_hourly h JOIN agent_sessions s ON s.id=h.session_id
 LEFT JOIN workflow_runs r ON h.session_id LIKE 'wf:%' AND r.id=split_part(h.session_id,':',2)
 WHERE h.source_kind='engine'
 UNION ALL
 SELECT h.*,d.org_id,CASE WHEN r.owner_type='user' THEN NULLIF(r.owner_id,'') END,r.owner_type,NULLIF(r.owner_id,''),
 r.id,r.workflow_id,'workflow'::text
 FROM usage_hourly h JOIN workflow_runs r ON h.session_id LIKE 'wf:%' AND r.id=split_part(h.session_id,':',2)
 JOIN workflow_definitions d ON d.id=r.workflow_id
 WHERE h.source_kind='engine' AND NOT EXISTS(SELECT 1 FROM agent_sessions s WHERE s.id=h.session_id)
 UNION ALL
 SELECT h.*,h.org_id,h.user_id,CASE WHEN h.team_id IS NOT NULL THEN 'team' ELSE 'user' END,
 COALESCE(h.team_id,h.user_id),NULL,NULL,'proxy'
 FROM usage_hourly h WHERE h.source_kind='proxy';
CREATE OR REPLACE VIEW usage_hourly_ready AS
 SELECT 1 AS version FROM usage_entry_facts f,llm_proxy_requests p,usage_hourly h,usage_hourly_progress progress
 WHERE false AND f.hourly_accounted AND p.hourly_accounted;
END $hourly$;

--> statement-breakpoint
DO $aux_install$ BEGIN
-- usage auxiliary install
-- Install before the bounded action backfill. Each fact insert updates its hour.
CREATE TABLE IF NOT EXISTS usage_action_facts (
  invocation_id text PRIMARY KEY REFERENCES action_invocations(invocation_id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  org_id text,
  session_id text,
  workflow_execution_id text,
  tool_calls bigint NOT NULL,
  outcome_kind text
);
CREATE INDEX IF NOT EXISTS usage_action_facts_window ON usage_action_facts(org_id, created_at);
CREATE TABLE IF NOT EXISTS usage_action_hourly (
  dimension_key text NOT NULL,
  hour_ms bigint NOT NULL,
  org_id text,
  session_id text,
  workflow_execution_id text,
  outcome_kind text,
  tool_calls bigint NOT NULL,
  outcomes bigint NOT NULL,
  facts bigint NOT NULL,
  PRIMARY KEY (dimension_key, hour_ms)
);
CREATE INDEX IF NOT EXISTS usage_action_hourly_window ON usage_action_hourly(org_id, hour_ms);
CREATE OR REPLACE FUNCTION valet_action_fact(a action_invocations)
RETURNS usage_action_facts LANGUAGE sql IMMUTABLE AS $function$
  SELECT a.invocation_id, COALESCE(a.started_at, a.created_at), a.org_id, a.session_id, a.workflow_execution_id,
    CASE WHEN a.service IS NOT NULL AND a.action_id IS NOT NULL
      AND a.status IN ('completed', 'error') AND a.duration_ms IS NOT NULL THEN 1 ELSE 0 END::bigint,
    CASE WHEN a.status = 'completed' AND a.duration_ms IS NOT NULL
      AND a.result->>'success' = 'true'
      AND (a.session_id IS NOT NULL OR a.workflow_execution_id IS NOT NULL)
    THEN CASE
      WHEN a.action_id = 'github.create_pull_request' THEN 'pull_request_created'
      WHEN a.action_id = 'github.create_review' AND a.result->'data'->>'state'
        IN ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED') THEN 'review_submitted'
      WHEN a.action_id IN ('slack.dm_owner', 'slack.dm_user') THEN 'slack_dm_sent'
      WHEN a.action_id IN ('slack.send_message', 'slack.reply_to_origin') THEN
        CASE WHEN a.result->'data'->>'channel' LIKE 'D%' THEN 'slack_dm_sent' ELSE 'slack_message_sent' END
    END END;
$function$;
CREATE TABLE IF NOT EXISTS usage_skill_facts (
  fact_key text PRIMARY KEY,
  invocation_id text NOT NULL REFERENCES skill_invocations(id) ON DELETE CASCADE,
  request_id text,
  created_at bigint NOT NULL,
  session_id text NOT NULL,
  skill_key text NOT NULL,
  skill_name text NOT NULL,
  origin text NOT NULL,
  plugin_name text,
  invoker_user_id text,
  tokens bigint NOT NULL,
  invoked bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_skill_facts_window ON usage_skill_facts(created_at);
CREATE INDEX IF NOT EXISTS usage_skill_facts_session_window ON usage_skill_facts(session_id,created_at);
CREATE INDEX IF NOT EXISTS usage_skill_facts_invocation ON usage_skill_facts(invocation_id);
CREATE TABLE IF NOT EXISTS usage_skill_hourly (
  dimension_key text NOT NULL,
  hour_ms bigint NOT NULL,
  session_id text NOT NULL,
  skill_key text NOT NULL,
  skill_name text NOT NULL,
  origin text NOT NULL,
  plugin_name text,
  invoker_user_id text,
  tokens bigint NOT NULL,
  invocations bigint NOT NULL,
  carrying_calls bigint NOT NULL,
  facts bigint NOT NULL,
  PRIMARY KEY(dimension_key,hour_ms)
);
CREATE INDEX IF NOT EXISTS usage_skill_hourly_window ON usage_skill_hourly(hour_ms,session_id);
CREATE INDEX IF NOT EXISTS usage_skill_hourly_session_window ON usage_skill_hourly(session_id,hour_ms);
CREATE TABLE IF NOT EXISTS usage_skill_request_memberships (
  dimension_key text NOT NULL,
  hour_ms bigint NOT NULL,
  request_key text NOT NULL,
  request_id text NOT NULL,
  refs bigint NOT NULL,
  PRIMARY KEY(dimension_key,hour_ms,request_key)
);
CREATE INDEX IF NOT EXISTS usage_skill_membership_request ON usage_skill_request_memberships(request_key);
CREATE TABLE IF NOT EXISTS usage_skill_requests (
  request_key text PRIMARY KEY,
  memberships bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_skill_requests_duplicates ON usage_skill_requests(request_key) WHERE memberships > 1;
CREATE OR REPLACE FUNCTION valet_skill_invocation_fact(i skill_invocations)
RETURNS usage_skill_facts LANGUAGE sql IMMUTABLE AS $function$
 SELECT jsonb_build_array(i.id)::text,i.id,NULL::text,i.created_at,i.session_id,i.skill_key,i.skill_name,
   i.origin,i.plugin_name,i.invoker_user_id,0::bigint,1::bigint;
$function$;
CREATE OR REPLACE FUNCTION valet_skill_context_fact(c skill_context_attributions,i skill_invocations)
RETURNS usage_skill_facts LANGUAGE sql IMMUTABLE AS $function$
 SELECT jsonb_build_array(i.id,c.llm_request_id)::text,i.id,c.llm_request_id,c.created_at,i.session_id,i.skill_key,i.skill_name,
   i.origin,i.plugin_name,NULL::text,c.estimated_skill_tokens::bigint,0::bigint;
$function$;
CREATE OR REPLACE FUNCTION valet_action_hour_sync()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE source_query text;
BEGIN
  -- Apply one net change per group. Stable order avoids cross-group lock inversion.
  source_query := CASE TG_OP
    WHEN 'INSERT' THEN 'SELECT *,1::bigint AS direction FROM new_action_facts'
    WHEN 'DELETE' THEN 'SELECT *,-1::bigint AS direction FROM old_action_facts'
    ELSE 'SELECT *,-1::bigint AS direction FROM old_action_facts UNION ALL SELECT *,1::bigint AS direction FROM new_action_facts'
  END;
  EXECUTE format($query$
    INSERT INTO usage_action_hourly AS h
    SELECT jsonb_build_array(org_id,session_id,workflow_execution_id,outcome_kind)::text,
      floor(created_at::numeric/3600000)::bigint*3600000,
      org_id,session_id,workflow_execution_id,outcome_kind,
      SUM(direction*tool_calls),COALESCE(SUM(direction) FILTER (WHERE outcome_kind IS NOT NULL),0),SUM(direction)
    FROM (%s) changes GROUP BY 1,2,3,4,5,6 ORDER BY 1,2
    ON CONFLICT (dimension_key,hour_ms) DO UPDATE SET tool_calls=h.tool_calls+EXCLUDED.tool_calls,
      outcomes=h.outcomes+EXCLUDED.outcomes,facts=h.facts+EXCLUDED.facts
  $query$,source_query);
  EXECUTE format($query$
    DELETE FROM usage_action_hourly h USING (%s) f
    WHERE h.dimension_key=jsonb_build_array(f.org_id,f.session_id,f.workflow_execution_id,f.outcome_kind)::text
      AND h.hour_ms=floor(f.created_at::numeric/3600000)::bigint*3600000 AND h.facts=0
  $query$,source_query);
  RETURN NULL;
END;
$function$;
DROP TRIGGER IF EXISTS usage_action_facts_hourly ON usage_action_facts;
DROP TRIGGER IF EXISTS usage_action_facts_hourly_insert ON usage_action_facts;
DROP TRIGGER IF EXISTS usage_action_facts_hourly_update ON usage_action_facts;
DROP TRIGGER IF EXISTS usage_action_facts_hourly_delete ON usage_action_facts;
CREATE TRIGGER usage_action_facts_hourly_insert AFTER INSERT ON usage_action_facts
REFERENCING NEW TABLE AS new_action_facts FOR EACH STATEMENT EXECUTE FUNCTION valet_action_hour_sync();
CREATE TRIGGER usage_action_facts_hourly_update AFTER UPDATE ON usage_action_facts
REFERENCING OLD TABLE AS old_action_facts NEW TABLE AS new_action_facts FOR EACH STATEMENT EXECUTE FUNCTION valet_action_hour_sync();
CREATE TRIGGER usage_action_facts_hourly_delete AFTER DELETE ON usage_action_facts
REFERENCING OLD TABLE AS old_action_facts FOR EACH STATEMENT EXECUTE FUNCTION valet_action_hour_sync();
CREATE OR REPLACE FUNCTION valet_action_fact_sync()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  INSERT INTO usage_action_facts SELECT f.* FROM new_actions a CROSS JOIN LATERAL valet_action_fact(a::action_invocations) f
  ON CONFLICT (invocation_id) DO UPDATE SET created_at=EXCLUDED.created_at,org_id=EXCLUDED.org_id,
    session_id=EXCLUDED.session_id,workflow_execution_id=EXCLUDED.workflow_execution_id,
    tool_calls=EXCLUDED.tool_calls,outcome_kind=EXCLUDED.outcome_kind;
  RETURN NULL;
END;
$function$;
DROP TRIGGER IF EXISTS action_invocations_usage_fact ON action_invocations;
DROP TRIGGER IF EXISTS action_invocations_usage_fact_update ON action_invocations;
CREATE TRIGGER action_invocations_usage_fact AFTER INSERT ON action_invocations
REFERENCING NEW TABLE AS new_actions FOR EACH STATEMENT EXECUTE FUNCTION valet_action_fact_sync();
CREATE TRIGGER action_invocations_usage_fact_update AFTER UPDATE ON action_invocations
REFERENCING NEW TABLE AS new_actions FOR EACH STATEMENT EXECUTE FUNCTION valet_action_fact_sync();
CREATE OR REPLACE FUNCTION valet_skill_hour_sync()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE source_query text;
BEGIN
  -- Apply one net change per group. Stable order avoids cross-group lock inversion.
  source_query := CASE TG_OP
    WHEN 'INSERT' THEN 'SELECT *,1::bigint AS direction FROM new_skill_facts'
    WHEN 'DELETE' THEN 'SELECT *,-1::bigint AS direction FROM old_skill_facts'
    ELSE 'SELECT *,-1::bigint AS direction FROM old_skill_facts UNION ALL SELECT *,1::bigint AS direction FROM new_skill_facts'
  END;
  EXECUTE format($query$
    INSERT INTO usage_skill_hourly AS h
    SELECT jsonb_build_array(session_id,skill_key,skill_name,origin,plugin_name,invoker_user_id)::text,
      floor(created_at::numeric/3600000)::bigint*3600000,
      session_id,skill_key,skill_name,origin,plugin_name,invoker_user_id,
      SUM(direction*tokens),SUM(direction*invoked),0,SUM(direction)
    FROM (%s) changes GROUP BY 1,2,3,4,5,6,7,8 ORDER BY 1,2
    ON CONFLICT(dimension_key,hour_ms) DO UPDATE SET tokens=h.tokens+EXCLUDED.tokens,
      invocations=h.invocations+EXCLUDED.invocations,facts=h.facts+EXCLUDED.facts
  $query$,source_query);
  EXECUTE format($query$
    WITH deltas AS MATERIALIZED (
      SELECT jsonb_build_array(session_id,skill_key,skill_name,origin,plugin_name,invoker_user_id)::text AS dimension_key,
        floor(created_at::numeric/3600000)::bigint*3600000 AS hour_ms,
        jsonb_build_array(skill_key,skill_name,origin,plugin_name,request_id)::text AS request_key,
        request_id,SUM(direction) AS refs
      FROM (%s) changes WHERE request_id IS NOT NULL GROUP BY 1,2,3,4
    ), changed AS (
      INSERT INTO usage_skill_request_memberships AS m SELECT * FROM deltas ORDER BY dimension_key,hour_ms,request_key
      ON CONFLICT(dimension_key,hour_ms,request_key) DO UPDATE SET refs=m.refs+EXCLUDED.refs
      RETURNING dimension_key,hour_ms,request_key,refs
    ), membership_changes AS MATERIALIZED (
      SELECT c.dimension_key,c.hour_ms,c.request_key,
        CASE WHEN c.refs>0 AND c.refs-d.refs=0 THEN 1 WHEN c.refs=0 AND c.refs-d.refs>0 THEN -1 ELSE 0 END AS delta
      FROM changed c JOIN deltas d USING(dimension_key,hour_ms,request_key)
    ), global_changes AS (
      INSERT INTO usage_skill_requests AS r
      SELECT request_key,SUM(delta) FROM membership_changes WHERE delta<>0 GROUP BY request_key ORDER BY request_key
      ON CONFLICT(request_key) DO UPDATE SET memberships=r.memberships+EXCLUDED.memberships
    )
    UPDATE usage_skill_hourly h SET carrying_calls=h.carrying_calls+c.delta
    FROM (SELECT dimension_key,hour_ms,SUM(delta) AS delta FROM membership_changes GROUP BY 1,2) c
    WHERE h.dimension_key=c.dimension_key AND h.hour_ms=c.hour_ms AND c.delta<>0
  $query$,source_query);
  EXECUTE format($query$
    DELETE FROM usage_skill_request_memberships m USING (%s) f
    WHERE m.dimension_key=jsonb_build_array(f.session_id,f.skill_key,f.skill_name,f.origin,f.plugin_name,f.invoker_user_id)::text
      AND m.hour_ms=floor(f.created_at::numeric/3600000)::bigint*3600000
      AND m.request_key=jsonb_build_array(f.skill_key,f.skill_name,f.origin,f.plugin_name,f.request_id)::text AND m.refs=0
  $query$,source_query);
  EXECUTE format($query$
    DELETE FROM usage_skill_requests r USING (%s) f
    WHERE r.request_key=jsonb_build_array(f.skill_key,f.skill_name,f.origin,f.plugin_name,f.request_id)::text AND r.memberships=0
  $query$,source_query);
  EXECUTE format($query$
    DELETE FROM usage_skill_hourly h USING (%s) f
    WHERE h.dimension_key=jsonb_build_array(f.session_id,f.skill_key,f.skill_name,f.origin,f.plugin_name,f.invoker_user_id)::text
      AND h.hour_ms=floor(f.created_at::numeric/3600000)::bigint*3600000 AND h.facts=0
  $query$,source_query);
  RETURN NULL;
END;
$function$;
DROP TRIGGER IF EXISTS usage_skill_facts_hourly ON usage_skill_facts;
DROP TRIGGER IF EXISTS usage_skill_facts_hourly_insert ON usage_skill_facts;
DROP TRIGGER IF EXISTS usage_skill_facts_hourly_update ON usage_skill_facts;
DROP TRIGGER IF EXISTS usage_skill_facts_hourly_delete ON usage_skill_facts;
CREATE TRIGGER usage_skill_facts_hourly_insert AFTER INSERT ON usage_skill_facts
REFERENCING NEW TABLE AS new_skill_facts FOR EACH STATEMENT EXECUTE FUNCTION valet_skill_hour_sync();
CREATE TRIGGER usage_skill_facts_hourly_update AFTER UPDATE ON usage_skill_facts
REFERENCING OLD TABLE AS old_skill_facts NEW TABLE AS new_skill_facts FOR EACH STATEMENT EXECUTE FUNCTION valet_skill_hour_sync();
CREATE TRIGGER usage_skill_facts_hourly_delete AFTER DELETE ON usage_skill_facts
REFERENCING OLD TABLE AS old_skill_facts FOR EACH STATEMENT EXECUTE FUNCTION valet_skill_hour_sync();
-- Related-row lookups need a fresh snapshot after the invocation lock wait.
CREATE OR REPLACE FUNCTION valet_skill_lock_invocation(invocation text)
RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='40001',
      MESSAGE='Skill usage updates require READ COMMITTED isolation. Retry the transaction with READ COMMITTED isolation.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(invocation,72401));
END;
$function$;
CREATE OR REPLACE FUNCTION valet_skill_invocation_sync()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE invocation text;
BEGIN
  -- Related sources share one lock. Ordered acquisition also supports bulk writes.
  FOR invocation IN SELECT id FROM new_skill_invocations ORDER BY id LOOP
    PERFORM valet_skill_lock_invocation(invocation);
  END LOOP;
  INSERT INTO usage_skill_facts SELECT f.* FROM new_skill_invocations i CROSS JOIN LATERAL valet_skill_invocation_fact(i::skill_invocations) f
  ON CONFLICT (fact_key) DO UPDATE SET created_at=EXCLUDED.created_at,session_id=EXCLUDED.session_id,
    skill_key=EXCLUDED.skill_key,skill_name=EXCLUDED.skill_name,origin=EXCLUDED.origin,
    plugin_name=EXCLUDED.plugin_name,invoker_user_id=EXCLUDED.invoker_user_id;
  INSERT INTO usage_skill_facts SELECT f.*
    FROM new_skill_invocations i JOIN skill_context_attributions c ON c.skill_invocation_id=i.id
    CROSS JOIN LATERAL valet_skill_context_fact(c,i::skill_invocations) f
  ON CONFLICT (fact_key) DO UPDATE SET created_at=EXCLUDED.created_at,session_id=EXCLUDED.session_id,
    skill_key=EXCLUDED.skill_key,skill_name=EXCLUDED.skill_name,origin=EXCLUDED.origin,
    plugin_name=EXCLUDED.plugin_name,tokens=EXCLUDED.tokens;
  RETURN NULL;
END;
$function$;
DROP TRIGGER IF EXISTS skill_invocations_usage_fact ON skill_invocations;
DROP TRIGGER IF EXISTS skill_invocations_usage_fact_update ON skill_invocations;
CREATE TRIGGER skill_invocations_usage_fact AFTER INSERT ON skill_invocations
REFERENCING NEW TABLE AS new_skill_invocations FOR EACH STATEMENT EXECUTE FUNCTION valet_skill_invocation_sync();
CREATE TRIGGER skill_invocations_usage_fact_update AFTER UPDATE ON skill_invocations
REFERENCING NEW TABLE AS new_skill_invocations FOR EACH STATEMENT EXECUTE FUNCTION valet_skill_invocation_sync();
CREATE OR REPLACE FUNCTION valet_skill_context_sync()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE invocation text;
BEGIN
  -- Serialize related sources before reading metadata, including moved contexts.
  IF TG_OP = 'UPDATE' THEN
    FOR invocation IN SELECT skill_invocation_id FROM old_skill_context
      UNION SELECT skill_invocation_id FROM new_skill_context ORDER BY 1 LOOP
      PERFORM valet_skill_lock_invocation(invocation);
    END LOOP;
    DELETE FROM usage_skill_facts f USING old_skill_context c
      WHERE f.fact_key=jsonb_build_array(c.skill_invocation_id,c.llm_request_id)::text
        AND NOT EXISTS (SELECT 1 FROM new_skill_context n
          WHERE n.skill_invocation_id=c.skill_invocation_id AND n.llm_request_id=c.llm_request_id);
  ELSIF TG_OP = 'DELETE' THEN
    FOR invocation IN SELECT DISTINCT skill_invocation_id FROM old_skill_context ORDER BY 1 LOOP
      PERFORM valet_skill_lock_invocation(invocation);
    END LOOP;
    DELETE FROM usage_skill_facts f USING old_skill_context c
      WHERE f.fact_key=jsonb_build_array(c.skill_invocation_id,c.llm_request_id)::text;
  ELSE
    FOR invocation IN SELECT DISTINCT skill_invocation_id FROM new_skill_context ORDER BY 1 LOOP
      PERFORM valet_skill_lock_invocation(invocation);
    END LOOP;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO usage_skill_facts SELECT f.*
      FROM new_skill_context c JOIN skill_invocations i ON i.id=c.skill_invocation_id
      CROSS JOIN LATERAL valet_skill_context_fact(c::skill_context_attributions,i) f
    ORDER BY f.fact_key
    ON CONFLICT (fact_key) DO UPDATE SET created_at=EXCLUDED.created_at,session_id=EXCLUDED.session_id,
      skill_key=EXCLUDED.skill_key,skill_name=EXCLUDED.skill_name,origin=EXCLUDED.origin,
      plugin_name=EXCLUDED.plugin_name,tokens=EXCLUDED.tokens;
  END IF;
  RETURN NULL;
END;
$function$;
DROP TRIGGER IF EXISTS skill_context_usage_fact ON skill_context_attributions;
DROP TRIGGER IF EXISTS skill_context_usage_fact_update ON skill_context_attributions;
DROP TRIGGER IF EXISTS skill_context_usage_fact_delete ON skill_context_attributions;
CREATE TRIGGER skill_context_usage_fact AFTER INSERT ON skill_context_attributions
REFERENCING NEW TABLE AS new_skill_context FOR EACH STATEMENT EXECUTE FUNCTION valet_skill_context_sync();
CREATE TRIGGER skill_context_usage_fact_update AFTER UPDATE ON skill_context_attributions
REFERENCING OLD TABLE AS old_skill_context NEW TABLE AS new_skill_context FOR EACH STATEMENT EXECUTE FUNCTION valet_skill_context_sync();
CREATE TRIGGER skill_context_usage_fact_delete AFTER DELETE ON skill_context_attributions
REFERENCING OLD TABLE AS old_skill_context FOR EACH STATEMENT EXECUTE FUNCTION valet_skill_context_sync();
-- usage auxiliary end
END $aux_install$;

--> statement-breakpoint
DO $member$ BEGIN
-- usage member install
CREATE TABLE IF NOT EXISTS usage_member_facts (
  entry_id text PRIMARY KEY, session_id text NOT NULL, queue_item_id text,
  created_at bigint NOT NULL, actor_id text NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_member_facts_queue ON usage_member_facts(queue_item_id,session_id);
CREATE INDEX IF NOT EXISTS usage_member_facts_window ON usage_member_facts(created_at,session_id);
CREATE INDEX IF NOT EXISTS usage_member_facts_session_window ON usage_member_facts(session_id,created_at);
CREATE TABLE IF NOT EXISTS usage_member_hourly (
  session_id text NOT NULL, actor_id text NOT NULL, created_at bigint NOT NULL,
  positive_turns bigint NOT NULL, PRIMARY KEY(session_id,actor_id,created_at)
);
CREATE INDEX IF NOT EXISTS usage_member_hourly_window ON usage_member_hourly(created_at,session_id);

DROP TRIGGER IF EXISTS usage_member_facts_hourly ON usage_member_facts;
CREATE INDEX IF NOT EXISTS usage_member_hourly_empty ON usage_member_hourly(created_at) WHERE positive_turns=0;
CREATE OR REPLACE FUNCTION valet_member_fact_insert() RETURNS trigger LANGUAGE plpgsql AS $changed$
BEGIN
  WITH changes AS (SELECT session_id,actor_id,created_at,1 AS direction FROM new_facts)
  INSERT INTO usage_member_hourly
    SELECT session_id,actor_id,(floor(created_at::numeric/3600000)*3600000)::bigint,SUM(direction)
    FROM changes GROUP BY 1,2,3 HAVING SUM(direction)<>0 ORDER BY 1,2,3
  ON CONFLICT(session_id,actor_id,created_at) DO UPDATE
    SET positive_turns=usage_member_hourly.positive_turns+EXCLUDED.positive_turns;
  DELETE FROM usage_member_hourly WHERE positive_turns=0;
  RETURN NULL;
END $changed$;
CREATE OR REPLACE TRIGGER usage_member_facts_insert AFTER INSERT ON usage_member_facts
  REFERENCING NEW TABLE AS new_facts FOR EACH STATEMENT EXECUTE FUNCTION valet_member_fact_insert();
CREATE OR REPLACE FUNCTION valet_member_fact_update() RETURNS trigger LANGUAGE plpgsql AS $changed$
BEGIN
  WITH changes AS (SELECT session_id,actor_id,created_at,-1 AS direction FROM old_facts UNION ALL SELECT session_id,actor_id,created_at,1 AS direction FROM new_facts)
  INSERT INTO usage_member_hourly
    SELECT session_id,actor_id,(floor(created_at::numeric/3600000)*3600000)::bigint,SUM(direction)
    FROM changes GROUP BY 1,2,3 HAVING SUM(direction)<>0 ORDER BY 1,2,3
  ON CONFLICT(session_id,actor_id,created_at) DO UPDATE
    SET positive_turns=usage_member_hourly.positive_turns+EXCLUDED.positive_turns;
  DELETE FROM usage_member_hourly WHERE positive_turns=0;
  RETURN NULL;
END $changed$;
CREATE OR REPLACE TRIGGER usage_member_facts_update AFTER UPDATE ON usage_member_facts
  REFERENCING OLD TABLE AS old_facts NEW TABLE AS new_facts FOR EACH STATEMENT EXECUTE FUNCTION valet_member_fact_update();
CREATE OR REPLACE FUNCTION valet_member_fact_delete() RETURNS trigger LANGUAGE plpgsql AS $changed$
BEGIN
  WITH changes AS (SELECT session_id,actor_id,created_at,-1 AS direction FROM old_facts)
  INSERT INTO usage_member_hourly
    SELECT session_id,actor_id,(floor(created_at::numeric/3600000)*3600000)::bigint,SUM(direction)
    FROM changes GROUP BY 1,2,3 HAVING SUM(direction)<>0 ORDER BY 1,2,3
  ON CONFLICT(session_id,actor_id,created_at) DO UPDATE
    SET positive_turns=usage_member_hourly.positive_turns+EXCLUDED.positive_turns;
  DELETE FROM usage_member_hourly WHERE positive_turns=0;
  RETURN NULL;
END $changed$;
CREATE OR REPLACE TRIGGER usage_member_facts_delete AFTER DELETE ON usage_member_facts
  REFERENCING OLD TABLE AS old_facts  FOR EACH STATEMENT EXECUTE FUNCTION valet_member_fact_delete();
-- Queue locks serialize actor lookup with corrections to a queue author's identity.
-- Separate namespaces avoid collisions with other application advisory locks.
CREATE OR REPLACE FUNCTION valet_member_lock_queue(queue_id text) RETURNS void LANGUAGE plpgsql AS $lock$
BEGIN
  IF queue_id IS NOT NULL THEN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Retry member activity writes at READ COMMITTED isolation.' USING ERRCODE='40001';
    END IF;
    PERFORM pg_advisory_xact_lock(194731,hashtext(queue_id));
  END IF;
END $lock$;
CREATE OR REPLACE FUNCTION valet_member_sync_entry(e engine_entries) RETURNS void LANGUAGE plpgsql AS $entry$
DECLARE actor text;
BEGIN
  PERFORM valet_member_lock_queue(e.queue_item_id);
  IF e.usage IS NULL OR COALESCE((e.usage::jsonb->>'total')::bigint,0)<=0 THEN
    DELETE FROM usage_member_facts WHERE entry_id=e.id;
    RETURN;
  END IF;
  SELECT NULLIF(q.author::jsonb->>'id','') INTO actor FROM engine_queue_items q
    WHERE q.id=e.queue_item_id AND q.session_id=e.session_id;
  INSERT INTO usage_member_facts VALUES(e.id,e.session_id,e.queue_item_id,e.created_at,COALESCE(actor,''))
  ON CONFLICT(entry_id) DO UPDATE SET session_id=EXCLUDED.session_id,queue_item_id=EXCLUDED.queue_item_id,
    created_at=EXCLUDED.created_at,actor_id=EXCLUDED.actor_id;
END $entry$;
DROP TRIGGER IF EXISTS engine_entries_member_activity ON engine_entries;
CREATE OR REPLACE FUNCTION valet_member_entry_insert() RETURNS trigger LANGUAGE plpgsql AS $changed$
DECLARE queue_id text;
BEGIN
  FOR queue_id IN SELECT DISTINCT queue_item_id FROM (SELECT queue_item_id FROM new_entries) ids
    WHERE queue_item_id IS NOT NULL ORDER BY queue_item_id
  LOOP PERFORM valet_member_lock_queue(queue_id); END LOOP;
  INSERT INTO usage_member_facts
    SELECT e.id,e.session_id,e.queue_item_id,e.created_at,COALESCE(NULLIF(q.author::jsonb->>'id',''),'')
    FROM new_entries e LEFT JOIN engine_queue_items q ON q.id=e.queue_item_id AND q.session_id=e.session_id
    WHERE e.usage IS NOT NULL AND COALESCE((e.usage::jsonb->>'total')::bigint,0)>0
    ORDER BY e.id
  ON CONFLICT(entry_id) DO UPDATE SET session_id=EXCLUDED.session_id,queue_item_id=EXCLUDED.queue_item_id,
    created_at=EXCLUDED.created_at,actor_id=EXCLUDED.actor_id;
  RETURN NULL;
END $changed$;
CREATE OR REPLACE TRIGGER engine_entries_member_insert AFTER INSERT ON engine_entries
  REFERENCING NEW TABLE AS new_entries FOR EACH STATEMENT EXECUTE FUNCTION valet_member_entry_insert();
CREATE OR REPLACE FUNCTION valet_member_entry_update() RETURNS trigger LANGUAGE plpgsql AS $changed$
DECLARE queue_id text;
BEGIN
  FOR queue_id IN SELECT DISTINCT queue_item_id FROM (SELECT queue_item_id FROM old_entries UNION ALL SELECT queue_item_id FROM new_entries) ids
    WHERE queue_item_id IS NOT NULL ORDER BY queue_item_id
  LOOP PERFORM valet_member_lock_queue(queue_id); END LOOP;
  DELETE FROM usage_member_facts f USING old_entries o WHERE f.entry_id=o.id AND NOT EXISTS (SELECT 1 FROM new_entries n WHERE n.id=o.id AND n.usage IS NOT NULL AND COALESCE((n.usage::jsonb->>'total')::bigint,0)>0);
  INSERT INTO usage_member_facts
    SELECT e.id,e.session_id,e.queue_item_id,e.created_at,COALESCE(NULLIF(q.author::jsonb->>'id',''),'')
    FROM new_entries e LEFT JOIN engine_queue_items q ON q.id=e.queue_item_id AND q.session_id=e.session_id
    WHERE e.usage IS NOT NULL AND COALESCE((e.usage::jsonb->>'total')::bigint,0)>0
    ORDER BY e.id
  ON CONFLICT(entry_id) DO UPDATE SET session_id=EXCLUDED.session_id,queue_item_id=EXCLUDED.queue_item_id,
    created_at=EXCLUDED.created_at,actor_id=EXCLUDED.actor_id;
  RETURN NULL;
END $changed$;
CREATE OR REPLACE TRIGGER engine_entries_member_update AFTER UPDATE ON engine_entries
  REFERENCING OLD TABLE AS old_entries NEW TABLE AS new_entries FOR EACH STATEMENT EXECUTE FUNCTION valet_member_entry_update();
CREATE OR REPLACE FUNCTION valet_member_entry_delete() RETURNS trigger LANGUAGE plpgsql AS $changed$
DECLARE queue_id text;
BEGIN
  FOR queue_id IN SELECT DISTINCT queue_item_id FROM (SELECT queue_item_id FROM old_entries) ids
    WHERE queue_item_id IS NOT NULL ORDER BY queue_item_id
  LOOP PERFORM valet_member_lock_queue(queue_id); END LOOP;
  DELETE FROM usage_member_facts f USING old_entries o WHERE f.entry_id=o.id ;
  RETURN NULL;
END $changed$;
CREATE OR REPLACE TRIGGER engine_entries_member_delete AFTER DELETE ON engine_entries
  REFERENCING OLD TABLE AS old_entries  FOR EACH STATEMENT EXECUTE FUNCTION valet_member_entry_delete();
CREATE OR REPLACE FUNCTION valet_member_queue_changed() RETURNS trigger LANGUAGE plpgsql AS $changed$
DECLARE queue_id text;
BEGIN
  FOR queue_id IN SELECT DISTINCT id FROM (VALUES
    (CASE WHEN TG_OP <> 'INSERT' THEN OLD.id END),
    (CASE WHEN TG_OP <> 'DELETE' THEN NEW.id END)) ids(id)
    WHERE id IS NOT NULL ORDER BY id
  LOOP PERFORM valet_member_lock_queue(queue_id); END LOOP;
  IF TG_OP <> 'INSERT' THEN
    UPDATE usage_member_facts SET actor_id=''
      WHERE queue_item_id=OLD.id AND session_id=OLD.session_id AND actor_id<>'';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    UPDATE usage_member_facts SET actor_id=COALESCE(NULLIF(NEW.author::jsonb->>'id',''),'')
      WHERE queue_item_id=NEW.id AND session_id=NEW.session_id
      AND actor_id IS DISTINCT FROM COALESCE(NULLIF(NEW.author::jsonb->>'id',''),'');
    RETURN NEW;
  END IF;
  RETURN OLD;
END $changed$;
CREATE OR REPLACE TRIGGER engine_queue_items_member_activity AFTER INSERT OR DELETE OR UPDATE OF id,session_id,author
  ON engine_queue_items FOR EACH ROW EXECUTE FUNCTION valet_member_queue_changed();
CREATE OR REPLACE FUNCTION valet_member_backfill_batch(after_id text, batch_size integer) RETURNS text
LANGUAGE plpgsql AS $batch$
DECLARE entry_ids text[]; queue_id text; last_id text;
BEGIN
  -- Keep only ids in memory; source rows can contain large transcripts.
  SELECT array_agg(id) INTO entry_ids FROM (
    SELECT e.id FROM engine_entries e WHERE id>after_id AND usage IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM usage_member_facts f WHERE f.entry_id=e.id)
    ORDER BY id LIMIT batch_size FOR UPDATE
  ) batch;
  IF entry_ids IS NULL THEN RETURN NULL; END IF;
  FOR queue_id IN SELECT DISTINCT e.queue_item_id FROM engine_entries e
    WHERE e.id=ANY(entry_ids) AND e.queue_item_id IS NOT NULL ORDER BY e.queue_item_id
  LOOP PERFORM valet_member_lock_queue(queue_id); END LOOP;
  INSERT INTO usage_member_facts
    SELECT e.id,e.session_id,e.queue_item_id,e.created_at,COALESCE(NULLIF(q.author::jsonb->>'id',''),'')
    FROM engine_entries e LEFT JOIN engine_queue_items q ON q.id=e.queue_item_id AND q.session_id=e.session_id
    WHERE e.id=ANY(entry_ids) AND COALESCE((e.usage::jsonb->>'total')::bigint,0)>0 ORDER BY e.id
    ON CONFLICT(entry_id) DO NOTHING;
  SELECT max(id) INTO last_id FROM unnest(entry_ids) id;
  RETURN last_id;
END $batch$;
-- usage member install end
-- usage member backfill
INSERT INTO usage_member_facts
  SELECT e.id,e.session_id,e.queue_item_id,e.created_at,COALESCE(NULLIF(q.author::jsonb->>'id',''),'')
  FROM engine_entries e LEFT JOIN engine_queue_items q ON q.id=e.queue_item_id AND q.session_id=e.session_id
  WHERE e.usage IS NOT NULL AND COALESCE((e.usage::jsonb->>'total')::bigint,0)>0
  ON CONFLICT(entry_id) DO NOTHING;
-- usage member publish
CREATE OR REPLACE VIEW usage_member_activity_ready AS SELECT 1 AS version FROM usage_member_facts,usage_member_hourly WHERE false;

END $member$;
