const std = @import("std");
const taud = @import("taud");

pub fn main(init: std.process.Init) !void {
    if (debugAllocatorEnabled()) {
        var debug_allocator: std.heap.DebugAllocator(.{}) = .{
            .backing_allocator = std.heap.smp_allocator,
        };
        const allocator = debug_allocator.allocator();

        realMain(allocator, init.minimal.args) catch |err| {
            if (debug_allocator.deinit() == .leak) std.process.exit(1);
            return err;
        };
        if (debug_allocator.deinit() == .leak) std.process.exit(1);
        return;
    }

    try realMain(std.heap.smp_allocator, init.minimal.args);
}

fn realMain(allocator: std.mem.Allocator, process_args: std.process.Args) !void {
    const home = std.mem.span(std.c.getenv("HOME") orelse return error.HomeNotSet);

    var args = try std.process.Args.Iterator.initAllocator(process_args, allocator);
    defer args.deinit();
    _ = args.skip();

    var print_config = false;
    var check = false;
    while (args.next()) |arg| {
        if (std.mem.eql(u8, arg, "--print-config")) print_config = true;
        if (std.mem.eql(u8, arg, "--check")) check = true;
    }

    var config = try taud.daemon.Config.fromHome(allocator, home);
    defer config.deinit(allocator);

    var daemon = taud.daemon.Daemon.init(allocator, config);
    defer daemon.deinit();

    if (print_config) {
        daemon.printConfig();
        return;
    }

    try daemon.prepareStorage();

    if (check) return;

    try daemon.runForever();
}

fn debugAllocatorEnabled() bool {
    const value = std.c.getenv("TAUD_DEBUG_ALLOC") orelse return false;
    return std.mem.eql(u8, std.mem.span(value), "1");
}
