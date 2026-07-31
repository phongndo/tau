const std = @import("std");
const limits = @import("limits.zig");
const sqlite = @import("sqlite");

pub const event_log_refs_max = limits.db_event_log_refs_max;
pub const search_results_max = limits.db_search_results_max;

/// Fresh mux-core schema. Workflow tables are intentionally absent.
pub const migration_001_mux_sessions =
    \\CREATE TABLE IF NOT EXISTS terminal_sessions (
    \\    id                 TEXT PRIMARY KEY,
    \\    terminal_id        TEXT NOT NULL,
    \\    cwd                TEXT,
    \\    argv_json          TEXT,
    \\    status             TEXT NOT NULL CHECK(status IN (
    \\        'live', 'detached', 'exited', 'crashed', 'archived', 'killed'
    \\    )),
    \\    daemon_id          TEXT,
    \\    pid                INTEGER,
    \\    cols               INTEGER NOT NULL,
    \\    rows               INTEGER NOT NULL,
    \\    title              TEXT,
    \\    event_log_path     TEXT NOT NULL,
    \\    last_seq           INTEGER NOT NULL DEFAULT 0,
    \\    snapshot_path      TEXT,
    \\    snapshot_seq       INTEGER NOT NULL DEFAULT 0,
    \\    snapshot_crc32     INTEGER,
    \\    snapshot_size      INTEGER,
    \\    scrollback_excerpt TEXT,
    \\    started_at         TEXT NOT NULL,
    \\    last_activity_at   TEXT,
    \\    ended_at           TEXT,
    \\    exit_code          INTEGER,
    \\    signal             INTEGER,
    \\    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    \\    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    \\) STRICT;
    \\CREATE INDEX IF NOT EXISTS idx_terminal_sessions_terminal ON terminal_sessions(terminal_id);
    \\CREATE INDEX IF NOT EXISTS idx_terminal_sessions_status ON terminal_sessions(status);
    \\CREATE INDEX IF NOT EXISTS idx_terminal_sessions_activity ON terminal_sessions(last_activity_at);
    \\CREATE VIRTUAL TABLE IF NOT EXISTS terminal_search USING fts5(
    \\    terminal_session_id UNINDEXED,
    \\    title,
    \\    excerpt,
    \\    tokenize = 'unicode61'
    \\);
;

pub const migrations = [_][]const u8{migration_001_mux_sessions};

/// Mux terminal_sessions body without IF NOT EXISTS — used when creating or rebuilding.
const terminal_sessions_table_sql =
    \\CREATE TABLE terminal_sessions (
    \\    id                 TEXT PRIMARY KEY,
    \\    terminal_id        TEXT NOT NULL,
    \\    cwd                TEXT,
    \\    argv_json          TEXT,
    \\    status             TEXT NOT NULL CHECK(status IN (
    \\        'live', 'detached', 'exited', 'crashed', 'archived', 'killed'
    \\    )),
    \\    daemon_id          TEXT,
    \\    pid                INTEGER,
    \\    cols               INTEGER NOT NULL,
    \\    rows               INTEGER NOT NULL,
    \\    title              TEXT,
    \\    event_log_path     TEXT NOT NULL,
    \\    last_seq           INTEGER NOT NULL DEFAULT 0,
    \\    snapshot_path      TEXT,
    \\    snapshot_seq       INTEGER NOT NULL DEFAULT 0,
    \\    snapshot_crc32     INTEGER,
    \\    snapshot_size      INTEGER,
    \\    scrollback_excerpt TEXT,
    \\    started_at         TEXT NOT NULL,
    \\    last_activity_at   TEXT,
    \\    ended_at           TEXT,
    \\    exit_code          INTEGER,
    \\    signal             INTEGER,
    \\    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    \\    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    \\) STRICT;
;

