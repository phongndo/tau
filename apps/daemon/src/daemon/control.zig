const std = @import("std");
const cleanup = @import("../cleanup.zig");
const db = @import("../db.zig");
const event_log = @import("../event_log.zig");
const limits = @import("../limits.zig");
const mux_graph = @import("../mux_graph.zig");
const pty = @import("../pty.zig");
const rpc = @import("../rpc.zig");
const session = @import("../session.zig");

const protocol = @import("protocol.zig");
const util = @import("util.zig");
const types = @import("types.zig");

const SessionResponseMetadata = protocol.SessionResponseMetadata;
const RestoreResult = types.RestoreResult;

const generateSessionId = util.generateSessionId;
const argvJsonAlloc = util.argvJsonAlloc;
const isLiveAttachable = util.isLiveAttachable;
const missingField = protocol.missingField;
const notFound = protocol.notFound;
const sessionResponse = protocol.sessionResponse;

pub fn handleCreateLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    var generated_session_id: ?[]u8 = null;
    const session_id = request.requestSessionId() orelse generated: {
        generated_session_id = try generateSessionId(allocator);
        break :generated generated_session_id.?;
    };
    defer if (generated_session_id) |value| allocator.free(value);

    const terminal_id = request.requestTerminalId() orelse return missingField(allocator, request, "terminal_id");
    const cols = request.cols orelse return missingField(allocator, request, "cols");
    const rows = request.rows orelse return missingField(allocator, request, "rows");

    const created = if (self.sessions.find(session_id)) |existing| blk: {
        existing.transitionTo(.live);
        try existing.updateCreateMetadata(self.allocator, terminal_id, request.cwd, cols, rows);
        break :blk existing;
    } else try self.sessions.create(.{
        .session_id = session_id,
        .terminal_id = terminal_id,
        .cols = cols,
        .rows = rows,
        .cwd = request.cwd,
        .argv = request.argv orelse &.{},
    });

    try self.ensureSessionPersistence(created);
    try self.ensureSessionProcess(created, request.argv orelse &.{});
    errdefer if (!created.reader_started) terminateUnstartedPtyChildLocked(self, created);
    if (created.event_log_path) |path| {
        _ = event_log.appendResize(self.allocator, path, &created.last_seq, cols, rows) catch |err| {
            std.log.warn("failed to append create resize frame for {s}: {t}", .{ created.id, err });
        };
    }
    const argv_json = try argvJsonAlloc(self.allocator, request.argv orelse &.{});
    defer if (argv_json) |json| self.allocator.free(json);
    self.recordTerminalSessionLocked(created, argv_json);
    try self.startSessionReaderLocked(created);
    return try sessionResponse(allocator, request, created, .{});
}

pub fn handleAttachLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const session_id = request.requestSessionId() orelse return missingField(allocator, request, "session_id");
    var restored_result: ?RestoreResult = null;
    defer if (restored_result) |*result| result.deinit(self.allocator);

    const attached = self.sessions.attach(session_id) orelse blk: {
        restored_result = (try self.restoreSessionFromDatabaseLocked(session_id, request)) orelse return notFound(allocator, request);
        break :blk restored_result.?.item;
    };
    if (!isLiveAttachable(attached)) {
        return rpc.responseJsonAlloc(allocator, .{
            .id = request.requestId(),
            .ok = false,
            .error_code = "session_not_found",
            .error_message = "session is not live",
        });
    }
    const terminal_id = request.requestTerminalId() orelse attached.terminal_id;
    const cols = request.cols orelse attached.cols;
    const rows = request.rows orelse attached.rows;
    // Preserve any legacy optional workspace/worktree metadata already on the session.
    try attached.updateCreateMetadata(
        self.allocator,
        terminal_id,
        request.cwd orelse attached.cwd,
        cols,
        rows,
    );
    self.recordTerminalSessionLocked(attached, null);
    const metadata: SessionResponseMetadata = if (restored_result) |result| .{
        .attach_kind = result.attach_kind,
    } else .{ .attach_kind = .live };
    return sessionResponse(allocator, request, attached, metadata);
}

