const std = @import("std");
const db = @import("db.zig");
const event_log = @import("event_log.zig");
const limits = @import("limits.zig");
const pty = @import("pty.zig");
const rpc = @import("rpc.zig");
const session = @import("session.zig");
const snapshot = @import("snapshot.zig");
const vt = @import("vt.zig");
const mux_graph_mod = @import("mux_graph.zig");

const daemon_config = @import("daemon/config.zig");
const fd_io = @import("daemon/fd_io.zig");
const protocol = @import("daemon/protocol.zig");
const util = @import("daemon/util.zig");
const types = @import("daemon/types.zig");
const server = @import("daemon/server.zig");
const control = @import("daemon/control.zig");
const persistence = @import("daemon/persistence.zig");
const process = @import("daemon/process.zig");
const stream_mod = @import("daemon/stream.zig");
const screen = @import("daemon/screen.zig");

const fileExists = util.fileExists;

const PersistencePolicy = types.PersistencePolicy;
const RestoreResult = types.RestoreResult;
const SearchExcerptSnapshot = types.SearchExcerptSnapshot;
const CurrentScreenCheckpoint = types.CurrentScreenCheckpoint;

pub const Config = daemon_config.Config;

test {
    _ = daemon_config;
    _ = fd_io;
    _ = protocol;
    _ = util;
    _ = types;
    _ = server;
    _ = control;
    _ = persistence;
    _ = process;
    _ = stream_mod;
    _ = screen;
    _ = mux_graph_mod;
}