const terminal_sessions_indexes_sql =
    \\CREATE INDEX IF NOT EXISTS idx_terminal_sessions_terminal ON terminal_sessions(terminal_id);
    \\CREATE INDEX IF NOT EXISTS idx_terminal_sessions_status ON terminal_sessions(status);
    \\CREATE INDEX IF NOT EXISTS idx_terminal_sessions_activity ON terminal_sessions(last_activity_at);
;

const copy_terminal_sessions_from_pre_mux_sql =
    \\INSERT INTO terminal_sessions (
    \\    id, terminal_id, cwd, argv_json, status, daemon_id, pid,
    \\    cols, rows, title, event_log_path, last_seq,
    \\    snapshot_path, snapshot_seq, snapshot_crc32, snapshot_size,
    \\    scrollback_excerpt, started_at, last_activity_at, ended_at,
    \\    exit_code, signal, created_at, updated_at
    \\)
    \\SELECT
    \\    id, terminal_id, cwd, argv_json, status, daemon_id, pid,
    \\    cols, rows, title, event_log_path, last_seq,
    \\    snapshot_path, snapshot_seq, snapshot_crc32, snapshot_size,
    \\    scrollback_excerpt, started_at, last_activity_at, ended_at,
    \\    exit_code, signal, created_at, updated_at
    \\FROM terminal_sessions_pre_mux;
;

const create_migrations_table_sql =
    \\CREATE TABLE IF NOT EXISTS mux_schema_migrations (
    \\    version INTEGER PRIMARY KEY,
    \\    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    \\) STRICT;
;

const ensure_terminal_search_sql =
    \\CREATE VIRTUAL TABLE IF NOT EXISTS terminal_search USING fts5(
    \\    terminal_session_id UNINDEXED,
    \\    title,
    \\    excerpt,
    \\    tokenize = 'unicode61'
    \\);
;

const upsert_terminal_session_sql =
    \\INSERT INTO terminal_sessions (
    \\    id, terminal_id, cwd, argv_json, status, daemon_id, pid,
    \\    cols, rows, title, event_log_path, last_seq,
    \\    snapshot_path, snapshot_seq, snapshot_crc32, snapshot_size,
    \\    started_at, last_activity_at
    \\) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    \\ON CONFLICT(id) DO UPDATE SET
    \\    terminal_id = excluded.terminal_id,
    \\    cwd = excluded.cwd,
    \\    argv_json = COALESCE(excluded.argv_json, terminal_sessions.argv_json),
    \\    status = excluded.status,
    \\    daemon_id = excluded.daemon_id,
    \\    pid = excluded.pid,
    \\    cols = excluded.cols,
    \\    rows = excluded.rows,
    \\    title = COALESCE(excluded.title, terminal_sessions.title),
    \\    event_log_path = excluded.event_log_path,
    \\    last_seq = excluded.last_seq,
    \\    snapshot_path = COALESCE(excluded.snapshot_path, terminal_sessions.snapshot_path),
    \\    snapshot_seq = CASE WHEN excluded.snapshot_path IS NULL THEN terminal_sessions.snapshot_seq ELSE excluded.snapshot_seq END,
    \\    snapshot_crc32 = CASE WHEN excluded.snapshot_path IS NULL THEN terminal_sessions.snapshot_crc32 ELSE excluded.snapshot_crc32 END,
    \\    snapshot_size = CASE WHEN excluded.snapshot_path IS NULL THEN terminal_sessions.snapshot_size ELSE excluded.snapshot_size END,
    \\    last_activity_at = datetime('now');
;

const update_terminal_ended_sql =
    \\UPDATE terminal_sessions
    \\SET status = ?, pid = NULL, cols = ?, rows = ?, last_seq = ?,
    \\    ended_at = datetime('now'), last_activity_at = datetime('now'),
    \\    exit_code = ?, signal = ?
    \\WHERE id = ?;
;

