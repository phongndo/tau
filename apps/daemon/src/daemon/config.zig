const std = @import("std");

pub const Config = struct {
    root_dir: []const u8,
    database_path: []const u8,
    run_dir: []const u8,
    sessions_dir: []const u8,
    graph_path: []const u8,
    graph_previous_path: []const u8,
    socket_path: []const u8,
    pid_path: []const u8,

    pub fn fromHome(allocator: std.mem.Allocator, home: []const u8) !Config {
        const root_dir = try std.fs.path.join(allocator, &.{ home, ".tau" });
        errdefer allocator.free(root_dir);
        const database_path = try std.fs.path.join(allocator, &.{ root_dir, "tau.db" });
        errdefer allocator.free(database_path);
        const run_dir = try std.fs.path.join(allocator, &.{ root_dir, "run" });
        errdefer allocator.free(run_dir);
        const sessions_dir = try std.fs.path.join(allocator, &.{ root_dir, "sessions" });
        errdefer allocator.free(sessions_dir);
        const graph_path = try std.fs.path.join(allocator, &.{ root_dir, "mux-graph-v1.json" });
        errdefer allocator.free(graph_path);
        const graph_previous_path = try std.fs.path.join(allocator, &.{ root_dir, "mux-graph-v1.previous.json" });
        errdefer allocator.free(graph_previous_path);
        const socket_path = try std.fs.path.join(allocator, &.{ run_dir, "taud.sock" });
        errdefer allocator.free(socket_path);
        const pid_path = try std.fs.path.join(allocator, &.{ run_dir, "taud.pid" });

        return .{
            .root_dir = root_dir,
            .database_path = database_path,
            .run_dir = run_dir,
            .sessions_dir = sessions_dir,
            .graph_path = graph_path,
            .graph_previous_path = graph_previous_path,
            .socket_path = socket_path,
            .pid_path = pid_path,
        };
    }

    pub fn deinit(self: *Config, allocator: std.mem.Allocator) void {
        allocator.free(self.root_dir);
        allocator.free(self.database_path);
        allocator.free(self.run_dir);
        allocator.free(self.sessions_dir);
        allocator.free(self.graph_path);
        allocator.free(self.graph_previous_path);
        allocator.free(self.socket_path);
        allocator.free(self.pid_path);
        self.* = undefined;
    }
};

test "config derives tau paths from home" {
    var config = try Config.fromHome(std.testing.allocator, "/tmp/example-home");
    defer config.deinit(std.testing.allocator);

    try std.testing.expectEqualStrings("/tmp/example-home/.tau", config.root_dir);
    try std.testing.expectEqualStrings("/tmp/example-home/.tau/run/taud.sock", config.socket_path);
    try std.testing.expectEqualStrings("/tmp/example-home/.tau/mux-graph-v1.json", config.graph_path);
}

fn configFromHomeForAllocationFailure(allocator: std.mem.Allocator) !void {
    var config = try Config.fromHome(allocator, "/tmp/tau-oom-home");
    defer config.deinit(allocator);
}

test "config fromHome cleans up every partial allocation on OOM" {
    try std.testing.checkAllAllocationFailures(
        std.testing.allocator,
        configFromHomeForAllocationFailure,
        .{},
    );
}