pub const Daemon = struct {
    allocator: std.mem.Allocator,
    config: Config,
    sessions: session.Manager,
    pty_driver: pty.Driver,
    database: ?db.Database,
    persistence: PersistencePolicy,
    mux_graph: mux_graph_mod.Graph,
    mutex: std.Thread.Mutex = .{},
    graph_condition: std.Thread.Condition = .{},
    active_control_connections: std.atomic.Value(usize) = std.atomic.Value(usize).init(0),
    active_session_readers: std.atomic.Value(usize) = std.atomic.Value(usize).init(0),
    stream_input_frames_total: std.atomic.Value(u64) = std.atomic.Value(u64).init(0),
    stream_input_bytes_total: std.atomic.Value(u64) = std.atomic.Value(u64).init(0),
    stream_output_frames_total: std.atomic.Value(u64) = std.atomic.Value(u64).init(0),
    stream_output_bytes_total: std.atomic.Value(u64) = std.atomic.Value(u64).init(0),
    last_pty_read_ns: std.atomic.Value(u64) = std.atomic.Value(u64).init(0),
    stream_slow_subscriber_drops_total: std.atomic.Value(u64) = std.atomic.Value(u64).init(0),
    stream_pending_output_dropped_frames_total: std.atomic.Value(u64) = std.atomic.Value(u64).init(0),
    stream_pending_output_dropped_bytes_total: std.atomic.Value(u64) = std.atomic.Value(u64).init(0),
    stream_pending_output_truncated_bytes_total: std.atomic.Value(u64) = std.atomic.Value(u64).init(0),
    control_request_count: std.atomic.Value(u64) = std.atomic.Value(u64).init(0),
    control_request_failure_count: std.atomic.Value(u64) = std.atomic.Value(u64).init(0),
    last_control_request_type: rpc.RequestType = .unknown,
    last_control_trace_id: [160]u8 = [_]u8{0} ** 160,
    last_control_trace_id_len: usize = 0,
    last_control_duration_ms: u64 = 0,
    last_control_ok: bool = false,
    last_control_recorded_at_ms: u64 = 0,

    const ProcessContext = process.Context(*Daemon);
    const StreamContext = stream_mod.Context(*Daemon);

    pub fn init(allocator: std.mem.Allocator, config: Config) Daemon {
        return .{
            .allocator = allocator,
            .config = config,
            .sessions = session.Manager.init(allocator),
            .pty_driver = pty.Driver.init(allocator),
            .database = null,
            .persistence = .{},
            .mux_graph = mux_graph_mod.Graph.init(allocator),
        };
    }

    pub fn deinit(self: *Daemon) void {
        self.stopSessionProcessesForDeinit();
        self.waitForSessionReadersForDeinit();
        if (self.database) |*database| database.deinit();
        self.mux_graph.deinit();
        self.sessions.deinit();
    }

    fn stopSessionProcessesForDeinit(self: *Daemon) void {
        self.lock();
        defer self.unlock();

        for (self.sessions.sessions.items) |*item| {
            if (item.pty_child) |*child| {
                if (child.pid > 0) {
                    self.pty_driver.terminate(child) catch |err| {
                        std.log.warn("failed to terminate PTY during daemon teardown for {s}: {t}", .{ item.id, err });
                        child.close();
                    };
                    _ = self.pty_driver.wait(child) catch |err| {
                        std.log.warn("failed to reap PTY during daemon teardown for {s}: {t}", .{ item.id, err });
                    };
                } else {
                    child.close();
                }
                item.pty_child = null;
            }
            item.reader_started = false;
            item.assertInvariants();
        }
    }

    fn waitForSessionReadersForDeinit(self: *Daemon) void {
        var spins: usize = 0;
        while (self.active_session_readers.load(.acquire) != 0) : (spins += 1) {
            if (spins != 0 and spins % 400 == 0) {
                std.log.warn("daemon teardown still waiting for {d} session readers", .{self.active_session_readers.load(.acquire)});
            }
            std.Thread.sleep(10 * std.time.ns_per_ms);
        }
    }

    pub fn prepareStorage(self: *Daemon) !void {
        return server.prepareStorage(self);
    }

    pub fn printConfig(self: *Daemon) void {
        return server.printConfig(self);
    }

    pub fn runForever(self: *Daemon) !void {
        return server.runForever(self);
    }

    pub fn handleControlPayload(self: *Daemon, allocator: std.mem.Allocator, payload: []const u8) ![]u8 {
        return server.handleControlPayload(self, allocator, payload);
    }

    pub fn handleControlRequest(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return server.handleControlRequest(self, allocator, request);
    }

    pub fn handleStream(self: *Daemon, stream: std.net.Stream) !void {
        return server.handleStream(self, stream);
    }

    pub fn recordControlDiagnosticsLocked(self: *Daemon, request_type: rpc.RequestType, trace_id: ?[]const u8, duration_ms: u64, ok: bool) void {
        _ = self.control_request_count.fetchAdd(1, .monotonic);
        if (!ok) _ = self.control_request_failure_count.fetchAdd(1, .monotonic);
        self.last_control_request_type = request_type;
        if (trace_id) |trace| {
            const trace_len = @min(trace.len, self.last_control_trace_id.len);
            @memcpy(self.last_control_trace_id[0..trace_len], trace[0..trace_len]);
            self.last_control_trace_id_len = trace_len;
        } else {
            self.last_control_trace_id_len = 0;
        }
        self.last_control_duration_ms = duration_ms;
        self.last_control_ok = ok;
        const recorded_at = std.time.milliTimestamp();
        self.last_control_recorded_at_ms = if (recorded_at > 0) @intCast(recorded_at) else 0;
    }

    pub fn controlDiagnosticsLocked(self: *Daemon) rpc.ControlDiagnostics {
        return .{
            .request_count = self.control_request_count.load(.monotonic),
            .failure_count = self.control_request_failure_count.load(.monotonic),
            .last_request_type = if (self.last_control_recorded_at_ms == 0) null else @tagName(self.last_control_request_type),
            .last_trace_id = if (self.last_control_trace_id_len == 0) null else self.last_control_trace_id[0..self.last_control_trace_id_len],
            .last_duration_ms = if (self.last_control_recorded_at_ms == 0) null else self.last_control_duration_ms,
            .last_ok = if (self.last_control_recorded_at_ms == 0) null else self.last_control_ok,
            .last_recorded_at_ms = if (self.last_control_recorded_at_ms == 0) null else self.last_control_recorded_at_ms,
        };
    }

    pub fn handleCreateLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return control.handleCreateLocked(self, allocator, request);
    }

    pub fn handleAttachLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return control.handleAttachLocked(self, allocator, request);
    }

    pub fn handleResizeLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return control.handleResizeLocked(self, allocator, request);
    }

    pub fn handleDetachLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return control.handleDetachLocked(self, allocator, request);
    }

    pub fn handleKillLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return control.handleKillLocked(self, allocator, request);
    }

    pub fn handleClearHistoryLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return control.handleClearHistoryLocked(self, allocator, request);
    }

    pub fn handleCleanupLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return control.handleCleanupLocked(self, allocator, request);
    }

    pub fn handleConfigurePersistenceLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return control.handleConfigurePersistenceLocked(self, allocator, request);
    }

    pub fn handleGraphGetLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return control.handleGraphGetLocked(self, allocator, request);
    }

    pub fn handleGraphReplaceLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return control.handleGraphReplaceLocked(self, allocator, request);
    }

    pub fn handleGraphWaitLocked(self: *Daemon, allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
        return control.handleGraphWaitLocked(self, allocator, request);
    }

    pub fn restoreSessionFromDatabaseLocked(
        self: *Daemon,
        session_id: []const u8,
        request: rpc.ControlRequestJson,
    ) !?RestoreResult {
        return persistence.restoreSessionFromDatabaseLocked(self, session_id, request);
    }

    pub fn restoreSessionWithArgvJsonLocked(
        self: *Daemon,
        session_id: []const u8,
        terminal_id: []const u8,
        cwd: ?[]const u8,
        cols: u16,
        rows: u16,
        argv_json: []const u8,
    ) !?*session.TerminalSession {
        return persistence.restoreSessionWithArgvJsonLocked(self, session_id, terminal_id, cwd, cols, rows, argv_json);
    }

    pub fn ensureSessionPersistence(self: *Daemon, item: *session.TerminalSession) !void {
        return persistence.ensureSessionPersistence(self, item);
    }

    pub fn applyPersistencePolicyToSessionsLocked(self: *Daemon) void {
        return persistence.applyPersistencePolicyToSessionsLocked(self);
    }

    pub fn reloadPersistencePolicyFromSettingsLocked(self: *Daemon) void {
        return persistence.reloadPersistencePolicyFromSettingsLocked(self);
    }

    pub fn resetSessionHistoryLocked(self: *Daemon, item: *session.TerminalSession) !void {
        return persistence.resetSessionHistoryLocked(self, item);
    }

    pub fn ensureSessionProcess(self: *Daemon, item: *session.TerminalSession, argv: []const []const u8) !void {
        return ProcessContext.init(self).ensureSessionProcess(item, argv);
    }

    pub fn startSessionReaderLocked(self: *Daemon, item: *session.TerminalSession) !void {
        return ProcessContext.init(self).startSessionReaderLocked(item);
    }

    pub fn streamAttachedSession(self: *Daemon, socket_fd: std.c.fd_t, session_id: []const u8, initial_tail: []const u8) !void {
        return StreamContext.init(self).streamAttachedSession(socket_fd, session_id, initial_tail);
    }

    pub fn applyPendingClientFrames(self: *Daemon, session_id: []const u8, pending: *std.ArrayList(u8)) !void {
        return StreamContext.init(self).applyPendingClientFrames(session_id, pending);
    }

    pub fn addSubscriber(self: *Daemon, session_id: []const u8, socket_fd: std.c.fd_t) !bool {
        return StreamContext.init(self).addSubscriber(session_id, socket_fd);
    }

    pub fn removeSubscriber(self: *Daemon, session_id: []const u8, socket_fd: std.c.fd_t) bool {
        return StreamContext.init(self).removeSubscriber(session_id, socket_fd);
    }

    pub fn sessionCanContinueStreaming(self: *Daemon, session_id: []const u8, socket_fd: std.c.fd_t) bool {
        return StreamContext.init(self).sessionCanContinueStreaming(session_id, socket_fd);
    }

    pub fn runSessionReader(self: *Daemon, session_id: []const u8) !void {
        return ProcessContext.init(self).runSessionReader(session_id);
    }

    pub fn liveChildFd(self: *Daemon, session_id: []const u8) ?std.c.fd_t {
        return ProcessContext.init(self).liveChildFd(session_id);
    }

    pub fn readPtyAndBroadcast(self: *Daemon, session_id: []const u8) !void {
        return ProcessContext.init(self).readPtyAndBroadcast(session_id);
    }

    pub fn applyClientFrame(self: *Daemon, frame: rpc.StreamFrame) !void {
        return StreamContext.init(self).applyClientFrame(frame);
    }

    pub fn reapExitedChild(self: *Daemon, session_id: []const u8) !bool {
        return ProcessContext.init(self).reapExitedChild(session_id);
    }

    pub fn markExitedAndBroadcast(self: *Daemon, session_id: []const u8, exit_code: i32, signal_value: i32) !bool {
        return ProcessContext.init(self).markExitedAndBroadcast(session_id, exit_code, signal_value);
    }

    pub fn recordTerminalSessionLocked(self: *Daemon, item: *const session.TerminalSession, argv_json: ?[]const u8) void {
        return persistence.recordTerminalSessionLocked(self, item, argv_json);
    }

    pub fn recordTerminalEndedLocked(self: *Daemon, item: *const session.TerminalSession, exit_code: i32, signal_value: i32) void {
        return persistence.recordTerminalEndedLocked(self, item, exit_code, signal_value);
    }

    pub fn searchExcerptSnapshotLocked(self: *Daemon, item: *const session.TerminalSession) !?SearchExcerptSnapshot {
        return persistence.searchExcerptSnapshotLocked(self, item);
    }

    pub fn indexSearchExcerptFromSnapshot(self: *Daemon, snapshot_input: *const SearchExcerptSnapshot) void {
        persistence.indexSearchExcerptFromSnapshot(self, snapshot_input);
    }

    pub fn pruneMissingEventLogMetadataLocked(self: *Daemon) void {
        return persistence.pruneMissingEventLogMetadataLocked(self);
    }

    pub fn broadcastExitFrameLocked(self: *Daemon, item: *session.TerminalSession, seq: u64, exit_code: i32, signal_value: i32) !void {
        return StreamContext.init(self).broadcastExitFrameLocked(item, seq, exit_code, signal_value);
    }

    pub fn checkpointCurrentScreenLocked(self: *Daemon, item: *session.TerminalSession) void {
        return screen.checkpointCurrentScreenLocked(self, item);
    }

    pub fn currentScreenCheckpointLocked(self: *Daemon, item: *const session.TerminalSession) !?CurrentScreenCheckpoint {
        return screen.currentScreenCheckpointLocked(self, item);
    }

    pub fn clearSnapshotFileLocked(self: *Daemon, item: *session.TerminalSession) void {
        return screen.clearSnapshotFileLocked(self, item);
    }

    pub fn sendCurrentScreenSnapshotToSubscriberLocked(self: *Daemon, item: *session.TerminalSession, socket_fd: std.c.fd_t) !void {
        return screen.sendCurrentScreenSnapshotToSubscriberLocked(self, item, socket_fd);
    }

    pub fn broadcastStreamFrameLocked(
        self: *Daemon,
        item: *session.TerminalSession,
        kind: rpc.StreamKind,
        seq: u64,
        payload: []const u8,
    ) !void {
        return StreamContext.init(self).broadcastStreamFrameLocked(item, kind, seq, payload);
    }

    pub fn flushPendingOutputToSubscriberLocked(self: *Daemon, item: *session.TerminalSession, socket_fd: std.c.fd_t) !void {
        return StreamContext.init(self).flushPendingOutputToSubscriberLocked(item, socket_fd);
    }

    /// Guarded daemon mutex ownership. Most daemon methods still expose the
    /// legacy `lock`/`unlock` pair because the control path deliberately drops
    /// the lock around filesystem, SQLite, and filesystem work. New code should
    /// prefer this guard so lock ownership is local and mechanically paired.
    pub const LockGuard = struct {
        daemon: *Daemon,
        held: bool = true,

        pub fn release(self: *LockGuard) void {
            std.debug.assert(self.held);
            self.daemon.unlock();
            self.held = false;
        }

        pub fn reacquire(self: *LockGuard) void {
            std.debug.assert(!self.held);
            self.daemon.lock();
            self.held = true;
        }

        pub const UnlockedPhase = struct {
            guard: *LockGuard,

            pub fn deinit(self: *UnlockedPhase) void {
                self.guard.reacquire();
            }
        };

        pub fn unlocked(self: *LockGuard) UnlockedPhase {
            self.release();
            return .{ .guard = self };
        }

        pub fn deinit(self: *LockGuard) void {
            if (self.held) self.release();
        }
    };

    pub fn acquireLock(self: *Daemon) LockGuard {
        self.lock();
        return .{ .daemon = self };
    }

    pub fn lock(self: *Daemon) void {
        self.mutex.lock();
    }

    pub fn unlock(self: *Daemon) void {
        self.mutex.unlock();
    }

    pub fn reserveControlConnection(self: *Daemon) bool {
        while (true) {
            const active = self.active_control_connections.load(.monotonic);
            std.debug.assert(active <= limits.control_connections_max);
            if (active >= limits.control_connections_max) return false;
            if (self.active_control_connections.cmpxchgWeak(active, active + 1, .acquire, .monotonic) == null) {
                std.debug.assert(self.active_control_connections.load(.monotonic) <= limits.control_connections_max);
                return true;
            }
        }
    }

    pub fn releaseControlConnection(self: *Daemon) void {
        const previous = self.active_control_connections.fetchSub(1, .release);
        std.debug.assert(previous > 0);
        std.debug.assert(previous <= limits.control_connections_max);
    }

    pub fn recordStreamInputFrame(self: *Daemon, payload_len: usize) void {
        _ = self.stream_input_frames_total.fetchAdd(1, .monotonic);
        _ = self.stream_input_bytes_total.fetchAdd(@intCast(payload_len), .monotonic);
    }

    pub fn recordPtyRead(self: *Daemon) void {
        const timestamp = std.time.nanoTimestamp();
        self.last_pty_read_ns.store(if (timestamp > 0) @intCast(timestamp) else 0, .monotonic);
    }

    pub fn recordStreamOutputFrame(self: *Daemon, payload_len: usize) void {
        _ = self.stream_output_frames_total.fetchAdd(1, .monotonic);
        _ = self.stream_output_bytes_total.fetchAdd(@intCast(payload_len), .monotonic);
    }

    pub fn recordSlowSubscriberDrop(self: *Daemon) void {
        _ = self.stream_slow_subscriber_drops_total.fetchAdd(1, .monotonic);
    }

    pub fn recordPendingOutputBufferResult(self: *Daemon, result: session.PendingOutputBufferResult) void {
        if (result.dropped_frames > 0) {
            _ = self.stream_pending_output_dropped_frames_total.fetchAdd(result.dropped_frames, .monotonic);
        }
        if (result.dropped_bytes > 0) {
            _ = self.stream_pending_output_dropped_bytes_total.fetchAdd(result.dropped_bytes, .monotonic);
        }
        if (result.truncated_bytes > 0) {
            _ = self.stream_pending_output_truncated_bytes_total.fetchAdd(result.truncated_bytes, .monotonic);
        }
    }

    pub fn streamDiagnosticsLocked(self: *Daemon) rpc.StreamDiagnostics {
        var active_subscribers: usize = 0;
        var pending_output_sessions: usize = 0;
        var pending_output_frames: usize = 0;
        var pending_output_bytes: usize = 0;

        for (self.sessions.sessions.items) |*item| {
            active_subscribers += item.subscribers.items.len;
            if (item.pending_output.items.len == 0) continue;
            pending_output_sessions += 1;
            pending_output_frames += item.pending_output.items.len;
            pending_output_bytes += item.pending_output_bytes;
        }

        return .{
            .active_subscribers = active_subscribers,
            .pending_output_sessions = pending_output_sessions,
            .pending_output_frames = pending_output_frames,
            .pending_output_bytes = pending_output_bytes,
            .input_frames_total = self.stream_input_frames_total.load(.monotonic),
            .input_bytes_total = self.stream_input_bytes_total.load(.monotonic),
            .output_frames_total = self.stream_output_frames_total.load(.monotonic),
            .output_bytes_total = self.stream_output_bytes_total.load(.monotonic),
            .last_pty_read_ns = self.last_pty_read_ns.load(.monotonic),
            .slow_subscriber_drops_total = self.stream_slow_subscriber_drops_total.load(.monotonic),
            .pending_output_dropped_frames_total = self.stream_pending_output_dropped_frames_total.load(.monotonic),
            .pending_output_dropped_bytes_total = self.stream_pending_output_dropped_bytes_total.load(.monotonic),
            .pending_output_truncated_bytes_total = self.stream_pending_output_truncated_bytes_total.load(.monotonic),
        };
    }

    pub fn writePidFile(self: *Daemon) !void {
        return server.writePidFile(self);
    }
};

