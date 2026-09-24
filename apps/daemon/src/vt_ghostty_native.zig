const std = @import("std");
const c = @cImport({
    @cInclude("ghostty/vt.h");
});

pub const backend_name = "ghostty_native";
pub const supports_current_screen_snapshots = true;

const current_screen_magic = [_]u8{ 0x54, 0x41, 0x55, 0x47, 0x56, 0x54, 0x01, 0x00 }; // TAUGVT\1\0
const current_screen_version: u16 = 1;
const current_screen_header_size: usize = 26;
const max_current_screen_bytes: usize = 16 * 1024 * 1024;

pub const Options = struct {
    max_scrollback: u32 = 0,
};

// The daemon and Ghostty's native C ABI use the same Zig 0.16 toolchain.
// The C ABI is shared with the browser WASM build of the same revision.
fn createHandle(cols: u16, rows: u16, max_scrollback: u32) !c.GhosttyTerminal {
    var handle: c.GhosttyTerminal = null;
    if (c.ghostty_terminal_new(null, &handle, cols, rows) != c.GHOSTTY_SUCCESS) return error.OutOfMemory;
    errdefer c.ghostty_terminal_free(handle);

    const lines: usize = max_scrollback;
    if (c.ghostty_terminal_set(handle, c.GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES, &lines) != c.GHOSTTY_SUCCESS) {
        return error.GhosttyOptionFailed;
    }
    return handle;
}

fn formattedAlloc(terminal: c.GhosttyTerminal, allocator: std.mem.Allocator, format: c.GhosttyFormatterFormat, trim: bool, cursor: bool) ![]u8 {
    var options: c.GhosttyFormatterTerminalOptions = std.mem.zeroes(c.GhosttyFormatterTerminalOptions);
    options.size = @sizeOf(c.GhosttyFormatterTerminalOptions);
    options.emit = format;
    options.trim = trim;
    options.extra.size = @sizeOf(c.GhosttyFormatterTerminalExtra);
    options.extra.screen.size = @sizeOf(c.GhosttyFormatterScreenExtra);
    options.extra.screen.cursor = cursor;

    var formatter: c.GhosttyFormatter = null;
    if (c.ghostty_formatter_terminal_new(null, &formatter, terminal, options) != c.GHOSTTY_SUCCESS) {
        return error.GhosttyFormatterFailed;
    }
    defer c.ghostty_formatter_free(formatter);

    var bytes: [*c]u8 = null;
    var len: usize = 0;
    if (c.ghostty_formatter_format_alloc(formatter, null, &bytes, &len) != c.GHOSTTY_SUCCESS) {
        return error.OutOfMemory;
    }
    defer c.ghostty_free(null, bytes, len);
    if (len > max_current_screen_bytes) return error.SnapshotTooLarge;
    return allocator.dupe(u8, bytes[0..len]);
}