pub fn handleResizeLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const session_id = request.requestSessionId() orelse return missingField(allocator, request, "session_id");
    const cols = request.cols orelse return missingField(allocator, request, "cols");
    const rows = request.rows orelse return missingField(allocator, request, "rows");
    const item = self.sessions.find(session_id) orelse return notFound(allocator, request);
    if (item.pty_child) |*child| try self.pty_driver.resize(child, cols, rows);
    if (!self.sessions.resize(session_id, cols, rows)) return notFound(allocator, request);
    if (item.event_log_path) |path| {
        _ = event_log.appendResize(self.allocator, path, &item.last_seq, cols, rows) catch |err| {
            std.log.warn("failed to append resize frame for {s}: {t}", .{ item.id, err });
        };
    }
    self.recordTerminalSessionLocked(item, null);

    return sessionResponse(allocator, request, self.sessions.find(session_id).?, .{});
}

pub fn handleDetachLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const session_id = request.requestSessionId() orelse return missingField(allocator, request, "session_id");
    if (!self.sessions.detach(session_id)) return notFound(allocator, request);
    const item = self.sessions.find(session_id).?;
    if (item.subscribers.items.len == 0) self.checkpointCurrentScreenLocked(item);
    self.recordTerminalSessionLocked(item, null);

    return sessionResponse(allocator, request, item, .{});
}

pub fn handleKillLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const session_id = request.requestSessionId() orelse return missingField(allocator, request, "session_id");
    const item = self.sessions.find(session_id) orelse return notFound(allocator, request);
    if (item.pty_child) |*child| {
        self.pty_driver.terminate(child) catch |err| {
            std.log.warn("failed to terminate PTY for {s}: {t}", .{ item.id, err });
        };
        pty.reapInBackground(child) catch |err| {
            std.log.warn("failed to start PTY reaper for killed session {s}: {t}", .{ item.id, err });
            reapPtyChildUnlocked(self, item, child, "killed");
        };
        item.pty_child = null;
    }
    if (item.event_log_path) |path| {
        _ = event_log.appendExit(self.allocator, path, &item.last_seq, 0, 15) catch |err| {
            std.log.warn("failed to append kill exit frame for {s}: {t}", .{ item.id, err });
        };
    }
    item.reader_started = false;
    try self.broadcastExitFrameLocked(item, item.last_seq, 0, 15);
    if (!self.sessions.kill(session_id)) return notFound(allocator, request);
    self.recordTerminalEndedLocked(item, 0, 15);
    var search_snapshot = self.searchExcerptSnapshotLocked(item) catch |err| blk: {
        std.log.warn("failed to prepare search excerpt indexing for {s}: {t}", .{ item.id, err });
        break :blk null;
    };
    defer if (search_snapshot) |*value| value.deinit(self.allocator);
    const response = try sessionResponse(allocator, request, self.sessions.find(session_id).?, .{});

    self.unlock();
    if (search_snapshot) |*value| self.indexSearchExcerptFromSnapshot(value);
    self.lock();

    return response;
}

fn terminateUnstartedPtyChildLocked(self: anytype, item: *session.TerminalSession) void {
    if (item.pty_child) |*child| {
        self.pty_driver.terminate(child) catch |err| {
            std.log.warn("failed to terminate unstarted PTY for {s}: {t}", .{ item.id, err });
        };
        pty.reapInBackground(child) catch |err| {
            std.log.warn("failed to start PTY reaper for unstarted session {s}: {t}", .{ item.id, err });
            reapPtyChildUnlocked(self, item, child, "unstarted");
        };
        item.pty_child = null;
    }
    item.reader_started = false;
}

fn reapPtyChildUnlocked(self: anytype, item: *session.TerminalSession, child: *pty.Child, reason: []const u8) void {
    var detached_child = child.*;
    child.pid = 0;
    child.close();
    item.pty_child = null;

    self.unlock();
    defer self.lock();

    _ = self.pty_driver.wait(&detached_child) catch |wait_err| {
        std.log.warn("failed to synchronously reap {s} PTY for {s}: {t}", .{ reason, item.id, wait_err });
    };
    detached_child.close();
}