test "daemon control connection reservations enforce configured cap" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();

    var reserved: usize = 0;
    while (reserved < limits.control_connections_max) : (reserved += 1) {
        try std.testing.expect(daemon.reserveControlConnection());
    }

    try std.testing.expect(!daemon.reserveControlConnection());
    try std.testing.expectEqual(limits.control_connections_max, daemon.active_control_connections.load(.monotonic));

    while (reserved > 0) {
        reserved -= 1;
        daemon.releaseControlConnection();
    }

    try std.testing.expectEqual(@as(usize, 0), daemon.active_control_connections.load(.monotonic));
    try std.testing.expect(daemon.reserveControlConnection());
    daemon.releaseControlConnection();
}

test "daemon control RPC creates and updates sessions" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();

    const created = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"1","method":"create","session_id":"s1","terminal_id":"t1","cols":80,"rows":24}
    );
    defer std.testing.allocator.free(created);

    try std.testing.expect(daemon.sessions.find("s1") != null);
    try std.testing.expect(std.mem.indexOf(u8, created, "\"ok\":true") != null);

    const resized = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"2","method":"resize","session_id":"s1","cols":120,"rows":40}
    );
    defer std.testing.allocator.free(resized);

    try std.testing.expectEqual(@as(u16, 120), daemon.sessions.find("s1").?.cols);
    try std.testing.expect(std.mem.indexOf(u8, resized, "\"cols\":120") != null);

    const recreated = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"2b","method":"create","session_id":"s1","terminal_id":"t1b","cols":90,"rows":25,"cwd":"/tmp"}
    );
    defer std.testing.allocator.free(recreated);

    try std.testing.expectEqualStrings("t1b", daemon.sessions.find("s1").?.terminal_id);
    try std.testing.expectEqualStrings("/tmp", daemon.sessions.find("s1").?.cwd.?);
    try std.testing.expectEqual(@as(u16, 90), daemon.sessions.find("s1").?.cols);

    const protocol_created = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"3","type":"create","sessionId":"s2","terminalId":"t2","workspaceId":"workspace-1","cols":80,"rows":24}
    );
    defer std.testing.allocator.free(protocol_created);

    try std.testing.expect(daemon.sessions.find("s2") != null);
}