pub const Terminal = struct {
    cols: u16,
    rows: u16,
    max_scrollback: u32,
    handle: c.GhosttyTerminal,

    pub fn init(allocator: std.mem.Allocator, cols: u16, rows: u16) !Terminal {
        return initWithOptions(allocator, cols, rows, .{});
    }

    pub fn initWithOptions(
        allocator: std.mem.Allocator,
        cols: u16,
        rows: u16,
        options: Options,
    ) !Terminal {
        _ = allocator;
        if (cols == 0 or rows == 0) return error.InvalidSize;
        return .{
            .cols = cols,
            .rows = rows,
            .max_scrollback = options.max_scrollback,
            .handle = try createHandle(cols, rows, options.max_scrollback),
        };
    }

    pub fn deinit(self: *Terminal, allocator: std.mem.Allocator) void {
        _ = allocator;
        c.ghostty_terminal_free(self.handle);
        self.* = undefined;
    }

    pub fn write(self: *Terminal, bytes: []const u8) !void {
        if (bytes.len == 0) return;
        c.ghostty_terminal_vt_write(self.handle, bytes.ptr, bytes.len);
        // Upstream never returns an error from vt_write, but exposes a sticky semantic-failure
        // bit for allocation/processing failures. Do not treat such a screen as snapshot-safe.
        var failed: bool = false;
        if (c.ghostty_terminal_get(self.handle, c.GHOSTTY_TERMINAL_DATA_VT_PROCESSING_ERROR, &failed) != c.GHOSTTY_SUCCESS or failed) {
            return error.VtProcessingFailed;
        }
    }

    pub fn resize(self: *Terminal, allocator: std.mem.Allocator, cols: u16, rows: u16) !void {
        _ = allocator;
        if (cols == 0 or rows == 0) return error.InvalidSize;
        if (c.ghostty_terminal_resize(self.handle, cols, rows, 8, 16) != c.GHOSTTY_SUCCESS) {
            return error.GhosttyResizeFailed;
        }
        self.cols = cols;
        self.rows = rows;
    }

    pub fn plainTextAlloc(self: *const Terminal, allocator: std.mem.Allocator) ![]u8 {
        return formattedAlloc(self.handle, allocator, c.GHOSTTY_FORMATTER_FORMAT_PLAIN, true, false);
    }

    /// Serialize only the active visible screen as VT restore bytes in Tau's
    /// existing versioned envelope. Historical scrollback is not included.
    pub fn serializeCurrentScreenAlloc(self: *const Terminal, allocator: std.mem.Allocator) ![]u8 {
        const body = try formattedAlloc(self.handle, allocator, c.GHOSTTY_FORMATTER_FORMAT_VT, false, true);
        defer allocator.free(body);
        const prefix = "\x1b[2J\x1b[H";
        const vt_len = prefix.len + body.len;
        if (vt_len > max_current_screen_bytes) return error.SnapshotTooLarge;

        const total_len = current_screen_header_size + vt_len;
        const out = try allocator.alloc(u8, total_len);
        errdefer allocator.free(out);
        @memcpy(out[0..current_screen_magic.len], &current_screen_magic);
        std.mem.writeInt(u16, out[8..10], current_screen_version, .big);
        std.mem.writeInt(u16, out[10..12], self.cols, .big);
        std.mem.writeInt(u16, out[12..14], self.rows, .big);
        std.mem.writeInt(u32, out[14..18], self.max_scrollback, .big);
        std.mem.writeInt(u32, out[18..22], @intCast(vt_len), .big);
        @memcpy(out[current_screen_header_size..][0..prefix.len], prefix);
        @memcpy(out[current_screen_header_size + prefix.len ..], body);
        std.mem.writeInt(u32, out[22..26], std.hash.Crc32.hash(out[current_screen_header_size..]), .big);
        return out;
    }

    pub fn deserializeCurrentScreen(self: *Terminal, allocator: std.mem.Allocator, data: []const u8) !void {
        _ = allocator;
        if (data.len < current_screen_header_size) return error.InvalidSnapshot;
        if (!std.mem.eql(u8, data[0..current_screen_magic.len], &current_screen_magic)) return error.InvalidSnapshot;
        const version = std.mem.readInt(u16, data[8..10], .big);
        if (version != current_screen_version) return error.UnsupportedSnapshotVersion;
        const cols = std.mem.readInt(u16, data[10..12], .big);
        const rows = std.mem.readInt(u16, data[12..14], .big);
        const max_scrollback = std.mem.readInt(u32, data[14..18], .big);
        const vt_len: usize = @intCast(std.mem.readInt(u32, data[18..22], .big));
        const expected_crc = std.mem.readInt(u32, data[22..26], .big);
        if (cols == 0 or rows == 0) return error.InvalidSnapshot;
        if (vt_len > max_current_screen_bytes) return error.SnapshotTooLarge;
        if (data.len != current_screen_header_size + vt_len) return error.InvalidSnapshot;
        const vt_bytes = data[current_screen_header_size..];
        if (std.hash.Crc32.hash(vt_bytes) != expected_crc) return error.InvalidSnapshot;

        const next_handle = try createHandle(cols, rows, max_scrollback);
        errdefer c.ghostty_terminal_free(next_handle);
        c.ghostty_terminal_vt_write(next_handle, vt_bytes.ptr, vt_bytes.len);
        var failed: bool = false;
        if (c.ghostty_terminal_get(next_handle, c.GHOSTTY_TERMINAL_DATA_VT_PROCESSING_ERROR, &failed) != c.GHOSTTY_SUCCESS or failed) {
            return error.VtProcessingFailed;
        }
        c.ghostty_terminal_free(self.handle);
        self.cols = cols;
        self.rows = rows;
        self.max_scrollback = max_scrollback;
        self.handle = next_handle;
    }
};

test "ghostty native VT preserves parser state across writes" {
    var terminal = try Terminal.init(std.testing.allocator, 8, 2);
    defer terminal.deinit(std.testing.allocator);

    try terminal.write("\x1b[2");
    try terminal.write(";3HZ");

    const text = try terminal.plainTextAlloc(std.testing.allocator);
    defer std.testing.allocator.free(text);
    try std.testing.expectEqualStrings("\n  Z", text);
}