const find_terminal_by_id_sql =
    \\SELECT id, terminal_id, cwd, argv_json, status, cols, rows, event_log_path, last_seq
    \\FROM terminal_sessions WHERE id = ? LIMIT 1;
;

const find_terminal_by_terminal_id_sql =
    \\SELECT id, terminal_id, cwd, argv_json, status, cols, rows, event_log_path, last_seq
    \\FROM terminal_sessions WHERE terminal_id = ? ORDER BY updated_at DESC LIMIT 1;
;

const list_terminal_event_logs_sql =
    \\SELECT id, event_log_path FROM terminal_sessions;
;

const clear_terminal_history_metadata_sql =
    \\UPDATE terminal_sessions
    \\SET scrollback_excerpt = NULL, last_seq = 0, snapshot_path = NULL,
    \\    snapshot_seq = 0, snapshot_crc32 = NULL, snapshot_size = NULL,
    \\    last_activity_at = datetime('now')
    \\WHERE id = ?;
;

const delete_terminal_search_sql =
    \\DELETE FROM terminal_search WHERE terminal_session_id = ?;
;
const delete_terminal_session_sql =
    \\DELETE FROM terminal_sessions WHERE id = ?;
;
const insert_terminal_search_sql =
    \\INSERT INTO terminal_search (terminal_session_id, title, excerpt) VALUES (?, ?, ?);
;
const search_terminal_excerpts_sql =
    \\SELECT terminal_session_id, title, excerpt FROM terminal_search
    \\WHERE terminal_search MATCH ? LIMIT ?;
;

pub const TerminalSessionRecord = struct {
    id: []const u8,
    terminal_id: []const u8,
    cwd: ?[]const u8 = null,
    argv_json: ?[]const u8 = null,
    status: []const u8,
    daemon_id: ?[]const u8 = null,
    pid: ?i64 = null,
    cols: u16,
    rows: u16,
    title: ?[]const u8 = null,
    event_log_path: []const u8,
    last_seq: u64,
    snapshot_path: ?[]const u8 = null,
    snapshot_seq: u64 = 0,
    snapshot_crc32: ?u32 = null,
    snapshot_size: ?usize = null,
};

pub const TerminalEndedRecord = struct {
    id: []const u8,
    status: []const u8,
    cols: u16,
    rows: u16,
    last_seq: u64,
    exit_code: i32,
    signal: i32,
};

pub const TerminalSessionLookup = struct {
    id: []u8,
    terminal_id: []u8,
    cwd: ?[]u8,
    argv_json: ?[]u8,
    status: []u8,
    cols: u16,
    rows: u16,
    event_log_path: []u8,
    last_seq: u64,

    pub fn deinit(self: *TerminalSessionLookup, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        allocator.free(self.terminal_id);
        if (self.cwd) |value| allocator.free(value);
        if (self.argv_json) |value| allocator.free(value);
        allocator.free(self.status);
        allocator.free(self.event_log_path);
        self.* = undefined;
    }
};

pub const TerminalEventLogRef = struct {
    id: []u8,
    event_log_path: []u8,

    pub fn deinit(self: *TerminalEventLogRef, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        allocator.free(self.event_log_path);
        self.* = undefined;
    }
};

pub const TerminalSearchRecord = struct {
    terminal_session_id: []const u8,
    title: ?[]const u8 = null,
    excerpt: []const u8,
};

pub const TerminalSearchResult = struct {
    terminal_session_id: []u8,
    title: ?[]u8,
    excerpt: []u8,

    pub fn deinit(self: *TerminalSearchResult, allocator: std.mem.Allocator) void {
        allocator.free(self.terminal_session_id);
        if (self.title) |value| allocator.free(value);
        allocator.free(self.excerpt);
        self.* = undefined;
    }
};