test "daemon control RPC creates session without workspace" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();

    const created = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"1","method":"create","session_id":"plain-shell","terminal_id":"t-shell","cols":80,"rows":24}
    );
    defer std.testing.allocator.free(created);

    try std.testing.expect(daemon.sessions.find("plain-shell") != null);
    try std.testing.expect(std.mem.indexOf(u8, created, "\"ok\":true") != null);
}

test "daemon control RPC ping reports protocol identity" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();

    const response = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"ping-1","type":"ping"}
    );
    defer std.testing.allocator.free(response);

    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"protocol_version\":2") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"daemon_version\":\"1.0.0\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"capabilities\":[\"sessions-v1\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"stream_diagnostics\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"pending_output_bytes\":0") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"control_diagnostics\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"request_count\":0") != null);
}

test "daemon control diagnostics report last traced request" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();

    const configured = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"cfg-1","traceId":"trace-cfg-1","type":"configurePersistence","enabled":true,"persistInput":false}
    );
    defer std.testing.allocator.free(configured);

    const response = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"ping-1","type":"ping"}
    );
    defer std.testing.allocator.free(response);

    try std.testing.expect(std.mem.indexOf(u8, response, "\"control_diagnostics\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"request_count\":1") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"failure_count\":0") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"last_request_type\":\"configure_persistence\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"last_trace_id\":\"trace-cfg-1\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"last_ok\":true") != null);
}

