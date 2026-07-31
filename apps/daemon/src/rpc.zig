const std = @import("std");
const limits = @import("limits.zig");

const assert = std.debug.assert;

pub const RequestType = enum {
    create,
    attach,
    resize,
    detach,
    kill,
    clear_history,
    cleanup,
    configure_persistence,
    graph_get,
    graph_replace,
    graph_wait,
    ping,
    unknown,

    pub fn fromText(text: []const u8) RequestType {
        if (std.mem.eql(u8, text, "create")) return .create;
        if (std.mem.eql(u8, text, "attach")) return .attach;
        if (std.mem.eql(u8, text, "resize")) return .resize;
        if (std.mem.eql(u8, text, "detach")) return .detach;
        if (std.mem.eql(u8, text, "kill")) return .kill;
        if (std.mem.eql(u8, text, "clear-history") or std.mem.eql(u8, text, "clearHistory") or std.mem.eql(u8, text, "clear_history")) return .clear_history;
        if (std.mem.eql(u8, text, "cleanup")) return .cleanup;
        if (std.mem.eql(u8, text, "configure-persistence") or std.mem.eql(u8, text, "configurePersistence") or std.mem.eql(u8, text, "configure_persistence")) return .configure_persistence;
        if (std.mem.eql(u8, text, "graph-get")) return .graph_get;
        if (std.mem.eql(u8, text, "graph-replace")) return .graph_replace;
        if (std.mem.eql(u8, text, "graph-wait")) return .graph_wait;
        if (std.mem.eql(u8, text, "ping")) return .ping;
        return .unknown;
    }
};

pub const ControlRequestJson = struct {
    id: []const u8 = "",
    trace_id: ?[]const u8 = null,
    traceId: ?[]const u8 = null,
    method: ?[]const u8 = null,
    type: ?[]const u8 = null,
    session_id: ?[]const u8 = null,
    sessionId: ?[]const u8 = null,
    terminal_id: ?[]const u8 = null,
    terminalId: ?[]const u8 = null,
    expected_rev: ?u64 = null,
    expectedRev: ?u64 = null,
    after_event_seq: ?u64 = null,
    afterEventSeq: ?u64 = null,
    wait_timeout_ms: ?u32 = null,
    waitTimeoutMs: ?u32 = null,
    graph_snapshot_json: ?[]const u8 = null,
    graphSnapshotJson: ?[]const u8 = null,
    cols: ?u16 = null,
    rows: ?u16 = null,
    cwd: ?[]const u8 = null,
    argv: ?[][]const u8 = null,
    session_ids: ?[][]const u8 = null,
    sessionIds: ?[][]const u8 = null,
    active_session_ids: ?[][]const u8 = null,
    activeSessionIds: ?[][]const u8 = null,
    retain_days: ?u32 = null,
    retainDays: ?u32 = null,
    max_session_bytes: ?u64 = null,
    maxSessionBytes: ?u64 = null,
    persistence_enabled: ?bool = null,
    persistenceEnabled: ?bool = null,
    enabled: ?bool = null,
    persist_input: ?bool = null,
    persistInput: ?bool = null,

    pub fn requestType(self: ControlRequestJson) RequestType {
        return RequestType.fromText(self.method orelse self.type orelse "");
    }

    pub fn requestId(self: ControlRequestJson) ?[]const u8 {
        return if (self.id.len == 0) null else self.id;
    }

    pub fn requestTraceId(self: ControlRequestJson) ?[]const u8 {
        return self.trace_id orelse self.traceId orelse self.requestId();
    }

    pub fn requestSessionId(self: ControlRequestJson) ?[]const u8 {
        return self.session_id orelse self.sessionId;
    }

    pub fn requestTerminalId(self: ControlRequestJson) ?[]const u8 {
        return self.terminal_id orelse self.terminalId;
    }

    pub fn requestExpectedRev(self: ControlRequestJson) ?u64 {
        return self.expected_rev orelse self.expectedRev;
    }

    pub fn requestAfterEventSeq(self: ControlRequestJson) ?u64 {
        return self.after_event_seq orelse self.afterEventSeq;
    }

    pub fn requestWaitTimeoutMs(self: ControlRequestJson) ?u32 {
        return self.wait_timeout_ms orelse self.waitTimeoutMs;
    }

    pub fn requestGraphSnapshotJson(self: ControlRequestJson) ?[]const u8 {
        return self.graph_snapshot_json orelse self.graphSnapshotJson;
    }

    pub fn requestSessionIds(self: ControlRequestJson) ?[][]const u8 {
        return self.session_ids orelse self.sessionIds;
    }

    pub fn requestActiveSessionIds(self: ControlRequestJson) ?[][]const u8 {
        return self.active_session_ids orelse self.activeSessionIds;
    }

    pub fn requestRetainDays(self: ControlRequestJson) ?u32 {
        return self.retain_days orelse self.retainDays;
    }

    pub fn requestMaxSessionBytes(self: ControlRequestJson) ?u64 {
        return self.max_session_bytes orelse self.maxSessionBytes;
    }

    pub fn requestPersistenceEnabled(self: ControlRequestJson) ?bool {
        return self.persistence_enabled orelse self.persistenceEnabled orelse self.enabled;
    }

    pub fn requestPersistInput(self: ControlRequestJson) ?bool {
        return self.persist_input orelse self.persistInput;
    }
};