pub const Database = struct {
    allocator: std.mem.Allocator,
    handle: sqlite.Db,

    const open_flags = sqlite.Db.OpenFlags{ .write = true, .create = true };
    const threading_mode = sqlite.ThreadingMode.MultiThread;

    pub fn open(allocator: std.mem.Allocator, path: []const u8) !Database {
        const path_z = try allocator.dupeZ(u8, path);
        defer allocator.free(path_z);
        var diags = sqlite.Diagnostics{};
        const handle = sqlite.Db.init(.{
            .mode = .{ .File = path_z },
            .open_flags = open_flags,
            .threading_mode = threading_mode,
            .diags = &diags,
        }) catch |err| {
            std.log.err("failed to open sqlite database {s}: {f}", .{ path, diags });
            return err;
        };
        return initOpened(allocator, handle);
    }

    pub fn openInMemory(allocator: std.mem.Allocator) !Database {
        var diags = sqlite.Diagnostics{};
        const handle = try sqlite.Db.init(.{
            .mode = .Memory,
            .open_flags = open_flags,
            .threading_mode = threading_mode,
            .diags = &diags,
        });
        return initOpened(allocator, handle);
    }

    fn initOpened(allocator: std.mem.Allocator, handle: sqlite.Db) !Database {
        var database = Database{ .allocator = allocator, .handle = handle };
        errdefer database.deinit();
        try database.configure();
        return database;
    }

    pub fn deinit(self: *Database) void {
        self.handle.deinit();
        self.* = undefined;
    }

    fn configure(self: *Database) !void {
        _ = try self.handle.one([32:0]u8, "PRAGMA journal_mode = WAL;", .{}, .{});
        _ = try self.handle.one(u32, "PRAGMA busy_timeout = 5000;", .{}, .{});
        // Existing pre-mux databases are intentionally stripped in place; terminal rows/logs survive
        // via ensureTerminalSessionsSchema() which rebuilds legacy terminal_sessions tables.
        try self.handle.exec("PRAGMA foreign_keys = OFF;", .{}, .{});
        try self.exec("DROP TABLE IF EXISTS terminal_search;");
        try self.exec("DROP TABLE IF EXISTS agent_sessions;");
        try self.exec("DROP TABLE IF EXISTS worktrees;");
        try self.exec("DROP TABLE IF EXISTS workspaces;");
        try self.migrate();
        try self.handle.exec("PRAGMA foreign_keys = ON;", .{}, .{});
    }

    pub fn migrate(self: *Database) !void {
        try self.exec(create_migrations_table_sql);
        try self.ensureTerminalSessionsSchema();
        try self.exec(ensure_terminal_search_sql);
        try self.handle.exec(
            "INSERT OR IGNORE INTO mux_schema_migrations(version) VALUES (1);",
            .{},
            .{},
        );
    }

    /// Create mux terminal_sessions, or rebuild a pre-mux table while copying compatible rows.
    fn ensureTerminalSessionsSchema(self: *Database) !void {
        const has_pre_mux = try self.tableExists("terminal_sessions_pre_mux");
        if (has_pre_mux) {
            // Prior open crashed mid-rebuild: pre_mux is the only complete copy — never drop it first.
            try self.finishTerminalSessionsRebuildFromPreMux();
            return;
        }

        const has_main = try self.tableExists("terminal_sessions");
        if (!has_main) {
            try self.exec(terminal_sessions_table_sql);
            try self.exec(terminal_sessions_indexes_sql);
            return;
        }

        if (!try self.terminalSessionsNeedsRebuild()) {
            try self.exec(terminal_sessions_indexes_sql);
            return;
        }

        try self.rebuildTerminalSessionsFromLegacy();
    }

    fn rebuildTerminalSessionsFromLegacy(self: *Database) !void {
        try self.exec("BEGIN IMMEDIATE;");
        errdefer _ = self.exec("ROLLBACK;");
        try self.exec("ALTER TABLE terminal_sessions RENAME TO terminal_sessions_pre_mux;");
        try self.exec(terminal_sessions_table_sql);
        try self.exec(copy_terminal_sessions_from_pre_mux_sql);
        try self.exec("DROP TABLE terminal_sessions_pre_mux;");
        try self.exec(terminal_sessions_indexes_sql);
        try self.exec("COMMIT;");
    }

    fn finishTerminalSessionsRebuildFromPreMux(self: *Database) !void {
        try self.exec("BEGIN IMMEDIATE;");
        errdefer _ = self.exec("ROLLBACK;");
        // Incomplete new table from a crash after rename/create — discard and rebuild from backup.
        try self.exec("DROP TABLE IF EXISTS terminal_sessions;");
        try self.exec(terminal_sessions_table_sql);
        try self.exec(copy_terminal_sessions_from_pre_mux_sql);
        try self.exec("DROP TABLE terminal_sessions_pre_mux;");
        try self.exec(terminal_sessions_indexes_sql);
        try self.exec("COMMIT;");
    }

    fn tableExists(self: *Database, comptime name: []const u8) !bool {
        const count = try self.handle.one(
            u64,
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '" ++ name ++ "';",
            .{},
            .{},
        );
        return count > 0;
    }

    fn terminalSessionsNeedsRebuild(self: *Database) !bool {
        // Pre-mux tables kept workflow columns that CREATE IF NOT EXISTS never removed. New upserts
        // omit those fields and fail when they were NOT NULL / FK-backed on the retained schema.
        const legacy_columns = try self.handle.one(
            u64,
            "SELECT COUNT(*) FROM pragma_table_info('terminal_sessions') WHERE name IN ('workspace_id', 'worktree_id');",
            .{},
            .{},
        );
        if (legacy_columns > 0) return true;

        // Also rebuild if a required mux column is missing (partial / foreign schemas).
        const required_columns = try self.handle.one(
            u64,
            "SELECT COUNT(*) FROM pragma_table_info('terminal_sessions') WHERE name IN ('terminal_id', 'event_log_path', 'last_seq', 'snapshot_path', 'snapshot_seq', 'started_at');",
            .{},
            .{},
        );
        return required_columns < 6;
    }

    pub fn recordTerminalSession(self: *Database, record: TerminalSessionRecord) !void {
        var stmt = try self.handle.prepareDynamic(upsert_terminal_session_sql);
        defer stmt.deinit();
        try stmt.exec(.{}, .{
            record.id,
            record.terminal_id,
            record.cwd,
            record.argv_json,
            record.status,
            record.daemon_id,
            record.pid,
            record.cols,
            record.rows,
            record.title,
            record.event_log_path,
            @as(i64, @intCast(record.last_seq)),
            record.snapshot_path,
            @as(i64, @intCast(record.snapshot_seq)),
            if (record.snapshot_crc32) |value| @as(i64, @intCast(value)) else null,
            if (record.snapshot_size) |value| @as(i64, @intCast(value)) else null,
        });
    }

    pub fn recordTerminalEnded(self: *Database, record: TerminalEndedRecord) !void {
        var stmt = try self.handle.prepareDynamic(update_terminal_ended_sql);
        defer stmt.deinit();
        try stmt.exec(.{}, .{
            record.status,
            record.cols,
            record.rows,
            @as(i64, @intCast(record.last_seq)),
            record.exit_code,
            record.signal,
            record.id,
        });
    }

    pub fn findTerminalSessionById(self: *Database, allocator: std.mem.Allocator, id: []const u8) !?TerminalSessionLookup {
        var stmt = try self.handle.prepareDynamic(find_terminal_by_id_sql);
        defer stmt.deinit();
        return stmt.oneAlloc(TerminalSessionLookup, allocator, .{}, .{id});
    }

    pub fn findTerminalSessionByTerminalId(self: *Database, allocator: std.mem.Allocator, terminal_id: []const u8) !?TerminalSessionLookup {
        var stmt = try self.handle.prepareDynamic(find_terminal_by_terminal_id_sql);
        defer stmt.deinit();
        return stmt.oneAlloc(TerminalSessionLookup, allocator, .{}, .{terminal_id});
    }

    pub fn listTerminalEventLogs(self: *Database, allocator: std.mem.Allocator) ![]TerminalEventLogRef {
        var stmt = try self.handle.prepareDynamic(list_terminal_event_logs_sql);
        defer stmt.deinit();
        var iter = try stmt.iteratorAlloc(TerminalEventLogRef, allocator, .{});
        var refs: std.ArrayList(TerminalEventLogRef) = .empty;
        errdefer {
            for (refs.items) |*item| item.deinit(allocator);
            refs.deinit(allocator);
        }
        while (try iter.nextAlloc(allocator, .{})) |row_value| {
            var row = row_value;
            errdefer row.deinit(allocator);
            if (refs.items.len >= event_log_refs_max) return error.TooManyEventLogRefs;
            try refs.append(allocator, row);
        }
        return refs.toOwnedSlice(allocator);
    }

    pub fn clearTerminalHistoryMetadata(self: *Database, session_id: []const u8) !void {
        try self.deleteSearch(session_id);
        var stmt = try self.handle.prepareDynamic(clear_terminal_history_metadata_sql);
        defer stmt.deinit();
        try stmt.exec(.{}, .{session_id});
    }

    pub fn deleteTerminalSessionMetadata(self: *Database, session_id: []const u8) !void {
        try self.deleteSearch(session_id);
        var stmt = try self.handle.prepareDynamic(delete_terminal_session_sql);
        defer stmt.deinit();
        try stmt.exec(.{}, .{session_id});
    }

    fn deleteSearch(self: *Database, session_id: []const u8) !void {
        var stmt = try self.handle.prepareDynamic(delete_terminal_search_sql);
        defer stmt.deinit();
        try stmt.exec(.{}, .{session_id});
    }

    pub fn recordTerminalSearch(self: *Database, record: TerminalSearchRecord) !void {
        try self.deleteSearch(record.terminal_session_id);
        var stmt = try self.handle.prepareDynamic(insert_terminal_search_sql);
        defer stmt.deinit();
        try stmt.exec(.{}, .{ record.terminal_session_id, record.title, record.excerpt });
    }

    pub fn searchTerminalExcerpts(self: *Database, allocator: std.mem.Allocator, query: []const u8, limit: u32) ![]TerminalSearchResult {
        if (limit > search_results_max) return error.SearchLimitTooLarge;
        var stmt = try self.handle.prepareDynamic(search_terminal_excerpts_sql);
        defer stmt.deinit();
        var iter = try stmt.iteratorAlloc(TerminalSearchResult, allocator, .{ query, limit });
        var results: std.ArrayList(TerminalSearchResult) = .empty;
        errdefer {
            for (results.items) |*item| item.deinit(allocator);
            results.deinit(allocator);
        }
        while (try iter.nextAlloc(allocator, .{})) |row_value| {
            var row = row_value;
            errdefer row.deinit(allocator);
            if (results.items.len >= search_results_max) return error.TooManySearchResults;
            try results.append(allocator, row);
        }
        return results.toOwnedSlice(allocator);
    }

    fn exec(self: *Database, sql: []const u8) !void {
        try self.handle.execDynamic(sql, .{}, .{});
    }
};