test "daemon stream diagnostics report output backlog and totals" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();

    const item = try daemon.sessions.create(.{
        .session_id = "diag-session",
        .terminal_id = "diag-terminal",
        .cols = 80,
        .rows = 24,
        .cwd = null,
        .argv = &.{},
    });

    try daemon.broadcastStreamFrameLocked(item, .output, 1, "hello");

    const response = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"ping-1","type":"ping"}
    );
    defer std.testing.allocator.free(response);

    try std.testing.expect(std.mem.indexOf(u8, response, "\"pending_output_sessions\":1") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"pending_output_frames\":1") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"pending_output_bytes\":5") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"output_frames_total\":1") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"output_bytes_total\":5") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"pending_output_dropped_frames_total\":0") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"pending_output_dropped_bytes_total\":0") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"pending_output_truncated_bytes_total\":0") != null);
}

test "daemon stream diagnostics report pending output truncation" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();

    const item = try daemon.sessions.create(.{
        .session_id = "truncated-session",
        .terminal_id = "truncated-terminal",
        .cols = 80,
        .rows = 24,
        .cwd = null,
        .argv = &.{},
    });

    const payload = try std.testing.allocator.alloc(u8, session.max_pending_output_bytes + 7);
    defer std.testing.allocator.free(payload);
    @memset(payload, 'x');

    try daemon.broadcastStreamFrameLocked(item, .output, 1, payload);

    const response = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"ping-1","type":"ping"}
    );
    defer std.testing.allocator.free(response);

    try std.testing.expect(std.mem.indexOf(u8, response, "\"pending_output_frames\":0") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"pending_output_bytes\":0") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"output_frames_total\":1") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"output_bytes_total\":1048583") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"pending_output_dropped_frames_total\":1") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"pending_output_truncated_bytes_total\":1048583") != null);
}