pub const CreateRequest = struct {
    session_id: []const u8,
    terminal_id: []const u8,
    cols: u16,
    rows: u16,
    cwd: ?[]const u8 = null,
    argv: []const []const u8 = &.{},
};

pub const AttachRequest = struct {
    session_id: []const u8,
};

pub const ResizeRequest = struct {
    session_id: []const u8,
    cols: u16,
    rows: u16,
};

pub const ResponseTag = enum {
    ok,
    error_response,
};

pub const Response = union(ResponseTag) {
    ok: struct {
        request_id: []const u8,
        session_id: ?[]const u8 = null,
    },
    error_response: struct {
        request_id: ?[]const u8 = null,
        message: []const u8,
    },
};

pub const ControlResponse = struct {
    id: ?[]const u8 = null,
    ok: bool,
    protocol_version: ?u16 = null,
    daemon_version: ?[]const u8 = null,
    capabilities: ?[]const []const u8 = null,
    session_id: ?[]const u8 = null,
    stream_id: ?[]const u8 = null,
    pid: ?u32 = null,
    status: ?[]const u8 = null,
    cwd: ?[]const u8 = null,
    cols: ?u16 = null,
    rows: ?u16 = null,
    last_seq: ?u64 = null,
    attach_kind: ?[]const u8 = null,
    removed_sessions: ?u64 = null,
    removed_bytes: ?u64 = null,
    persistence_enabled: ?bool = null,
    persist_input: ?bool = null,
    graph_snapshot_json: ?[]const u8 = null,
    graph_events_json: ?[]const u8 = null,
    graph_rev: ?u64 = null,
    event_seq: ?u64 = null,
    oldest_event_seq: ?u64 = null,
    graph_changed: ?bool = null,
    requires_resync: ?bool = null,
    stream_diagnostics: ?StreamDiagnostics = null,
    error_code: ?[]const u8 = null,
    error_message: ?[]const u8 = null,
};

pub const StreamDiagnostics = struct {
    active_subscribers: usize = 0,
    pending_output_sessions: usize = 0,
    pending_output_frames: usize = 0,
    pending_output_bytes: usize = 0,
    input_frames_total: u64 = 0,
    input_bytes_total: u64 = 0,
    output_frames_total: u64 = 0,
    output_bytes_total: u64 = 0,
    last_pty_read_ns: u64 = 0,
    slow_subscriber_drops_total: u64 = 0,
    pending_output_dropped_frames_total: u64 = 0,
    pending_output_dropped_bytes_total: u64 = 0,
    pending_output_truncated_bytes_total: u64 = 0,
};

pub const ControlDiagnostics = struct {
    request_count: u64 = 0,
    failure_count: u64 = 0,
    last_request_type: ?[]const u8 = null,
    last_trace_id: ?[]const u8 = null,
    last_duration_ms: ?u64 = null,
    last_ok: ?bool = null,
    last_recorded_at_ms: ?u64 = null,
};

pub const control_protocol_version: u16 = 2;
pub const daemon_version: []const u8 = "1.0.0";
pub const control_capabilities = [_][]const u8{
    "sessions-v1",
    "stream-frames-v1",
    "persistence-v1",
    "mux-graph-v2",
};

pub fn responseJsonAlloc(allocator: std.mem.Allocator, response: ControlResponse) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();

    try out.writer.print("{f}\n", .{std.json.fmt(response, .{})});
    return out.toOwnedSlice();
}

pub fn responseJsonWithTraceAlloc(allocator: std.mem.Allocator, response: []const u8, trace_id: ?[]const u8) ![]u8 {
    const trace = trace_id orelse return allocator.dupe(u8, response);
    const trimmed = std.mem.trimRight(u8, response, " \n\r\t");
    if (trimmed.len == 0 or trimmed[trimmed.len - 1] != '}') return allocator.dupe(u8, response);

    var out: std.Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();
    try out.writer.writeAll(trimmed[0 .. trimmed.len - 1]);
    try out.writer.print(",\"trace_id\":{f}}}\n", .{std.json.fmt(trace, .{})});
    return out.toOwnedSlice();
}

pub fn responseJsonWithControlDiagnosticsAlloc(allocator: std.mem.Allocator, response: []const u8, diagnostics: ControlDiagnostics) ![]u8 {
    const trimmed = std.mem.trimRight(u8, response, " \n\r\t");
    if (trimmed.len == 0 or trimmed[trimmed.len - 1] != '}') return allocator.dupe(u8, response);

    var out: std.Io.Writer.Allocating = .init(allocator);
    errdefer out.deinit();
    try out.writer.writeAll(trimmed[0 .. trimmed.len - 1]);
    try out.writer.print(",\"control_diagnostics\":{f}}}\n", .{std.json.fmt(diagnostics, .{})});
    return out.toOwnedSlice();
}