pub fn handleClearHistoryLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    var result: cleanup.MaintenanceResult = .{};

    if (request.requestSessionIds()) |session_ids| {
        for (session_ids) |session_id| {
            if (self.sessions.find(session_id)) |item| {
                try self.resetSessionHistoryLocked(item);
                result.removed_sessions += 1;
                continue;
            }

            self.unlock();
            const removed = cleanup.deleteSessionDir(self.allocator, self.config.sessions_dir, session_id) catch |err| {
                self.lock();
                std.log.warn("failed to clear persisted session {s}: {t}", .{ session_id, err });
                continue;
            };
            self.lock();
            result.add(removed);
            if (removed.removed_sessions > 0) {
                if (self.database) |*database| database.deleteTerminalSessionMetadata(session_id) catch |err| {
                    std.log.warn("failed to delete cleared session metadata {s}: {t}", .{ session_id, err });
                };
            }
        }
    } else {
        var active_ids: std.ArrayList([]const u8) = .empty;
        defer {
            for (active_ids.items) |active_id| self.allocator.free(active_id);
            active_ids.deinit(self.allocator);
        }

        for (self.sessions.sessions.items) |*item| {
            const active_id = try self.allocator.dupe(u8, item.id);
            active_ids.append(self.allocator, active_id) catch |err| {
                self.allocator.free(active_id);
                return err;
            };
        }

        for (active_ids.items) |active_id| {
            if (self.sessions.find(active_id)) |item| {
                try self.resetSessionHistoryLocked(item);
            }
            result.removed_sessions += 1;
        }

        self.unlock();
        var locked_after_delete = false;
        const removed = cleanup.deleteInactiveSessionDirs(
            self.allocator,
            self.config.sessions_dir,
            active_ids.items,
        ) catch |err| blk: {
            self.lock();
            locked_after_delete = true;
            std.log.warn("failed to clear inactive session history: {t}", .{err});
            break :blk cleanup.MaintenanceResult{};
        };
        if (!locked_after_delete) self.lock();
        result.add(removed);
        self.pruneMissingEventLogMetadataLocked();
    }

    return rpc.responseJsonAlloc(allocator, .{
        .id = request.requestId(),
        .ok = true,
        .removed_sessions = result.removed_sessions,
        .removed_bytes = result.removed_bytes,
    });
}

pub fn handleCleanupLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    var active_ids: std.ArrayList([]const u8) = .empty;
    defer {
        for (active_ids.items) |active_id| self.allocator.free(active_id);
        active_ids.deinit(self.allocator);
    }

    for (self.sessions.sessions.items) |*item| {
        const active_id = try self.allocator.dupe(u8, item.id);
        active_ids.append(self.allocator, active_id) catch |err| {
            self.allocator.free(active_id);
            return err;
        };
    }
    if (request.requestActiveSessionIds()) |request_active_ids| {
        for (request_active_ids) |active_id| {
            if (cleanup.isActiveSession(active_id, active_ids.items)) continue;
            const owned_active_id = try self.allocator.dupe(u8, active_id);
            active_ids.append(self.allocator, owned_active_id) catch |err| {
                self.allocator.free(owned_active_id);
                return err;
            };
        }
    }

    const retain_days = request.requestRetainDays() orelse 30;
    const max_session_bytes = request.requestMaxSessionBytes() orelse 2 * 1024 * 1024 * 1024;

    self.unlock();
    const result = cleanup.runSessionRetention(self.allocator, self.config.sessions_dir, .{
        .retain_days = retain_days,
        .max_session_bytes = max_session_bytes,
        .active_session_ids = active_ids.items,
    }) catch |err| {
        self.lock();
        std.log.warn("session cleanup failed: {t}", .{err});
        return rpc.responseJsonAlloc(allocator, .{
            .id = request.requestId(),
            .ok = false,
            .error_message = @errorName(err),
        });
    };
    self.lock();
    self.pruneMissingEventLogMetadataLocked();

    return rpc.responseJsonAlloc(allocator, .{
        .id = request.requestId(),
        .ok = true,
        .removed_sessions = result.removed_sessions,
        .removed_bytes = result.removed_bytes,
    });
}

