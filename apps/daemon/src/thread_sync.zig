const std = @import("std");

// taud is POSIX-only. Use the platform's blocking mutex/condition for its existing
// synchronous critical sections; Zig 0.16's Io.Condition requires an Io scheduler.
pub const Mutex = struct {
    inner: std.c.pthread_mutex_t = std.c.PTHREAD_MUTEX_INITIALIZER,

    pub fn lock(self: *Mutex) void {
        std.debug.assert(std.c.pthread_mutex_lock(&self.inner) == .SUCCESS);
    }

    pub fn unlock(self: *Mutex) void {
        std.debug.assert(std.c.pthread_mutex_unlock(&self.inner) == .SUCCESS);
    }
};

pub const Condition = struct {
    inner: std.c.pthread_cond_t = std.c.PTHREAD_COND_INITIALIZER,

    pub fn broadcast(self: *Condition) void {
        std.debug.assert(std.c.pthread_cond_broadcast(&self.inner) == .SUCCESS);
    }

    pub fn timedWait(self: *Condition, mutex: *Mutex, timeout_ns: u64) error{Timeout}!void {
        var deadline: std.c.timespec = undefined;
        std.debug.assert(std.c.clock_gettime(.REALTIME, &deadline) == 0);
        const nanos = @as(u64, @intCast(deadline.nsec)) + timeout_ns;
        deadline.sec += @intCast(nanos / std.time.ns_per_s);
        deadline.nsec = @intCast(nanos % std.time.ns_per_s);
        switch (std.c.pthread_cond_timedwait(&self.inner, &mutex.inner, &deadline)) {
            .SUCCESS => {},
            .TIMEDOUT => return error.Timeout,
            else => unreachable,
        }
    }
};