test "sqlite database stores mux terminal sessions and FTS excerpts" {
    var database = try Database.openInMemory(std.testing.allocator);
    defer database.deinit();
    try database.recordTerminalSession(.{
        .id = "session-1",
        .terminal_id = "terminal-1",
        .cwd = "/tmp",
        .argv_json = "[\"bash\"]",
        .status = "live",
        .cols = 80,
        .rows = 24,
        .event_log_path = "/tmp/events.tauev",
        .last_seq = 1,
    });
    var row = (try database.findTerminalSessionById(std.testing.allocator, "session-1")).?;
    defer row.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("terminal-1", row.terminal_id);

    try database.recordTerminalSearch(.{
        .terminal_session_id = "session-1",
        .title = "shell",
        .excerpt = "unique searchable output",
    });
    const results = try database.searchTerminalExcerpts(std.testing.allocator, "unique", 10);
    defer {
        for (results) |*result| result.deinit(std.testing.allocator);
        std.testing.allocator.free(results);
    }
    try std.testing.expectEqual(@as(usize, 1), results.len);
}

test "fresh mux schema contains no workflow tables" {
    var database = try Database.openInMemory(std.testing.allocator);
    defer database.deinit();
    const workflow_count = try database.handle.one(
        u64,
        "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('workspaces','worktrees','agent_sessions');",
        .{},
        .{},
    );
    try std.testing.expectEqual(@as(u64, 0), workflow_count);
}