pub fn handleConfigurePersistenceLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    if (request.requestPersistenceEnabled()) |enabled| self.persistence.enabled = enabled;
    if (request.requestPersistInput()) |persist_input| self.persistence.persist_input = persist_input;
    self.applyPersistencePolicyToSessionsLocked();

    return rpc.responseJsonAlloc(allocator, .{
        .id = request.requestId(),
        .ok = true,
        .persistence_enabled = self.persistence.enabled,
        .persist_input = self.persistence.persist_input,
    });
}

fn graphResponse(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson, replay: mux_graph.Replay) ![]u8 {
    const events_json = try self.mux_graph.eventsJsonAlloc(request.requestAfterEventSeq() orelse 0);
    defer self.allocator.free(events_json);
    return rpc.responseJsonAlloc(allocator, .{
        .id = request.requestId(),
        .ok = true,
        .graph_snapshot_json = replay.snapshot_json,
        .graph_events_json = events_json,
        .graph_rev = replay.graph_rev,
        .event_seq = replay.event_seq,
        .oldest_event_seq = replay.oldest_event_seq,
        .graph_changed = replay.changed,
        .requires_resync = replay.requires_resync,
    });
}

pub fn handleGraphGetLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    return graphResponse(self, allocator, request, self.mux_graph.replay(request.requestAfterEventSeq()));
}

pub fn handleGraphReplaceLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const snapshot_json = request.requestGraphSnapshotJson() orelse return missingField(allocator, request, "graph_snapshot_json");
    const old_snapshot = try self.allocator.dupe(u8, self.mux_graph.snapshot());
    defer self.allocator.free(old_snapshot);
    const old_rev = self.mux_graph.graph_rev;
    const old_seq = self.mux_graph.event_seq;
    // Full event history copy: shrink-to-old-len cannot restore an entry evicted at the 256 cap.
    const old_events = try self.allocator.dupe(mux_graph.Event, self.mux_graph.events.items);
    defer self.allocator.free(old_events);

    self.mux_graph.replaceSnapshot(snapshot_json, request.requestExpectedRev()) catch |err| {
        return rpc.responseJsonAlloc(allocator, .{
            .id = request.requestId(),
            .ok = false,
            .graph_snapshot_json = self.mux_graph.snapshot(),
            .graph_rev = self.mux_graph.graph_rev,
            .event_seq = self.mux_graph.event_seq,
            .error_code = if (err == mux_graph.Error.Conflict) "revision_conflict" else "invalid_graph",
            .error_message = @errorName(err),
        });
    };
    self.mux_graph.persist(self.config.graph_path, self.config.graph_previous_path) catch |err| {
        if (self.mux_graph.snapshot_json) |current| self.allocator.free(current);
        self.mux_graph.snapshot_json = try self.allocator.dupe(u8, old_snapshot);
        self.mux_graph.graph_rev = old_rev;
        self.mux_graph.event_seq = old_seq;
        self.mux_graph.events.clearRetainingCapacity();
        self.mux_graph.events.appendSlice(self.allocator, old_events) catch {
            // Best-effort history restore already failed; leave events empty so clients resync.
            self.mux_graph.events.clearRetainingCapacity();
        };
        return rpc.responseJsonAlloc(allocator, .{
            .id = request.requestId(),
            .ok = false,
            .error_code = "persistence_failed",
            .error_message = @errorName(err),
        });
    };
    self.graph_condition.broadcast();
    return graphResponse(self, allocator, request, self.mux_graph.replay(old_seq));
}

pub fn handleGraphWaitLocked(self: anytype, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    const after = request.requestAfterEventSeq() orelse 0;
    if (after == self.mux_graph.event_seq) {
        const timeout_ms = @min(request.requestWaitTimeoutMs() orelse 25_000, limits.graph_wait_timeout_ms_max);
        self.graph_condition.timedWait(&self.mutex, @as(u64, timeout_ms) * std.time.ns_per_ms) catch |err| switch (err) {
            error.Timeout => {},
        };
    }
    return graphResponse(self, allocator, request, self.mux_graph.replay(after));
}