test "daemon control RPC reports missing sessions" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();

    const response = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"1","method":"attach","session_id":"missing"}
    );
    defer std.testing.allocator.free(response);

    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"error_code\":\"session_not_found\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "session not found") != null);

    const exited = try daemon.sessions.create(.{
        .session_id = "exited",
        .terminal_id = "terminal-exited",
        .cols = 80,
        .rows = 24,
        .cwd = null,
        .argv = &.{},
    });
    exited.status = .exited;

    const non_live_response = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"2","method":"attach","session_id":"exited"}
    );
    defer std.testing.allocator.free(non_live_response);

    try std.testing.expect(std.mem.indexOf(u8, non_live_response, "\"ok\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, non_live_response, "\"error_code\":\"session_not_found\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, non_live_response, "session is not live") != null);
}

test "daemon persistence privacy toggle avoids session log creation" {
    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const home = try std.fmt.allocPrint(std.testing.allocator, ".zig-cache/tmp/{s}/home", .{tmp.sub_path});
    defer std.testing.allocator.free(home);

    var config = try Config.fromHome(std.testing.allocator, home);
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();
    try daemon.prepareStorage();

    const configured = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"privacy","type":"configure-persistence","persistenceEnabled":false,"persistInput":true}
    );
    defer std.testing.allocator.free(configured);
    try std.testing.expect(std.mem.indexOf(u8, configured, "\"persistence_enabled\":false") != null);

    const created = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"1","method":"create","session_id":"private-session","terminal_id":"private-terminal","cols":80,"rows":24}
    );
    defer std.testing.allocator.free(created);

    const item = daemon.sessions.find("private-session").?;
    try std.testing.expect(item.event_log_path == null);
    try std.testing.expect(item.excerpt_path == null);
    try std.testing.expect((try event_log.openExistingSession(std.testing.allocator, daemon.config.sessions_dir, "private-session")) == null);
}