test "migrates legacy terminal_sessions with workspace columns" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const path = try std.fmt.allocPrint(std.testing.allocator, ".zig-cache/tmp/{s}/legacy.sqlite", .{tmp.sub_path});
    defer std.testing.allocator.free(path);

    {
        const path_z = try std.testing.allocator.dupeZ(u8, path);
        defer std.testing.allocator.free(path_z);
        var diags = sqlite.Diagnostics{};
        var handle = try sqlite.Db.init(.{
            .mode = .{ .File = path_z },
            .open_flags = .{ .write = true, .create = true },
            .threading_mode = .MultiThread,
            .diags = &diags,
        });
        defer handle.deinit();
        // Pre-mux schema: required workspace_id makes mux upserts fail without rebuild.
        try handle.execDynamic(
            \\CREATE TABLE terminal_sessions (
            \\    id TEXT PRIMARY KEY,
            \\    terminal_id TEXT NOT NULL,
            \\    workspace_id TEXT NOT NULL,
            \\    cwd TEXT,
            \\    argv_json TEXT,
            \\    status TEXT NOT NULL,
            \\    daemon_id TEXT,
            \\    pid INTEGER,
            \\    cols INTEGER NOT NULL,
            \\    rows INTEGER NOT NULL,
            \\    title TEXT,
            \\    event_log_path TEXT NOT NULL,
            \\    last_seq INTEGER NOT NULL DEFAULT 0,
            \\    snapshot_path TEXT,
            \\    snapshot_seq INTEGER NOT NULL DEFAULT 0,
            \\    snapshot_crc32 INTEGER,
            \\    snapshot_size INTEGER,
            \\    scrollback_excerpt TEXT,
            \\    started_at TEXT NOT NULL,
            \\    last_activity_at TEXT,
            \\    ended_at TEXT,
            \\    exit_code INTEGER,
            \\    signal INTEGER,
            \\    created_at TEXT NOT NULL DEFAULT (datetime('now')),
            \\    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            \\);
            ,
            .{},
            .{},
        );
        try handle.execDynamic(
            \\INSERT INTO terminal_sessions (
            \\    id, terminal_id, workspace_id, cwd, status, cols, rows,
            \\    event_log_path, last_seq, started_at
            \\) VALUES (
            \\    'legacy-1', 'term-1', 'ws-1', '/tmp', 'exited', 80, 24,
            \\    '/tmp/legacy.tauev', 3, datetime('now')
            \\);
            ,
            .{},
            .{},
        );
    }

    var database = try Database.open(std.testing.allocator, path);
    defer database.deinit();

    const legacy_columns = try database.handle.one(
        u64,
        "SELECT COUNT(*) FROM pragma_table_info('terminal_sessions') WHERE name = 'workspace_id';",
        .{},
        .{},
    );
    try std.testing.expectEqual(@as(u64, 0), legacy_columns);

    var row = (try database.findTerminalSessionById(std.testing.allocator, "legacy-1")).?;
    defer row.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("term-1", row.terminal_id);
    try std.testing.expectEqual(@as(u64, 3), row.last_seq);

    // New session metadata must persist against the rebuilt mux schema.
    try database.recordTerminalSession(.{
        .id = "session-2",
        .terminal_id = "term-2",
        .cwd = "/tmp",
        .status = "live",
        .cols = 120,
        .rows = 40,
        .event_log_path = "/tmp/new.tauev",
        .last_seq = 1,
    });
    var created = (try database.findTerminalSessionById(std.testing.allocator, "session-2")).?;
    defer created.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("term-2", created.terminal_id);
}

