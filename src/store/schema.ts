export const migrations = [
	{
		version: 1,
		sql: `
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('channel', 'direct_message')),
  name TEXT NOT NULL,
  description TEXT NOT NULL
);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  nickname TEXT NOT NULL,
  delete_at INTEGER NOT NULL
);
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  create_at INTEGER NOT NULL,
  update_at INTEGER NOT NULL,
  delete_at INTEGER NOT NULL,
  message TEXT NOT NULL,
  props_json TEXT NOT NULL,
  metadata_json TEXT,
  indexed_at INTEGER NOT NULL
);
CREATE INDEX posts_conversation_chronology ON posts(conversation_id, create_at DESC, id);
CREATE INDEX posts_thread_chronology ON posts(thread_id, create_at, id);
CREATE INDEX posts_updates ON posts(conversation_id, update_at DESC);
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  create_at INTEGER NOT NULL,
  update_at INTEGER NOT NULL,
  delete_at INTEGER NOT NULL,
  name TEXT NOT NULL,
  extension TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime_type TEXT NOT NULL
);
CREATE TABLE post_files (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, file_id)
);
CREATE TABLE conversation_sync_state (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  newest_post_id TEXT,
  newest_post_at INTEGER,
  oldest_covered_at INTEGER,
  last_success_at INTEGER,
  coverage_complete INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE ticket_threads (
  ticket_key TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  source_post_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('discovered', 'explicit')),
  PRIMARY KEY (ticket_key, thread_id, source_post_id, origin)
);
CREATE INDEX ticket_threads_thread ON ticket_threads(thread_id);
CREATE VIRTUAL TABLE posts_fts USING fts5(post_id UNINDEXED, message, tokenize='unicode61');
`,
	},
	{
		version: 2,
		sql: "DELETE FROM posts_fts;",
		rebuildFts: true,
	},
	{
		version: 3,
		sql: `
CREATE TABLE post_entities (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  PRIMARY KEY (post_id, kind, normalized_value)
);
CREATE INDEX post_entities_lookup ON post_entities(kind, normalized_value, conversation_id);
CREATE INDEX post_entities_thread ON post_entities(thread_id);
`,
		rebuildEntities: true,
	},
	{
		version: 4,
		sql: "DELETE FROM post_entities;",
		rebuildEntities: true,
	},
	{
		version: 5,
		sql: `
CREATE VIRTUAL TABLE posts_morph_fts USING fts5(post_id UNINDEXED, morph, tokenize='unicode61');
`,
		rebuildMorphFts: true,
	},
	{
		version: 6,
		sql: `
CREATE VIRTUAL TABLE posts_concept_fts USING fts5(post_id UNINDEXED, concepts, tokenize='unicode61');
CREATE TABLE search_index_config (
  kind TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL
);
`,
		rebuildConceptFts: true,
	},
	{
		version: 7,
		sql: `
ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0;
`,
	},
] as const;