pub const StreamKind = enum(u16) {
    output = 1,
    input = 2,
    resize = 3,
    snapshot = 4,
    exit = 5,

    pub fn fromRaw(raw: u16) ?StreamKind {
        return switch (raw) {
            1 => .output,
            2 => .input,
            3 => .resize,
            4 => .snapshot,
            5 => .exit,
            else => null,
        };
    }
};

pub const stream_magic: u32 = 0x54415346; // TASF
pub const stream_version: u16 = 1;
pub const stream_session_id_size: usize = 64;
const stream_session_id_offset: usize = 8;
const stream_seq_offset: usize = stream_session_id_offset + stream_session_id_size;
const stream_length_offset: usize = stream_seq_offset + 8;
const stream_crc_offset: usize = stream_length_offset + 4;
pub const stream_header_size: usize = stream_crc_offset + 4;
pub const max_stream_payload_bytes: u32 = limits.stream_payload_bytes_max;

/// Live stream frame layout is fixed-width header plus payload:
/// magic/version/kind, a NUL-padded 64-byte session id, sequence, payload
/// length, payload CRC32, then payload bytes. The parser leaves partial tails
/// unread for socket buffering and rejects corrupt frames deterministically.
pub const StreamCodecError = error{
    InvalidSessionId,
    PayloadTooLarge,
    NoSpaceLeft,
    InvalidSize,
    InvalidResizePayload,
    InvalidExitPayload,
};

comptime {
    assert(stream_session_id_size > 0);
    assert(stream_header_size == 88);
    assert(max_stream_payload_bytes > 0);
}

pub const StreamFrame = struct {
    kind: StreamKind,
    session_id: []const u8,
    seq: u64,
    payload: []const u8,
};

pub const StreamParseResult = struct {
    valid_bytes: usize,
    frames_seen: usize,
};

pub const ResizePayload = struct {
    cols: u16,
    rows: u16,
};

pub const ExitPayload = struct {
    exit_code: i32,
    signal: i32,
};

pub fn encodedStreamFrameSize(payload_len: usize) usize {
    return stream_header_size + payload_len;
}

pub fn encodeStreamFrame(
    out: []u8,
    kind: StreamKind,
    session_id: []const u8,
    seq: u64,
    payload: []const u8,
) ![]u8 {
    if (session_id.len == 0 or session_id.len > stream_session_id_size) return error.InvalidSessionId;
    if (payload.len > max_stream_payload_bytes) return error.PayloadTooLarge;

    const total_len = encodedStreamFrameSize(payload.len);
    if (out.len < total_len) return error.NoSpaceLeft;

    std.mem.writeInt(u32, out[0..4], stream_magic, .big);
    std.mem.writeInt(u16, out[4..6], stream_version, .big);
    std.mem.writeInt(u16, out[6..8], @intFromEnum(kind), .big);
    @memset(out[stream_session_id_offset .. stream_session_id_offset + stream_session_id_size], 0);
    @memcpy(out[stream_session_id_offset .. stream_session_id_offset + session_id.len], session_id);
    std.mem.writeInt(u64, out[stream_seq_offset..][0..8], seq, .big);
    std.mem.writeInt(u32, out[stream_length_offset..][0..4], @intCast(payload.len), .big);
    std.mem.writeInt(u32, out[stream_crc_offset..][0..4], std.hash.Crc32.hash(payload), .big);
    @memcpy(out[stream_header_size..total_len], payload);

    assert(total_len == stream_header_size + payload.len);

    return out[0..total_len];
}

pub fn parseStreamFrames(data: []const u8, visitor: anytype) !StreamParseResult {
    var offset: usize = 0;
    var valid_bytes: usize = 0;
    var frames_seen: usize = 0;

    while (offset <= data.len and data.len - offset >= stream_header_size) {
        if (std.mem.readInt(u32, data[offset..][0..4], .big) != stream_magic) break;

        const version = std.mem.readInt(u16, data[offset + 4 ..][0..2], .big);
        const kind_raw = std.mem.readInt(u16, data[offset + 6 ..][0..2], .big);
        const session_field = data[offset + stream_session_id_offset .. offset + stream_session_id_offset + stream_session_id_size];
        const seq = std.mem.readInt(u64, data[offset + stream_seq_offset ..][0..8], .big);
        const length = std.mem.readInt(u32, data[offset + stream_length_offset ..][0..4], .big);
        const expected_crc = std.mem.readInt(u32, data[offset + stream_crc_offset ..][0..4], .big);
        const payload_start = offset + stream_header_size;

        const kind = StreamKind.fromRaw(kind_raw) orelse break;
        const session_id = trimStreamSessionId(session_field);
        if (version != stream_version or session_id.len == 0 or length > max_stream_payload_bytes) break;
        if (length > data.len - payload_start) break;

        const payload_end = payload_start + @as(usize, length);

        const payload = data[payload_start..payload_end];
        if (std.hash.Crc32.hash(payload) != expected_crc) break;

        try visitor.visit(.{
            .kind = kind,
            .session_id = session_id,
            .seq = seq,
            .payload = payload,
        });
        frames_seen += 1;

        offset = payload_end;
        valid_bytes = offset;
    }

    return .{ .valid_bytes = valid_bytes, .frames_seen = frames_seen };
}