test "daemon drops failed stream subscribers without blocking pending output" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();

    const created = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"1","method":"create","session_id":"stream-session","terminal_id":"stream-terminal","cols":80,"rows":24}
    );
    defer std.testing.allocator.free(created);

    const item = daemon.sessions.find("stream-session").?;
    {
        daemon.lock();
        defer daemon.unlock();
        try item.subscribers.append(std.testing.allocator, -1);
        try daemon.broadcastStreamFrameLocked(item, .output, 1, "live output");
    }
    try std.testing.expectEqual(@as(usize, 0), item.subscribers.items.len);
    try std.testing.expectEqual(@as(usize, 1), item.pending_output.items.len);
    try std.testing.expectEqualStrings("live output", item.pending_output.items[0].payload);

    {
        daemon.lock();
        defer daemon.unlock();
        try daemon.broadcastStreamFrameLocked(item, .output, 2, "detached output");
    }
    try std.testing.expectEqual(@as(usize, 2), item.pending_output.items.len);
    try std.testing.expectEqualStrings("detached output", item.pending_output.items[1].payload);
}

test "daemon synthetic exit clears PTY ownership before exited transition" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();

    const created = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"1","method":"create","session_id":"exit-session","terminal_id":"exit-terminal","cols":80,"rows":24}
    );
    defer std.testing.allocator.free(created);

    const pipe_fds = try std.posix.pipe();
    defer std.posix.close(pipe_fds[1]);

    const item = daemon.sessions.find("exit-session").?;
    {
        daemon.lock();
        defer daemon.unlock();
        item.pty_child = .{
            .pid = 0,
            .master_fd = pipe_fds[0],
            .cols = 80,
            .rows = 24,
        };
        item.reader_started = true;
        item.assertInvariants();
    }

    try std.testing.expect(try daemon.markExitedAndBroadcast("exit-session", -1, 0));
    try std.testing.expectEqual(session.Status.exited, item.status);
    try std.testing.expect(item.pty_child == null);
    try std.testing.expect(!item.reader_started);
    item.assertInvariants();
}

