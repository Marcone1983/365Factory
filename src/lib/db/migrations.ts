/**
 * Ordered, checksum-verified schema migrations.
 *
 * Migrations are append-only: never edit an applied migration, add a new one.
 * The runner records version + checksum in `schema_migrations` and refuses to
 * start if a previously applied migration's body has changed.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const M001 = `
-- ---------------------------------------------------------------- identity --
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  password_algo  TEXT NOT NULL DEFAULT 'scrypt',
  role           TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
  display_name   TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  last_login_at  TEXT
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  csrf_token   TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE audit_logs (
  id          TEXT PRIMARY KEY,
  actor_type  TEXT NOT NULL,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  outcome     TEXT NOT NULL DEFAULT 'success',
  metadata    TEXT NOT NULL DEFAULT '{}',
  ip          TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at DESC);

CREATE TABLE rate_limits (
  bucket       TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

-- ---------------------------------------------------------------- research --
CREATE TABLE research_sources (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  name          TEXT NOT NULL,
  host          TEXT NOT NULL,
  base_url      TEXT NOT NULL,
  trust_weight  REAL NOT NULL DEFAULT 0.5,
  robots_policy TEXT NOT NULL DEFAULT 'respect',
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_fetch_at TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (host, kind)
);

CREATE TABLE research_documents (
  id             TEXT PRIMARY KEY,
  source_id      TEXT REFERENCES research_sources(id) ON DELETE SET NULL,
  factory_run_id TEXT,
  url            TEXT NOT NULL,
  canonical_url  TEXT NOT NULL,
  url_hash       TEXT NOT NULL UNIQUE,
  content_hash   TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  excerpt        TEXT NOT NULL DEFAULT '',
  content        TEXT NOT NULL DEFAULT '',
  language       TEXT NOT NULL DEFAULT 'und',
  category       TEXT NOT NULL DEFAULT 'general',
  keywords       TEXT NOT NULL DEFAULT '[]',
  entities       TEXT NOT NULL DEFAULT '[]',
  sentiment      REAL NOT NULL DEFAULT 0,
  word_count     INTEGER NOT NULL DEFAULT 0,
  http_status    INTEGER NOT NULL DEFAULT 0,
  confidence     REAL NOT NULL DEFAULT 0.5,
  published_at   TEXT,
  fetched_at     TEXT NOT NULL,
  extraction_at  TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_docs_content_hash ON research_documents(content_hash);
CREATE INDEX idx_docs_fetched ON research_documents(fetched_at DESC);
CREATE INDEX idx_docs_run ON research_documents(factory_run_id);

CREATE TABLE market_signals (
  id             TEXT PRIMARY KEY,
  document_id    TEXT REFERENCES research_documents(id) ON DELETE CASCADE,
  factory_run_id TEXT,
  kind           TEXT NOT NULL,
  statement      TEXT NOT NULL,
  subject        TEXT NOT NULL DEFAULT '',
  audience       TEXT NOT NULL DEFAULT '',
  category       TEXT NOT NULL DEFAULT 'general',
  keywords       TEXT NOT NULL DEFAULT '[]',
  sentiment      REAL NOT NULL DEFAULT 0,
  intensity      REAL NOT NULL DEFAULT 0.5,
  evidence_quote TEXT NOT NULL DEFAULT '',
  confidence     REAL NOT NULL DEFAULT 0.5,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_signals_run ON market_signals(factory_run_id);
CREATE INDEX idx_signals_kind ON market_signals(kind);

CREATE TABLE trends (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT 'general',
  momentum     REAL NOT NULL DEFAULT 0,
  volume       REAL NOT NULL DEFAULT 0,
  signal_count INTEGER NOT NULL DEFAULT 0,
  keywords     TEXT NOT NULL DEFAULT '[]',
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE trend_signals (
  trend_id  TEXT NOT NULL REFERENCES trends(id) ON DELETE CASCADE,
  signal_id TEXT NOT NULL REFERENCES market_signals(id) ON DELETE CASCADE,
  weight    REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (trend_id, signal_id)
);

CREATE TABLE market_gaps (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  gap_type       TEXT NOT NULL,
  audience       TEXT NOT NULL DEFAULT '',
  category       TEXT NOT NULL DEFAULT 'general',
  trend_id       TEXT REFERENCES trends(id) ON DELETE SET NULL,
  factory_run_id TEXT,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  confidence     REAL NOT NULL DEFAULT 0.5,
  status         TEXT NOT NULL DEFAULT 'DISCOVERED',
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_gaps_run ON market_gaps(factory_run_id);

CREATE TABLE gap_evidence (
  gap_id      TEXT NOT NULL REFERENCES market_gaps(id) ON DELETE CASCADE,
  signal_id   TEXT REFERENCES market_signals(id) ON DELETE CASCADE,
  document_id TEXT REFERENCES research_documents(id) ON DELETE CASCADE,
  weight      REAL NOT NULL DEFAULT 1,
  note        TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (gap_id, signal_id, document_id)
);

CREATE TABLE opportunities (
  id                 TEXT PRIMARY KEY,
  gap_id             TEXT NOT NULL REFERENCES market_gaps(id) ON DELETE CASCADE,
  factory_run_id     TEXT,
  title              TEXT NOT NULL,
  demand_score       REAL NOT NULL,
  competition_score  REAL NOT NULL,
  pain_score         REAL NOT NULL,
  growth_score       REAL NOT NULL,
  monetization_score REAL NOT NULL,
  feasibility_score  REAL NOT NULL,
  originality_score  REAL NOT NULL,
  timing_score       REAL NOT NULL,
  data_confidence    REAL NOT NULL,
  opportunity_score  REAL NOT NULL,
  scoring_version    TEXT NOT NULL,
  scoring_breakdown  TEXT NOT NULL DEFAULT '{}',
  rationale          TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'PROPOSED',
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_opportunities_score ON opportunities(opportunity_score DESC);
CREATE INDEX idx_opportunities_run ON opportunities(factory_run_id);

CREATE TABLE competitors (
  id                   TEXT PRIMARY KEY,
  opportunity_id       TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  url                  TEXT NOT NULL DEFAULT '',
  platform             TEXT NOT NULL DEFAULT '',
  pricing              TEXT NOT NULL DEFAULT '',
  users_estimate       TEXT NOT NULL DEFAULT '',
  rating               REAL,
  strengths            TEXT NOT NULL DEFAULT '[]',
  weaknesses           TEXT NOT NULL DEFAULT '[]',
  complaints           TEXT NOT NULL DEFAULT '[]',
  monetization         TEXT NOT NULL DEFAULT '',
  evidence_document_id TEXT REFERENCES research_documents(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL
);
CREATE INDEX idx_competitors_opportunity ON competitors(opportunity_id);

CREATE TABLE product_concepts (
  id                TEXT PRIMARY KEY,
  opportunity_id    TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  factory_run_id    TEXT,
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL,
  product_type      TEXT NOT NULL,
  tagline           TEXT NOT NULL DEFAULT '',
  target_users      TEXT NOT NULL DEFAULT '[]',
  core_problem      TEXT NOT NULL DEFAULT '',
  solution          TEXT NOT NULL DEFAULT '',
  usp               TEXT NOT NULL DEFAULT '',
  features          TEXT NOT NULL DEFAULT '[]',
  gameplay          TEXT NOT NULL DEFAULT '{}',
  monetization      TEXT NOT NULL DEFAULT '{}',
  tech_architecture TEXT NOT NULL DEFAULT '{}',
  required_assets   TEXT NOT NULL DEFAULT '[]',
  development_plan  TEXT NOT NULL DEFAULT '[]',
  risks             TEXT NOT NULL DEFAULT '[]',
  brand             TEXT NOT NULL DEFAULT '{}',
  originality_score REAL NOT NULL DEFAULT 0,
  similarity_report TEXT NOT NULL DEFAULT '{}',
  decision_summary  TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'PROPOSED',
  revision          INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- ---------------------------------------------------------------- projects --
CREATE TABLE projects (
  id             TEXT PRIMARY KEY,
  concept_id     TEXT REFERENCES product_concepts(id) ON DELETE SET NULL,
  user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL CHECK (kind IN ('app','game','hybrid')),
  description    TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'DISCOVERED',
  version        INTEGER NOT NULL DEFAULT 1,
  version_name   TEXT NOT NULL DEFAULT '0.1.0',
  application_id TEXT NOT NULL DEFAULT '',
  workspace_path TEXT NOT NULL,
  brand          TEXT NOT NULL DEFAULT '{}',
  metadata       TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  archived_at    TEXT
);
CREATE INDEX idx_projects_status ON projects(status);

CREATE TABLE project_versions (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  author_type  TEXT NOT NULL DEFAULT 'agent',
  author_id    TEXT NOT NULL DEFAULT '',
  summary      TEXT NOT NULL DEFAULT '',
  diff_stats   TEXT NOT NULL DEFAULT '{}',
  changes      TEXT NOT NULL DEFAULT '[]',
  snapshot_path TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  UNIQUE (project_id, version)
);

CREATE TABLE project_file_index (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  language   TEXT NOT NULL DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,
  hash       TEXT NOT NULL,
  symbols    TEXT NOT NULL DEFAULT '[]',
  imports    TEXT NOT NULL DEFAULT '[]',
  summary    TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, path)
);

-- ------------------------------------------------------------------ assets --
CREATE TABLE assets (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  width      INTEGER NOT NULL DEFAULT 0,
  height     INTEGER NOT NULL DEFAULT 0,
  bytes      INTEGER NOT NULL DEFAULT 0,
  sha256     TEXT NOT NULL,
  generator  TEXT NOT NULL,
  params     TEXT NOT NULL DEFAULT '{}',
  validated  INTEGER NOT NULL DEFAULT 0,
  validation TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (project_id, path)
);

CREATE TABLE asset_generations (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_id   TEXT REFERENCES assets(id) ON DELETE SET NULL,
  request    TEXT NOT NULL DEFAULT '{}',
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL,
  cost_usd   REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at TEXT NOT NULL
);

-- ------------------------------------------------------------------ builds --
CREATE TABLE builds (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target        TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'release',
  status        TEXT NOT NULL,
  version_name  TEXT NOT NULL DEFAULT '',
  version_code  INTEGER NOT NULL DEFAULT 1,
  exit_code     INTEGER,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  log_path      TEXT NOT NULL DEFAULT '',
  error_summary TEXT NOT NULL DEFAULT '',
  diagnostics   TEXT NOT NULL DEFAULT '[]',
  toolchain     TEXT NOT NULL DEFAULT '{}',
  started_at    TEXT,
  finished_at   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_builds_project ON builds(project_id, created_at DESC);

CREATE TABLE build_artifacts (
  id             TEXT PRIMARY KEY,
  build_id       TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  filename       TEXT NOT NULL,
  path           TEXT NOT NULL,
  bytes          INTEGER NOT NULL,
  sha256         TEXT NOT NULL,
  signed         INTEGER NOT NULL DEFAULT 0,
  signature_info TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL
);

CREATE TABLE previews (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  build_id   TEXT REFERENCES builds(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL,
  url        TEXT NOT NULL,
  status     TEXT NOT NULL,
  metrics    TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  started_at TEXT,
  stopped_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE test_runs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  build_id    TEXT REFERENCES builds(id) ON DELETE SET NULL,
  suite       TEXT NOT NULL,
  status      TEXT NOT NULL,
  total       INTEGER NOT NULL DEFAULT 0,
  passed      INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  report      TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);

CREATE TABLE security_scans (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  build_id   TEXT REFERENCES builds(id) ON DELETE SET NULL,
  status     TEXT NOT NULL,
  findings   TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

-- ------------------------------------------------------------------ agents --
CREATE TABLE agents (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  role               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  default_model_tier TEXT NOT NULL DEFAULT 'balanced',
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL
);

CREATE TABLE factory_runs (
  id           TEXT PRIMARY KEY,
  trigger      TEXT NOT NULL,
  mode         TEXT NOT NULL,
  status       TEXT NOT NULL,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  project_id   TEXT REFERENCES projects(id) ON DELETE SET NULL,
  constraints  TEXT NOT NULL DEFAULT '{}',
  current_step TEXT NOT NULL DEFAULT '',
  checkpoint   TEXT NOT NULL DEFAULT '{}',
  result       TEXT NOT NULL DEFAULT '{}',
  error        TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_factory_runs_created ON factory_runs(created_at DESC);

CREATE TABLE agent_runs (
  id             TEXT PRIMARY KEY,
  factory_run_id TEXT REFERENCES factory_runs(id) ON DELETE CASCADE,
  project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
  agent_name     TEXT NOT NULL,
  step           TEXT NOT NULL,
  status         TEXT NOT NULL,
  input          TEXT NOT NULL DEFAULT '{}',
  output         TEXT NOT NULL DEFAULT '{}',
  error          TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  tokens_in      INTEGER NOT NULL DEFAULT 0,
  tokens_out     INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  started_at     TEXT,
  finished_at    TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_agent_runs_factory ON agent_runs(factory_run_id, created_at);

CREATE TABLE agent_messages (
  id           TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  content      TEXT NOT NULL,
  metadata     TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);

CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  factory_run_id TEXT REFERENCES factory_runs(id) ON DELETE CASCADE,
  project_id     TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  priority       INTEGER NOT NULL DEFAULT 100,
  payload        TEXT NOT NULL DEFAULT '{}',
  result         TEXT NOT NULL DEFAULT '{}',
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 3,
  idempotency_key TEXT UNIQUE,
  available_at   TEXT NOT NULL,
  locked_at      TEXT,
  locked_by      TEXT,
  error          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_tasks_queue ON tasks(status, available_at, priority);

-- -------------------------------------------------------------------- chat --
CREATE TABLE chat_threads (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT 'New conversation',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE chat_messages (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  tool_calls TEXT NOT NULL DEFAULT '[]',
  metadata   TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_chat_messages_thread ON chat_messages(thread_id, created_at);

-- --------------------------------------------------------------- knowledge --
CREATE TABLE knowledge_items (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  key          TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '[]',
  importance   REAL NOT NULL DEFAULT 0.5,
  source_type  TEXT NOT NULL DEFAULT '',
  source_id    TEXT,
  embedding_id TEXT,
  hits         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (kind, key)
);
CREATE INDEX idx_knowledge_kind ON knowledge_items(kind, importance DESC);

CREATE TABLE embeddings (
  id         TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id   TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL,
  dims       INTEGER NOT NULL,
  vector     BLOB NOT NULL,
  norm       REAL NOT NULL DEFAULT 1,
  text_hash  TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_embeddings_owner ON embeddings(owner_type, owner_id);
CREATE INDEX idx_embeddings_hash ON embeddings(text_hash, model);

-- ------------------------------------------------------------------- cache --
CREATE TABLE cache_entries (
  key          TEXT PRIMARY KEY,
  namespace    TEXT NOT NULL,
  value        BLOB NOT NULL,
  is_json      INTEGER NOT NULL DEFAULT 1,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  hits         INTEGER NOT NULL DEFAULT 0,
  embedding_id TEXT REFERENCES embeddings(id) ON DELETE SET NULL,
  meta         TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_hit_at  TEXT
);
CREATE INDEX idx_cache_ns ON cache_entries(namespace, expires_at);

CREATE TABLE http_cache (
  url_hash      TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  status        INTEGER NOT NULL,
  etag          TEXT,
  last_modified TEXT,
  headers       TEXT NOT NULL DEFAULT '{}',
  body          BLOB NOT NULL,
  content_hash  TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

-- ----------------------------------------------------------- observability --
CREATE TABLE api_usage (
  id             TEXT PRIMARY KEY,
  ts             TEXT NOT NULL,
  provider       TEXT NOT NULL,
  kind           TEXT NOT NULL,
  model          TEXT NOT NULL DEFAULT '',
  operation      TEXT NOT NULL DEFAULT '',
  tokens_in      INTEGER NOT NULL DEFAULT 0,
  tokens_out     INTEGER NOT NULL DEFAULT 0,
  units          REAL NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  saved_usd      REAL NOT NULL DEFAULT 0,
  cache_hit      TEXT NOT NULL DEFAULT 'miss',
  latency_ms     INTEGER NOT NULL DEFAULT 0,
  success        INTEGER NOT NULL DEFAULT 1,
  error_code     TEXT,
  project_id     TEXT,
  factory_run_id TEXT,
  agent_run_id   TEXT
);
CREATE INDEX idx_api_usage_ts ON api_usage(ts DESC);
CREATE INDEX idx_api_usage_project ON api_usage(project_id);

CREATE TABLE metrics (
  id     TEXT PRIMARY KEY,
  ts     TEXT NOT NULL,
  name   TEXT NOT NULL,
  value  REAL NOT NULL,
  labels TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_metrics_name_ts ON metrics(name, ts DESC);

CREATE TABLE schedules (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  cron         TEXT NOT NULL,
  job          TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  payload      TEXT NOT NULL DEFAULT '{}',
  last_run_at  TEXT,
  last_status  TEXT,
  next_run_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
`;

const M002 = `
-- Full-text search over research documents and knowledge, used by the research
-- deduplicator and by the coding agent's context selector.
CREATE VIRTUAL TABLE research_documents_fts USING fts5(
  title, content, keywords,
  content='research_documents', content_rowid='rowid'
);

CREATE TRIGGER research_documents_ai AFTER INSERT ON research_documents BEGIN
  INSERT INTO research_documents_fts(rowid, title, content, keywords)
  VALUES (new.rowid, new.title, new.content, new.keywords);
END;
CREATE TRIGGER research_documents_ad AFTER DELETE ON research_documents BEGIN
  INSERT INTO research_documents_fts(research_documents_fts, rowid, title, content, keywords)
  VALUES ('delete', old.rowid, old.title, old.content, old.keywords);
END;
CREATE TRIGGER research_documents_au AFTER UPDATE ON research_documents BEGIN
  INSERT INTO research_documents_fts(research_documents_fts, rowid, title, content, keywords)
  VALUES ('delete', old.rowid, old.title, old.content, old.keywords);
  INSERT INTO research_documents_fts(rowid, title, content, keywords)
  VALUES (new.rowid, new.title, new.content, new.keywords);
END;

CREATE VIRTUAL TABLE knowledge_items_fts USING fts5(
  title, content, tags,
  content='knowledge_items', content_rowid='rowid'
);

CREATE TRIGGER knowledge_items_ai AFTER INSERT ON knowledge_items BEGIN
  INSERT INTO knowledge_items_fts(rowid, title, content, tags)
  VALUES (new.rowid, new.title, new.content, new.tags);
END;
CREATE TRIGGER knowledge_items_ad AFTER DELETE ON knowledge_items BEGIN
  INSERT INTO knowledge_items_fts(knowledge_items_fts, rowid, title, content, tags)
  VALUES ('delete', old.rowid, old.title, old.content, old.tags);
END;
CREATE TRIGGER knowledge_items_au AFTER UPDATE ON knowledge_items BEGIN
  INSERT INTO knowledge_items_fts(knowledge_items_fts, rowid, title, content, tags)
  VALUES ('delete', old.rowid, old.title, old.content, old.tags);
  INSERT INTO knowledge_items_fts(rowid, title, content, tags)
  VALUES (new.rowid, new.title, new.content, new.tags);
END;
`;


const M003 = `
-- Durable memory of every failure the factory has seen and of the change that
-- actually resolved it. Consulted before any repair so a mistake is never made
-- twice, and so a fix that is known to work is preferred over improvisation.
CREATE TABLE error_memories (
  id            TEXT PRIMARY KEY,
  signature     TEXT NOT NULL,
  category      TEXT NOT NULL,
  phase         TEXT NOT NULL,
  message       TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '',
  file_path     TEXT,
  project_id    TEXT,
  occurrences   INTEGER NOT NULL DEFAULT 1,
  resolved      INTEGER NOT NULL DEFAULT 0,
  fix_summary   TEXT NOT NULL DEFAULT '',
  fix_diff      TEXT NOT NULL DEFAULT '',
  fix_rationale TEXT NOT NULL DEFAULT '',
  verified_by   TEXT NOT NULL DEFAULT '',
  verified_at   TEXT,
  reuse_count   INTEGER NOT NULL DEFAULT 0,
  embedding_id  TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  UNIQUE (signature)
);
CREATE INDEX idx_error_memories_category ON error_memories(category, resolved);
CREATE INDEX idx_error_memories_seen ON error_memories(last_seen_at DESC);

-- Improvements the factory proposes to its own source after observing an
-- outcome. Reviewed and applied by the self-improvement loop.
CREATE TABLE improvement_proposals (
  id             TEXT PRIMARY KEY,
  target         TEXT NOT NULL,
  area           TEXT NOT NULL,
  title          TEXT NOT NULL,
  rationale      TEXT NOT NULL,
  evidence       TEXT NOT NULL DEFAULT '[]',
  expected_gain  TEXT NOT NULL DEFAULT '',
  risk           TEXT NOT NULL DEFAULT 'unknown',
  priority       REAL NOT NULL DEFAULT 0.5,
  status         TEXT NOT NULL DEFAULT 'proposed',
  applied_diff   TEXT NOT NULL DEFAULT '',
  measurement    TEXT NOT NULL DEFAULT '{}',
  project_id     TEXT,
  factory_run_id TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_improvements_status ON improvement_proposals(status, priority DESC);

-- Every repair attempt is audited against the no-regression policy so a change
-- that "fixes" a failure by deleting behaviour is rejected and recorded.
CREATE TABLE repair_audits (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  attempt      INTEGER NOT NULL,
  file_path    TEXT NOT NULL,
  verdict      TEXT NOT NULL,
  violations   TEXT NOT NULL DEFAULT '[]',
  metrics      TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_repair_audits_project ON repair_audits(project_id, created_at DESC);
`;

const M004 = `
-- The recipe library.
--
-- Every asset the factory authors is a piece of expensive, hard-won knowledge:
-- a model spent tokens working out how a lantern is proportioned, the
-- interpreter proved the geometry builds, and a vision critic confirmed by
-- looking that it reads as the thing that was asked for. Discarding that after
-- the GLB is written means paying for it again tomorrow.
--
-- The recipe is stored rather than the GLB. A recipe is a few kilobytes of JSON
-- that rebuilds to a byte-identical mesh in milliseconds for any palette and
-- seed, so keeping it is cheaper than keeping the binary and strictly more
-- useful: it can be reused verbatim, recoloured, adapted by a later model as a
-- starting point, or shown as a worked example of a category that scored well.
CREATE TABLE asset_recipes (
  id             TEXT PRIMARY KEY,
  -- Hash of the normalised request text; the exact-hit key for reuse.
  request_hash   TEXT NOT NULL,
  request        TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT 'other',
  name           TEXT NOT NULL,
  subject        TEXT NOT NULL DEFAULT '',
  brief          TEXT NOT NULL DEFAULT '{}',
  recipe         TEXT NOT NULL,
  step_count     INTEGER NOT NULL DEFAULT 0,
  triangle_count INTEGER NOT NULL DEFAULT 0,
  -- The critic's score for the best build of this recipe, 0-100.
  score          REAL NOT NULL DEFAULT 0,
  accepted       INTEGER NOT NULL DEFAULT 0,
  rounds         INTEGER NOT NULL DEFAULT 1,
  -- Identity of the mesh this recipe produced under the recorded palette/seed,
  -- so a rebuild that no longer matches is detectable rather than silent.
  glb_sha256     TEXT NOT NULL DEFAULT '',
  glb_bytes      INTEGER NOT NULL DEFAULT 0,
  palette        TEXT NOT NULL DEFAULT '[]',
  seed           INTEGER NOT NULL DEFAULT 0,
  embedding_id   TEXT,
  reuse_count    INTEGER NOT NULL DEFAULT 0,
  project_id     TEXT,
  factory_run_id TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (request_hash)
);
CREATE INDEX idx_asset_recipes_quality ON asset_recipes(accepted DESC, score DESC);
CREATE INDEX idx_asset_recipes_category ON asset_recipes(category, score DESC);
CREATE INDEX idx_asset_recipes_reuse ON asset_recipes(reuse_count DESC);

-- One row per review round, kept even for rounds that were later superseded.
-- The superseded rounds are the valuable ones: they are the record of what the
-- author got wrong before it got it right, which is what the failure-mode
-- statistics are computed from and what the self-improvement loop reads.
CREATE TABLE asset_reviews (
  id             TEXT PRIMARY KEY,
  recipe_id      TEXT NOT NULL REFERENCES asset_recipes(id) ON DELETE CASCADE,
  round          INTEGER NOT NULL,
  score          REAL NOT NULL DEFAULT 0,
  accepted       INTEGER NOT NULL DEFAULT 0,
  silhouette_ok  INTEGER NOT NULL DEFAULT 0,
  summary        TEXT NOT NULL DEFAULT '',
  -- The critic's full verdict, criterion by criterion. Stored whole because a
  -- reused recipe is served with the verdict that earned it rather than with a
  -- fresh review, and a summary line cannot stand in for that.
  verdict        TEXT NOT NULL DEFAULT '{}',
  failures       TEXT NOT NULL DEFAULT '[]',
  triangle_count INTEGER NOT NULL DEFAULT 0,
  view_count     INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_asset_reviews_recipe ON asset_reviews(recipe_id, round);
CREATE INDEX idx_asset_reviews_recent ON asset_reviews(created_at DESC);

-- Acceptance criteria that fail across many different assets. A criterion that
-- keeps failing is not a fact about one lantern, it is a gap in the operator
-- kernel or in the authoring prompt, and that is a change to this codebase
-- rather than to any single recipe.
CREATE TABLE asset_failure_modes (
  id           TEXT PRIMARY KEY,
  signature    TEXT NOT NULL,
  criterion    TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'other',
  occurrences  INTEGER NOT NULL DEFAULT 1,
  recoveries   INTEGER NOT NULL DEFAULT 0,
  last_step    TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  UNIQUE (signature)
);
CREATE INDEX idx_asset_failure_modes_rank ON asset_failure_modes(occurrences DESC);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial_schema', sql: M001 },
  { version: 2, name: 'full_text_search', sql: M002 },
  { version: 3, name: 'error_memory_and_self_improvement', sql: M003 },
  { version: 4, name: 'recipe_library', sql: M004 },
];
