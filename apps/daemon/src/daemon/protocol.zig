const std = @import("std");
const rpc = @import("../rpc.zig");
const session = @import("../session.zig");

pub const AttachKind = enum {
    live,
    command_resume,

    pub fn text(self: AttachKind) []const u8 {
        return switch (self) {
            .live => "live",
            .command_resume => "command-resume",
        };
    }
};

pub const SessionResponseMetadata = struct {
    attach_kind: AttachKind = .live,
};

pub fn sessionResponse(
    allocator: std.mem.Allocator,
    request: rpc.ControlRequestJson,
    item: *const session.TerminalSession,
    metadata: SessionResponseMetadata,
) ![]u8 {
    return rpc.responseJsonAlloc(allocator, .{
        .id = request.requestId(),
        .ok = true,
        .session_id = item.id,
        .pid = item.pidU32(),
        .status = item.status.text(),
        .cwd = item.cwd,
        .cols = item.cols,
        .rows = item.rows,
        .last_seq = item.last_seq,
        .attach_kind = metadata.attach_kind.text(),
    });
}

pub fn missingField(
    allocator: std.mem.Allocator,
    request: rpc.ControlRequestJson,
    field: []const u8,
) ![]u8 {
    var buffer: [64]u8 = undefined;
    const message = try std.fmt.bufPrint(&buffer, "missing field: {s}", .{field});
    return rpc.responseJsonAlloc(allocator, .{
        .id = request.requestId(),
        .ok = false,
        .error_message = message,
    });
}

pub fn notFound(allocator: std.mem.Allocator, request: rpc.ControlRequestJson) ![]u8 {
    return rpc.responseJsonAlloc(allocator, .{
        .id = request.requestId(),
        .ok = false,
        .error_code = "session_not_found",
        .error_message = "session not found",
    });
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

test "session response matches shared golden fixture" {
    const allocator = std.testing.allocator;
    var manager = session.Manager.init(allocator);
    defer manager.deinit();

    const item = try manager.create(.{
        .session_id = "session-fixture",
        .terminal_id = "terminal-fixture",
        .cols = 80,
        .rows = 24,
        .cwd = "/tmp/tau",
    });

    const json = try sessionResponse(allocator, .{
        .id = "session-response-fixture",
        .type = "create",
    }, item, .{});
    defer allocator.free(json);

    const golden = try readProtocolFixtureAlloc(allocator, "control-session-response.ndjson");
    defer allocator.free(golden);

    try std.testing.expectEqualStrings(golden, json);
}