test "resumes terminal_sessions rebuild from retained pre_mux backup" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const path = try std.fmt.allocPrint(std.testing.allocator, ".zig-cache/tmp/{s}/resume.sqlite", .{tmp.sub_path});
    defer std.testing.allocator.free(path);

    {
        const path_z = try std.testing.allocator.dupeZ(u8, path);
        defer std.testing.allocator.free(path_z);
        var diags = sqlite.Diagnostics{};
        var handle = try sqlite.Db.init(.{
            .mode = .{ .File = path_z },
            .open_flags = .{ .write = true, .create = true },
            .threading_mode = .MultiThread,
            .diags = &diags,
        });
        defer handle.deinit();
        // Simulate crash after rename: only the pre_mux backup remains, plus a partial new table.
        try handle.execDynamic(
            \\CREATE TABLE terminal_sessions_pre_mux (
            \\    id TEXT PRIMARY KEY,
            \\    terminal_id TEXT NOT NULL,
            \\    workspace_id TEXT NOT NULL,
            \\    cwd TEXT,
            \\    argv_json TEXT,
            \\    status TEXT NOT NULL,
            \\    daemon_id TEXT,
            \\    pid INTEGER,
            \\    cols INTEGER NOT NULL,
            \\    rows INTEGER NOT NULL,
            \\    title TEXT,
            \\    event_log_path TEXT NOT NULL,
            \\    last_seq INTEGER NOT NULL DEFAULT 0,
            \\    snapshot_path TEXT,
            \\    snapshot_seq INTEGER NOT NULL DEFAULT 0,
            \\    snapshot_crc32 INTEGER,
            \\    snapshot_size INTEGER,
            \\    scrollback_excerpt TEXT,
            \\    started_at TEXT NOT NULL,
            \\    last_activity_at TEXT,
            \\    ended_at TEXT,
            \\    exit_code INTEGER,
            \\    signal INTEGER,
            \\    created_at TEXT NOT NULL DEFAULT (datetime('now')),
            \\    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            \\);
            ,
            .{},
            .{},
        );
        try handle.execDynamic(
            \\INSERT INTO terminal_sessions_pre_mux (
            \\    id, terminal_id, workspace_id, cwd, status, cols, rows,
            \\    event_log_path, last_seq, started_at
            \\) VALUES (
            \\    'resume-1', 'term-resume', 'ws-1', '/tmp', 'exited', 80, 24,
            \\    '/tmp/resume.tauev', 9, datetime('now')
            \\);
            ,
            .{},
            .{},
        );
        try handle.execDynamic(
            \\CREATE TABLE terminal_sessions (
            \\    id TEXT PRIMARY KEY,
            \\    terminal_id TEXT NOT NULL
            \\);
            ,
            .{},
            .{},
        );
    }

    var database = try Database.open(std.testing.allocator, path);
    defer database.deinit();

    const pre_mux_left = try database.handle.one(
        u64,
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'terminal_sessions_pre_mux';",
        .{},
        .{},
    );
    try std.testing.expectEqual(@as(u64, 0), pre_mux_left);

    var row = (try database.findTerminalSessionById(std.testing.allocator, "resume-1")).?;
    defer row.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("term-resume", row.terminal_id);
    try std.testing.expectEqual(@as(u64, 9), row.last_seq);
}