pub fn encodeResizePayload(out: []u8, cols: u16, rows: u16) ![]u8 {
    if (cols == 0 or rows == 0) return error.InvalidSize;
    if (out.len < 4) return error.NoSpaceLeft;

    std.mem.writeInt(u16, out[0..2], cols, .big);
    std.mem.writeInt(u16, out[2..4], rows, .big);
    return out[0..4];
}

pub fn decodeResizePayload(payload: []const u8) !ResizePayload {
    if (payload.len != 4) return error.InvalidResizePayload;
    const cols = std.mem.readInt(u16, payload[0..2], .big);
    const rows = std.mem.readInt(u16, payload[2..4], .big);
    if (cols == 0 or rows == 0) return error.InvalidSize;
    return .{ .cols = cols, .rows = rows };
}

pub fn encodeExitPayload(out: []u8, exit_code: i32, signal: i32) ![]u8 {
    if (out.len < 8) return error.NoSpaceLeft;

    std.mem.writeInt(i32, out[0..4], exit_code, .big);
    std.mem.writeInt(i32, out[4..8], signal, .big);
    return out[0..8];
}

pub fn decodeExitPayload(payload: []const u8) !ExitPayload {
    if (payload.len != 8) return error.InvalidExitPayload;
    return .{
        .exit_code = std.mem.readInt(i32, payload[0..4], .big),
        .signal = std.mem.readInt(i32, payload[4..8], .big),
    };
}

fn trimStreamSessionId(field: []const u8) []const u8 {
    return std.mem.trimEnd(u8, field, &.{0});
}

test "request type decoding is stable" {
    try std.testing.expectEqual(RequestType.create, RequestType.fromText("create"));
    try std.testing.expectEqual(RequestType.clear_history, RequestType.fromText("clear-history"));
    try std.testing.expectEqual(RequestType.clear_history, RequestType.fromText("clearHistory"));
    try std.testing.expectEqual(RequestType.cleanup, RequestType.fromText("cleanup"));
    try std.testing.expectEqual(RequestType.configure_persistence, RequestType.fromText("configure-persistence"));
    try std.testing.expectEqual(RequestType.graph_get, RequestType.fromText("graph-get"));
    try std.testing.expectEqual(RequestType.graph_replace, RequestType.fromText("graph-replace"));
    try std.testing.expectEqual(RequestType.graph_wait, RequestType.fromText("graph-wait"));
    try std.testing.expectEqual(RequestType.unknown, RequestType.fromText("workspace.status"));
    try std.testing.expectEqual(RequestType.ping, RequestType.fromText("ping"));
    try std.testing.expectEqual(RequestType.unknown, RequestType.fromText("other"));
}