test "daemon restores persisted mux sessions from saved argv" {
    if (!fileExists("/bin/sh")) return;

    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const home = try std.fmt.allocPrint(std.testing.allocator, ".zig-cache/tmp/{s}/home", .{tmp.sub_path});
    defer std.testing.allocator.free(home);

    var config = try Config.fromHome(std.testing.allocator, home);
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();
    try daemon.prepareStorage();

    if (daemon.database) |*database| {
        try database.recordTerminalSession(.{
            .id = "legacy-session",
            .terminal_id = "legacy-terminal",
            .argv_json = "[\"/bin/sh\",\"-c\",\"sleep 2\"]",
            .status = "exited",
            .cols = 80,
            .rows = 24,
            .event_log_path = "/tmp/tau-legacy-session/events.tauev",
            .last_seq = 0,
        });
    } else unreachable;

    const attached = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"attach","type":"attach","sessionId":"legacy-session","terminalId":"legacy-terminal","cols":80,"rows":24}
    );
    defer std.testing.allocator.free(attached);

    try std.testing.expect(std.mem.indexOf(u8, attached, "\"ok\":true") != null);
}

test "daemon detach checkpoints current-screen snapshot" {
    if (!vt.supports_current_screen_snapshots) return;

    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    const home = try std.fmt.allocPrint(std.testing.allocator, ".zig-cache/tmp/{s}/home", .{tmp.sub_path});
    defer std.testing.allocator.free(home);

    var config = try Config.fromHome(std.testing.allocator, home);
    defer config.deinit(std.testing.allocator);

    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();
    try daemon.prepareStorage();

    const created = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"1","method":"create","session_id":"snapshot-session","terminal_id":"snapshot-terminal","cols":24,"rows":4}
    );
    defer std.testing.allocator.free(created);

    const item = daemon.sessions.find("snapshot-session").?;
    try item.writeVt("snapshot text");

    const detached = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"2","method":"detach","session_id":"snapshot-session"}
    );
    defer std.testing.allocator.free(detached);

    try std.testing.expect(item.snapshot_crc32 != null);
    try std.testing.expect(item.snapshot_size > 0);

    var decoded = (try snapshot.readCurrentScreenPath(std.testing.allocator, item.snapshot_path.?)).?;
    defer decoded.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings(vt.backend_name, decoded.backend_name);

    var restored = try vt.Terminal.init(std.testing.allocator, 1, 1);
    defer restored.deinit(std.testing.allocator);
    try restored.deserializeCurrentScreen(std.testing.allocator, decoded.payload);

    const text = try restored.plainTextAlloc(std.testing.allocator);
    defer std.testing.allocator.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "snapshot text") != null);
}

test "daemon mux graph mutations are revision checked and durable" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const home = try std.fmt.allocPrint(std.testing.allocator, ".zig-cache/tmp/{s}/home", .{tmp.sub_path});
    defer std.testing.allocator.free(home);

    var config = try Config.fromHome(std.testing.allocator, home);
    defer config.deinit(std.testing.allocator);
    var daemon = Daemon.init(std.testing.allocator, config);
    defer daemon.deinit();
    try daemon.prepareStorage();

    const graph_snapshot =
        \\{"schemaVersion":1,"graphRev":0,"eventSeq":0,"tabs":[{"id":"tab-1","name":"Shell","order":0,"root":"pane-1","activePaneId":"pane-1"}],"panes":[{"id":"pane-1","tabId":"tab-1","terminalId":"term-1","type":"terminal","name":"Shell","sessionId":"session-1"}],"activeTabId":"tab-1","activePaneId":"pane-1"}
    ;
    const replace_request = try std.fmt.allocPrint(std.testing.allocator,
        \\{{"id":"graph-1","type":"graph-replace","expectedRev":0,"graphSnapshotJson":{f}}}
    , .{std.json.fmt(graph_snapshot, .{})});
    defer std.testing.allocator.free(replace_request);
    const replaced = try daemon.handleControlPayload(std.testing.allocator, replace_request);
    defer std.testing.allocator.free(replaced);
    try std.testing.expect(std.mem.indexOf(u8, replaced, "\"graph_rev\":1") != null);
    try std.testing.expect(fileExists(config.graph_path));

    const conflict = try daemon.handleControlPayload(std.testing.allocator, replace_request);
    defer std.testing.allocator.free(conflict);
    try std.testing.expect(std.mem.indexOf(u8, conflict, "\"error_code\":\"revision_conflict\"") != null);

    const current = try daemon.handleControlPayload(std.testing.allocator,
        \\{"id":"graph-2","type":"graph-get","afterEventSeq":0}
    );
    defer std.testing.allocator.free(current);
    try std.testing.expect(std.mem.indexOf(u8, current, "\"event_seq\":1") != null);
}
