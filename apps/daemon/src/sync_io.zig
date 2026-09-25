const std = @import("std");

// The daemon's file operations are synchronous; they do not use Io concurrency or cancellation.
// Keep their backend in one place while passing the explicit Zig 0.16 Io to std.Io APIs.
pub fn io() std.Io {
    return std.Io.Threaded.global_single_threaded.io();
}

pub fn nowNs() i96 {
    return std.Io.Clock.real.now(io()).toNanoseconds();
}

pub fn sleepMs(milliseconds: i64) void {
    std.Io.sleep(io(), .fromMilliseconds(milliseconds), .awake) catch unreachable;
}

/// Monotonic time for intervals; unaffected by wall-clock adjustments.
pub fn monotonicNs() i96 {
    return std.Io.Clock.awake.now(io()).toNanoseconds();
}

pub fn nowMs() i64 {
    return std.Io.Clock.real.now(io()).toMilliseconds();
}

pub fn fileSize(fd: std.c.fd_t) !u64 {
    const file: std.Io.File = .{ .handle = fd, .flags = .{ .nonblocking = false } };
    const stat = file.stat(io()) catch return error.FileStatFailed;
    return stat.size;
}

pub fn rename(old_path: []const u8, new_path: []const u8) !void {
    return std.Io.Dir.cwd().rename(old_path, .cwd(), new_path, io());
}

pub fn writePrivateFile(path: []const u8, data: []const u8) !void {
    const file = try std.Io.Dir.cwd().createFile(io(), path, .{ .permissions = @enumFromInt(0o600) });
    defer file.close(io());
    try file.writeStreamingAll(io(), data);
    try file.sync(io());
}

pub fn pipe() ![2]std.c.fd_t {
    var fds: [2]std.c.fd_t = undefined;
    if (std.c.pipe(&fds) != 0) return error.PipeFailed;
    return fds;
}