test "control request JSON decodes persistence privacy settings" {
    var parsed = try std.json.parseFromSlice(ControlRequestJson, std.testing.allocator,
        \\{"id":"1","type":"configure-persistence","persistenceEnabled":false,"persistInput":true}
    , .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    try std.testing.expectEqual(RequestType.configure_persistence, parsed.value.requestType());
    try std.testing.expectEqual(false, parsed.value.requestPersistenceEnabled().?);
    try std.testing.expectEqual(true, parsed.value.requestPersistInput().?);
}

test "control request JSON decodes create messages" {
    var parsed = try std.json.parseFromSlice(ControlRequestJson, std.testing.allocator,
        \\{"id":"1","method":"create","session_id":"s1","terminal_id":"t1","cols":80,"rows":24,"argv":["bash"]}
    , .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    try std.testing.expectEqual(RequestType.create, parsed.value.requestType());
    try std.testing.expectEqualStrings("1", parsed.value.requestId().?);
    try std.testing.expectEqualStrings("bash", parsed.value.argv.?[0]);
}

test "control request JSON accepts protocol type and camelCase identifiers" {
    var parsed = try std.json.parseFromSlice(ControlRequestJson, std.testing.allocator,
        \\{"id":"1","traceId":"trace-1","type":"create","sessionId":"s1","terminalId":"t1"}
    , .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    try std.testing.expectEqual(RequestType.create, parsed.value.requestType());
    try std.testing.expectEqualStrings("1", parsed.value.requestId().?);
    try std.testing.expectEqualStrings("trace-1", parsed.value.requestTraceId().?);
    try std.testing.expectEqualStrings("s1", parsed.value.requestSessionId().?);
    try std.testing.expectEqualStrings("t1", parsed.value.requestTerminalId().?);
}

test "control request JSON deterministic shape sweep" {
    const cases = [_]struct {
        json: []const u8,
        request_type: RequestType,
    }{
        .{ .json = "{\"type\":\"ping\"}", .request_type = .ping },
        .{ .json = "{\"method\":\"resize\",\"session_id\":\"s\",\"cols\":1,\"rows\":1}", .request_type = .resize },
        .{ .json = "{\"type\":\"clearHistory\",\"sessionIds\":[\"s\"]}", .request_type = .clear_history },
        .{ .json = "{\"type\":\"configurePersistence\",\"enabled\":true,\"persistInput\":false}", .request_type = .configure_persistence },
        .{ .json = "{\"type\":\"graph-get\"}", .request_type = .graph_get },
        .{ .json = "{\"type\":\"graph-replace\",\"expectedRev\":0,\"graphSnapshotJson\":\"{}\"}", .request_type = .graph_replace },
        .{ .json = "{\"type\":\"graph-wait\",\"afterEventSeq\":1}", .request_type = .graph_wait },
        .{ .json = "{\"type\":\"workspace.status\"}", .request_type = .unknown },
        .{ .json = "{\"method\":\"unknown\"}", .request_type = .unknown },
    };

    for (cases) |case| {
        var parsed = try std.json.parseFromSlice(ControlRequestJson, std.testing.allocator, case.json, .{
            .ignore_unknown_fields = true,
        });
        defer parsed.deinit();
        try std.testing.expectEqual(case.request_type, parsed.value.requestType());
    }
}

test "control response formats as newline-delimited JSON" {
    const json = try responseJsonAlloc(std.testing.allocator, .{
        .id = "1",
        .ok = true,
        .protocol_version = control_protocol_version,
        .daemon_version = daemon_version,
        .capabilities = control_capabilities[0..],
        .session_id = "s1",
        .status = "live",
        .cols = 80,
        .rows = 24,
        .last_seq = 0,
    });
    defer std.testing.allocator.free(json);

    try std.testing.expect(std.mem.endsWith(u8, json, "\n"));
    try std.testing.expect(std.mem.indexOf(u8, json, "\"ok\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"protocol_version\":2") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"capabilities\":[\"sessions-v1\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"session_id\":\"s1\"") != null);
}

test "control response trace wrapper preserves one-line JSON" {
    const json = try responseJsonAlloc(std.testing.allocator, .{
        .id = "1",
        .ok = true,
    });
    defer std.testing.allocator.free(json);

    const traced = try responseJsonWithTraceAlloc(std.testing.allocator, json, "trace:\"1\"");
    defer std.testing.allocator.free(traced);

    try std.testing.expect(std.mem.endsWith(u8, traced, "\n"));
    try std.testing.expect(std.mem.indexOf(u8, traced, "\"ok\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, traced, "\"trace_id\":\"trace:\\\"1\\\"\"") != null);
}

fn readProtocolFixtureAlloc(allocator: std.mem.Allocator, name: []const u8) ![]u8 {
    const path = try std.fmt.allocPrint(
        allocator,
        "../../packages/shared/fixtures/taud-protocol/{s}",
        .{name},
    );
    defer allocator.free(path);
    return std.fs.cwd().readFileAlloc(allocator, path, 4096);
}

const ProtocolSpecFixture = struct {
    name: []const u8,
    version: u16,
    control: struct {
        protocolVersion: u16,
        daemonVersion: []const u8,
        capabilities: []const []const u8,
        requestFixtures: []const []const u8,
        responseFixtures: []const []const u8,
    },
    stream: struct {
        magic: u32,
        version: u16,
        sessionIdSize: usize,
        headerSize: usize,
        maxPayloadBytes: u32,
        frameKinds: []const struct {
            name: []const u8,
            value: u16,
        },
        fixtures: []const []const u8,
        corruptFixtures: []const []const u8,
    },
};

fn expectStringListEqual(expected: []const []const u8, actual: []const []const u8) !void {
    try std.testing.expectEqual(expected.len, actual.len);
    for (expected, actual) |expected_item, actual_item| {
        try std.testing.expectEqualStrings(expected_item, actual_item);
    }
}

test "protocol spec matches Zig constants and fixture files" {
    const spec_json = try readProtocolFixtureAlloc(std.testing.allocator, "spec.json");
    defer std.testing.allocator.free(spec_json);

    var parsed = try std.json.parseFromSlice(ProtocolSpecFixture, std.testing.allocator, spec_json, .{});
    defer parsed.deinit();
    const spec = parsed.value;

    try std.testing.expectEqual(@as(u16, 1), spec.version);
    try std.testing.expectEqual(control_protocol_version, spec.control.protocolVersion);
    try std.testing.expectEqualStrings(daemon_version, spec.control.daemonVersion);
    try expectStringListEqual(control_capabilities[0..], spec.control.capabilities);
    try std.testing.expectEqual(stream_magic, spec.stream.magic);
    try std.testing.expectEqual(stream_version, spec.stream.version);
    try std.testing.expectEqual(stream_session_id_size, spec.stream.sessionIdSize);
    try std.testing.expectEqual(stream_header_size, spec.stream.headerSize);
    try std.testing.expectEqual(max_stream_payload_bytes, spec.stream.maxPayloadBytes);

    const expected_kinds = [_]struct {
        name: []const u8,
        value: u16,
    }{
        .{ .name = "output", .value = @intFromEnum(StreamKind.output) },
        .{ .name = "input", .value = @intFromEnum(StreamKind.input) },
        .{ .name = "resize", .value = @intFromEnum(StreamKind.resize) },
        .{ .name = "snapshot", .value = @intFromEnum(StreamKind.snapshot) },
        .{ .name = "exit", .value = @intFromEnum(StreamKind.exit) },
    };
    try std.testing.expectEqual(expected_kinds.len, spec.stream.frameKinds.len);
    for (expected_kinds, spec.stream.frameKinds) |expected, actual| {
        try std.testing.expectEqualStrings(expected.name, actual.name);
        try std.testing.expectEqual(expected.value, actual.value);
    }

    for (spec.control.requestFixtures) |fixture| {
        const bytes = try readProtocolFixtureAlloc(std.testing.allocator, fixture);
        defer std.testing.allocator.free(bytes);
        try std.testing.expect(bytes.len > 0);
    }
    for (spec.control.responseFixtures) |fixture| {
        const bytes = try readProtocolFixtureAlloc(std.testing.allocator, fixture);
        defer std.testing.allocator.free(bytes);
        try std.testing.expect(bytes.len > 0);
    }
    for (spec.stream.fixtures) |fixture| {
        const bytes = try readProtocolFixtureAlloc(std.testing.allocator, fixture);
        defer std.testing.allocator.free(bytes);
        try std.testing.expect(bytes.len > 0);
    }
    for (spec.stream.corruptFixtures) |fixture| {
        const bytes = try readProtocolFixtureAlloc(std.testing.allocator, fixture);
        defer std.testing.allocator.free(bytes);
        try std.testing.expect(bytes.len > 0);
    }
}

test "control ping response matches shared golden fixture" {
    const base_json = try responseJsonAlloc(std.testing.allocator, .{
        .id = "ping-1",
        .ok = true,
        .protocol_version = control_protocol_version,
        .daemon_version = daemon_version,
        .capabilities = control_capabilities[0..],
        .status = "ok",
        .stream_diagnostics = .{},
    });
    defer std.testing.allocator.free(base_json);

    const json = try responseJsonWithControlDiagnosticsAlloc(std.testing.allocator, base_json, .{});
    defer std.testing.allocator.free(json);

    const golden = try readProtocolFixtureAlloc(std.testing.allocator, "control-ping-response.ndjson");
    defer std.testing.allocator.free(golden);

    try std.testing.expectEqualStrings(golden, json);
}

test "control attach and error responses match shared golden fixtures" {
    const attach_json = try responseJsonAlloc(std.testing.allocator, .{
        .id = "attach-1",
        .ok = true,
        .session_id = "session-1",
        .stream_id = "session-1",
        .pid = 123,
        .status = "live",
        .cwd = "/tmp/tau",
        .cols = 80,
        .rows = 24,
        .last_seq = 4,
        .attach_kind = "live",
    });
    defer std.testing.allocator.free(attach_json);
    const attach_golden = try readProtocolFixtureAlloc(std.testing.allocator, "control-attach-response.ndjson");
    defer std.testing.allocator.free(attach_golden);
    try std.testing.expectEqualStrings(attach_golden, attach_json);

    const error_json = try responseJsonAlloc(std.testing.allocator, .{
        .id = "err-1",
        .ok = false,
        .error_code = "session_not_found",
        .error_message = "session not found",
    });
    defer std.testing.allocator.free(error_json);
    const error_golden = try readProtocolFixtureAlloc(std.testing.allocator, "control-error-response.ndjson");
    defer std.testing.allocator.free(error_golden);
    try std.testing.expectEqualStrings(error_golden, error_json);
}

test "maintenance and persistence control responses match shared golden fixtures" {
    const cases = [_]struct {
        fixture: []const u8,
        response: ControlResponse,
    }{
        .{
            .fixture = "control-clear-history-response.ndjson",
            .response = .{
                .id = "clear-history-fixture",
                .ok = true,
                .removed_sessions = 1,
                .removed_bytes = 2048,
            },
        },
        .{
            .fixture = "control-cleanup-response.ndjson",
            .response = .{
                .id = "cleanup-fixture",
                .ok = true,
                .removed_sessions = 2,
                .removed_bytes = 4096,
            },
        },
        .{
            .fixture = "control-configure-persistence-response.ndjson",
            .response = .{
                .id = "configure-persistence-fixture",
                .ok = true,
                .persistence_enabled = true,
                .persist_input = false,
            },
        },
    };

    for (cases) |case| {
        const json = try responseJsonAlloc(std.testing.allocator, case.response);
        defer std.testing.allocator.free(json);
        const golden = try readProtocolFixtureAlloc(std.testing.allocator, case.fixture);
        defer std.testing.allocator.free(golden);
        try std.testing.expectEqualStrings(golden, json);
    }
}

fn responseJsonForAllocationFailure(allocator: std.mem.Allocator) !void {
    const json = responseJsonAlloc(allocator, .{
        .id = "oom",
        .ok = true,
        .session_id = "session-oom",
        .stream_id = "session-oom",
        .pid = 123,
        .status = "live",
        .cwd = "/tmp/tau-rpc-oom",
        .cols = 80,
        .rows = 24,
        .last_seq = 9,
    }) catch |err| switch (err) {
        error.WriteFailed => return error.OutOfMemory,
        else => return err,
    };
    defer allocator.free(json);
    try std.testing.expect(std.mem.endsWith(u8, json, "\n"));
}

test "control response JSON frees partial writer allocations on OOM" {
    try std.testing.checkAllAllocationFailures(
        std.testing.allocator,
        responseJsonForAllocationFailure,
        .{},
    );
}

test "stream frames encode and parse binary payloads" {
    var buffer: [128]u8 = undefined;
    const encoded = try encodeStreamFrame(&buffer, .output, "session-1", 7, "hello");

    var recorder = struct {
        count: usize = 0,
        pub fn visit(self: *@This(), frame: StreamFrame) !void {
            self.count += 1;
            try std.testing.expectEqual(StreamKind.output, frame.kind);
            try std.testing.expectEqualStrings("session-1", frame.session_id);
            try std.testing.expectEqual(@as(u64, 7), frame.seq);
            try std.testing.expectEqualStrings("hello", frame.payload);
        }
    }{};

    const result = try parseStreamFrames(encoded, &recorder);
    try std.testing.expectEqual(encoded.len, result.valid_bytes);
    try std.testing.expectEqual(@as(usize, 1), result.frames_seen);
    try std.testing.expectEqual(@as(usize, 1), recorder.count);
}

test "stream frame codec matches shared golden output fixture" {
    const golden_fixture = try readProtocolFixtureAlloc(std.testing.allocator, "stream-output-frame.hex");
    defer std.testing.allocator.free(golden_fixture);
    const golden_hex = std.mem.trim(u8, golden_fixture, " \n\r\t");
    var golden: [encodedStreamFrameSize(5)]u8 = undefined;
    _ = try std.fmt.hexToBytes(&golden, golden_hex);

    var buffer: [encodedStreamFrameSize(5)]u8 = undefined;
    const encoded = try encodeStreamFrame(&buffer, .output, "session-1", 7, "hello");
    try std.testing.expectEqualSlices(u8, &golden, encoded);

    var recorder = struct {
        count: usize = 0,
        pub fn visit(self: *@This(), frame: StreamFrame) !void {
            self.count += 1;
            try std.testing.expectEqual(StreamKind.output, frame.kind);
            try std.testing.expectEqualStrings("session-1", frame.session_id);
            try std.testing.expectEqual(@as(u64, 7), frame.seq);
            try std.testing.expectEqualStrings("hello", frame.payload);
        }
    }{};

    const result = try parseStreamFrames(&golden, &recorder);
    try std.testing.expectEqual(golden.len, result.valid_bytes);
    try std.testing.expectEqual(@as(usize, 1), result.frames_seen);
    try std.testing.expectEqual(@as(usize, 1), recorder.count);
}

test "stream frame codec matches shared golden resize exit and snapshot fixtures" {
    const cases = [_]struct {
        fixture: []const u8,
        kind: StreamKind,
        seq: u64,
        payload: []const u8,
    }{
        .{
            .fixture = "stream-resize-frame.hex",
            .kind = .resize,
            .seq = 11,
            .payload = &[_]u8{ 0x00, 0x78, 0x00, 0x28 },
        },
        .{
            .fixture = "stream-exit-frame.hex",
            .kind = .exit,
            .seq = 12,
            .payload = &[_]u8{ 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x0f },
        },
        .{
            .fixture = "stream-snapshot-frame.hex",
            .kind = .snapshot,
            .seq = 13,
            .payload = "state",
        },
    };

    for (cases) |case| {
        const golden_fixture = try readProtocolFixtureAlloc(std.testing.allocator, case.fixture);
        defer std.testing.allocator.free(golden_fixture);
        const golden_hex = std.mem.trim(u8, golden_fixture, " \n\r\t");
        var golden: [stream_header_size + 8]u8 = undefined;
        const golden_bytes = try std.fmt.hexToBytes(&golden, golden_hex);

        var buffer: [stream_header_size + 8]u8 = undefined;
        const encoded = try encodeStreamFrame(&buffer, case.kind, "session-1", case.seq, case.payload);
        try std.testing.expectEqualSlices(u8, golden_bytes, encoded);

        var recorder = struct {
            expected_kind: StreamKind,
            expected_seq: u64,
            expected_payload: []const u8,
            count: usize = 0,
            pub fn visit(self: *@This(), frame: StreamFrame) !void {
                self.count += 1;
                try std.testing.expectEqual(self.expected_kind, frame.kind);
                try std.testing.expectEqualStrings("session-1", frame.session_id);
                try std.testing.expectEqual(self.expected_seq, frame.seq);
                try std.testing.expectEqualSlices(u8, self.expected_payload, frame.payload);
            }
        }{
            .expected_kind = case.kind,
            .expected_seq = case.seq,
            .expected_payload = case.payload,
        };

        const result = try parseStreamFrames(golden_bytes, &recorder);
        try std.testing.expectEqual(golden_bytes.len, result.valid_bytes);
        try std.testing.expectEqual(@as(usize, 1), result.frames_seen);
        try std.testing.expectEqual(@as(usize, 1), recorder.count);
    }
}

test "stream parser rejects shared golden corrupt CRC fixture" {
    const corrupt_fixture = try readProtocolFixtureAlloc(std.testing.allocator, "stream-corrupt-crc-frame.hex");
    defer std.testing.allocator.free(corrupt_fixture);
    const corrupt_hex = std.mem.trim(u8, corrupt_fixture, " \n\r\t");
    var corrupt: [encodedStreamFrameSize(5)]u8 = undefined;
    _ = try std.fmt.hexToBytes(&corrupt, corrupt_hex);

    var recorder = struct {
        count: usize = 0,
        pub fn visit(self: *@This(), _: StreamFrame) !void {
            self.count += 1;
        }
    }{};

    const result = try parseStreamFrames(&corrupt, &recorder);
    try std.testing.expectEqual(@as(usize, 0), result.valid_bytes);
    try std.testing.expectEqual(@as(usize, 0), result.frames_seen);
    try std.testing.expectEqual(@as(usize, 0), recorder.count);
}

test "stream parser leaves partial tails unread" {
    var buffer: [256]u8 = undefined;
    const first = try encodeStreamFrame(buffer[0..128], .snapshot, "session-1", 8, "state");
    const second = try encodeStreamFrame(buffer[first.len..], .output, "session-1", 9, "tail");
    const total_len = first.len + second.len - 2;

    var recorder = struct {
        count: usize = 0,
        pub fn visit(self: *@This(), _: StreamFrame) !void {
            self.count += 1;
        }
    }{};

    const result = try parseStreamFrames(buffer[0..total_len], &recorder);
    try std.testing.expectEqual(first.len, result.valid_bytes);
    try std.testing.expectEqual(@as(usize, 1), result.frames_seen);
    try std.testing.expectEqual(@as(usize, 1), recorder.count);
}

test "stream parser rejects corrupt CRC payloads" {
    var buffer: [128]u8 = undefined;
    const encoded = try encodeStreamFrame(&buffer, .output, "session-1", 10, "{\"ok\":true}");
    buffer[stream_header_size] ^= 0xff;

    var recorder = struct {
        count: usize = 0,
        pub fn visit(self: *@This(), _: StreamFrame) !void {
            self.count += 1;
        }
    }{};

    const result = try parseStreamFrames(encoded, &recorder);
    try std.testing.expectEqual(@as(usize, 0), result.valid_bytes);
    try std.testing.expectEqual(@as(usize, 0), result.frames_seen);
    try std.testing.expectEqual(@as(usize, 0), recorder.count);
}

test "stream parser deterministic malformed-input sweep" {
    var prng = std.Random.DefaultPrng.init(0x54414f5f5354524d);
    const random = prng.random();

    var buffer: [256]u8 = undefined;
    var case_index: usize = 0;
    while (case_index < 256) : (case_index += 1) {
        const len = random.uintLessThan(usize, buffer.len + 1);
        random.bytes(buffer[0..len]);

        var recorder = struct {
            count: usize = 0,
            pub fn visit(self: *@This(), frame: StreamFrame) !void {
                self.count += 1;
                try std.testing.expect(frame.session_id.len > 0);
                try std.testing.expect(frame.payload.len <= max_stream_payload_bytes);
            }
        }{};

        const result = try parseStreamFrames(buffer[0..len], &recorder);
        try std.testing.expect(result.valid_bytes <= len);
        try std.testing.expectEqual(result.frames_seen, recorder.count);
    }
}

test "stream resize and exit payload helpers round-trip" {
    var resize_buffer: [4]u8 = undefined;
    const resize_payload = try encodeResizePayload(&resize_buffer, 120, 40);
    const resize = try decodeResizePayload(resize_payload);
    try std.testing.expectEqual(@as(u16, 120), resize.cols);
    try std.testing.expectEqual(@as(u16, 40), resize.rows);

    var exit_buffer: [8]u8 = undefined;
    const exit_payload = try encodeExitPayload(&exit_buffer, 2, 15);
    const exit = try decodeExitPayload(exit_payload);
    try std.testing.expectEqual(@as(i32, 2), exit.exit_code);
    try std.testing.expectEqual(@as(i32, 15), exit.signal);
}
