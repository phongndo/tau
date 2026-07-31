const std = @import("std");
const limits = @import("limits.zig");

pub const schema_version: u32 = 1;
pub const event_history_max: usize = 256;
pub const default_snapshot_json =
    \\{"schemaVersion":1,"graphRev":0,"eventSeq":0,"tabs":[],"panes":[],"activeTabId":null,"activePaneId":null}
;

pub const Error = error{
    Conflict,
    InvalidGraph,
    GraphTooLarge,
    ChecksumMismatch,
    UnsupportedSchema,
};

pub const Event = struct {
    event_seq: u64,
    graph_rev: u64,
    at_ms: i64,
};

const PersistedEnvelope = struct {
    schema_version: u32,
    graph_rev: u64,
    event_seq: u64,
    checksum: u32,
    snapshot_json: []const u8,
};

pub const Replay = struct {
    snapshot_json: []const u8,
    graph_rev: u64,
    event_seq: u64,
    oldest_event_seq: u64,
    requires_resync: bool,
    changed: bool,
};

pub const Graph = struct {
    allocator: std.mem.Allocator,
    graph_rev: u64 = 0,
    event_seq: u64 = 0,
    snapshot_json: ?[]u8 = null,
    events: std.ArrayList(Event) = .empty,

    pub fn init(allocator: std.mem.Allocator) Graph {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *Graph) void {
        if (self.snapshot_json) |bytes| self.allocator.free(bytes);
        self.events.deinit(self.allocator);
        self.* = undefined;
    }

    pub fn snapshot(self: *const Graph) []const u8 {
        return self.snapshot_json orelse default_snapshot_json;
    }

    pub fn oldestEventSeq(self: *const Graph) u64 {
        return if (self.events.items.len > 0) self.events.items[0].event_seq else self.event_seq;
    }

    pub fn eventsJsonAlloc(self: *const Graph, after_event_seq: u64) ![]u8 {
        var out: std.Io.Writer.Allocating = .init(self.allocator);
        errdefer out.deinit();
        try out.writer.writeByte('[');
        var first = true;
        for (self.events.items) |event| {
            if (event.event_seq <= after_event_seq) continue;
            if (!first) try out.writer.writeByte(',');
            first = false;
            try writeGraphEventJson(&out.writer, event);
        }
        try out.writer.writeByte(']');
        return out.toOwnedSlice();
    }

    pub fn replay(self: *const Graph, after_event_seq: ?u64) Replay {
        const after = after_event_seq orelse 0;
        const oldest = self.oldestEventSeq();
        return .{
            .snapshot_json = self.snapshot(),
            .graph_rev = self.graph_rev,
            .event_seq = self.event_seq,
            .oldest_event_seq = oldest,
            .requires_resync = after > 0 and after < oldest,
            .changed = after != self.event_seq,
        };
    }

    pub fn replaceSnapshot(self: *Graph, json: []const u8, expected_rev: ?u64) !void {
        if (expected_rev) |expected| {
            if (expected != self.graph_rev) return Error.Conflict;
        }
        try validateSnapshot(self.allocator, json);

        const next_rev = std.math.add(u64, self.graph_rev, 1) catch return Error.InvalidGraph;
        const next_seq = std.math.add(u64, self.event_seq, 1) catch return Error.InvalidGraph;
        const at_ms = std.time.milliTimestamp();
        // Persist committed counters inside the snapshot body so RPC consumers see one coherent state.
        const copy = try injectSnapshotRevisions(self.allocator, json, next_rev, next_seq);
        errdefer self.allocator.free(copy);

        try self.events.append(self.allocator, .{ .event_seq = next_seq, .graph_rev = next_rev, .at_ms = at_ms });
        if (self.events.items.len > event_history_max) {
            _ = self.events.orderedRemove(0);
        }
        if (self.snapshot_json) |old| self.allocator.free(old);
        self.snapshot_json = copy;
        self.graph_rev = next_rev;
        self.event_seq = next_seq;
    }

    pub fn persist(self: *const Graph, path: []const u8, previous_path: []const u8) !void {
        const snapshot_json = self.snapshot();
        const envelope = PersistedEnvelope{
            .schema_version = schema_version,
            .graph_rev = self.graph_rev,
            .event_seq = self.event_seq,
            .checksum = std.hash.Crc32.hash(snapshot_json),
            .snapshot_json = snapshot_json,
        };
        var out: std.Io.Writer.Allocating = .init(self.allocator);
        defer out.deinit();
        try out.writer.print("{f}\n", .{std.json.fmt(envelope, .{})});

        const temporary_path = try std.fmt.allocPrint(self.allocator, "{s}.tmp-{d}", .{ path, std.c.getpid() });
        defer self.allocator.free(temporary_path);
        std.fs.cwd().deleteFile(temporary_path) catch {};
        errdefer std.fs.cwd().deleteFile(temporary_path) catch {};

        var file = try std.fs.cwd().createFile(temporary_path, .{ .truncate = true, .mode = 0o600 });
        defer file.close();
        try file.writeAll(out.written());
        try file.sync();

        std.fs.cwd().deleteFile(previous_path) catch |err| switch (err) {
            error.FileNotFound => {},
            else => return err,
        };
        std.fs.cwd().rename(path, previous_path) catch |err| switch (err) {
            error.FileNotFound => {},
            else => return err,
        };
        try std.fs.cwd().rename(temporary_path, path);
    }

    pub fn restore(self: *Graph, path: []const u8, previous_path: []const u8) !bool {
        if (try self.restoreOne(path)) return true;
        return self.restoreOne(previous_path);
    }

    fn restoreOne(self: *Graph, path: []const u8) !bool {
        const bytes = std.fs.cwd().readFileAlloc(self.allocator, path, limits.graph_snapshot_bytes_max) catch |err| switch (err) {
            error.FileNotFound => return false,
            else => return err,
        };
        defer self.allocator.free(bytes);

        var parsed = std.json.parseFromSlice(PersistedEnvelope, self.allocator, bytes, .{
            .ignore_unknown_fields = true,
        }) catch return false;
        defer parsed.deinit();
        const envelope = parsed.value;
        if (envelope.schema_version != schema_version) return false;
        if (std.hash.Crc32.hash(envelope.snapshot_json) != envelope.checksum) return false;
        validateSnapshot(self.allocator, envelope.snapshot_json) catch return false;

        const copy = injectSnapshotRevisions(
            self.allocator,
            envelope.snapshot_json,
            envelope.graph_rev,
            envelope.event_seq,
        ) catch return false;
        if (self.snapshot_json) |old| self.allocator.free(old);
        self.snapshot_json = copy;
        self.graph_rev = envelope.graph_rev;
        self.event_seq = envelope.event_seq;
        self.events.clearRetainingCapacity();
        if (self.event_seq > 0) try self.events.append(self.allocator, .{
            .event_seq = self.event_seq,
            .graph_rev = self.graph_rev,
            .at_ms = std.time.milliTimestamp(),
        });
        return true;
    }
};

fn writeGraphEventJson(writer: *std.Io.Writer, event: Event) !void {
    // MuxGraphEventSchema requires numeric `at` (epoch millis).
    try writer.writeAll("{\"eventSeq\":");
    try writer.print("{d}", .{event.event_seq});
    try writer.writeAll(",\"graphRev\":");
    try writer.print("{d}", .{event.graph_rev});
    try writer.writeAll(",\"kind\":\"layout-replaced\",\"at\":");
    try writer.print("{d}", .{event.at_ms});
    try writer.writeByte('}');
}

fn injectSnapshotRevisions(
    allocator: std.mem.Allocator,
    json: []const u8,
    graph_rev: u64,
    event_seq: u64,
) ![]u8 {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, json, .{}) catch return Error.InvalidGraph;
    defer parsed.deinit();
    switch (parsed.value) {
        .object => |*object| {
            try object.put("graphRev", .{ .integer = @intCast(graph_rev) });
            try object.put("eventSeq", .{ .integer = @intCast(event_seq) });
        },
        else => return Error.InvalidGraph,
    }
    return try std.fmt.allocPrint(allocator, "{f}", .{std.json.fmt(parsed.value, .{})});
}

fn stringField(object: std.json.ObjectMap, name: []const u8) ?[]const u8 {
    const value = object.get(name) orelse return null;
    return switch (value) {
        .string => |text| text,
        else => null,
    };
}

fn numberFieldPresent(object: std.json.ObjectMap, name: []const u8) bool {
    const value = object.get(name) orelse return false;
    return switch (value) {
        .integer, .float => true,
        else => false,
    };
}

fn validateId(value: []const u8) !void {
    if (value.len == 0 or value.len > limits.graph_id_bytes_max) return Error.InvalidGraph;
}

fn validateNode(
    value: std.json.Value,
    pane_ids: *const std.StringHashMap(void),
    referenced: *std.StringHashMap(void),
    depth: usize,
) !void {
    if (depth > limits.graph_tree_depth_max) return Error.InvalidGraph;
    switch (value) {
        .string => |pane_id| {
            try validateId(pane_id);
            if (!pane_ids.contains(pane_id) or referenced.contains(pane_id)) return Error.InvalidGraph;
            try referenced.put(pane_id, {});
        },
        .object => |object| {
            const node_type = stringField(object, "type") orelse return Error.InvalidGraph;
            if (std.mem.eql(u8, node_type, "split")) {
                const children_value = object.get("children") orelse return Error.InvalidGraph;
                const percentages_value = object.get("splitPercentages") orelse return Error.InvalidGraph;
                const children = switch (children_value) {
                    .array => |items| items.items,
                    else => return Error.InvalidGraph,
                };
                const percentages = switch (percentages_value) {
                    .array => |items| items.items,
                    else => return Error.InvalidGraph,
                };
                // Exactly two or more children; percentages must align 1:1 with children.
                if (children.len < 2 or children.len > limits.graph_panes_max) return Error.InvalidGraph;
                if (percentages.len != children.len) return Error.InvalidGraph;
                // Match shared normalizeSplitPercentages: [5,95] only when every child can hold 5%.
                const enforce_share_bounds = children.len * 5 <= 100;
                var sum: f64 = 0;
                for (percentages) |percentage| {
                    const number: f64 = switch (percentage) {
                        .float => |item| item,
                        .integer => |item| @floatFromInt(item),
                        else => return Error.InvalidGraph,
                    };
                    if (!std.math.isFinite(number) or number <= 0) return Error.InvalidGraph;
                    if (enforce_share_bounds and (number < 5 or number > 95)) return Error.InvalidGraph;
                    sum += number;
                }
                if (@abs(sum - 100.0) > 0.01) return Error.InvalidGraph;
                for (children) |child| try validateNode(child, pane_ids, referenced, depth + 1);
                const direction = stringField(object, "direction") orelse return Error.InvalidGraph;
                if (!std.mem.eql(u8, direction, "row") and !std.mem.eql(u8, direction, "column")) return Error.InvalidGraph;
            } else if (std.mem.eql(u8, node_type, "tabs")) {
                const tabs_value = object.get("tabs") orelse return Error.InvalidGraph;
                const tabs = switch (tabs_value) {
                    .array => |items| items.items,
                    else => return Error.InvalidGraph,
                };
                if (tabs.len == 0 or tabs.len > limits.graph_panes_max) return Error.InvalidGraph;
                const active_index_value = object.get("activeTabIndex") orelse return Error.InvalidGraph;
                const active_index: i64 = switch (active_index_value) {
                    .integer => |item| item,
                    else => return Error.InvalidGraph,
                };
                if (active_index < 0 or active_index >= @as(i64, @intCast(tabs.len))) return Error.InvalidGraph;
                // Shared MuxPaneTreeNode tabs entries are pane ID strings only (no nested trees).
                for (tabs) |tab_value| {
                    const pane_id = switch (tab_value) {
                        .string => |id| id,
                        else => return Error.InvalidGraph,
                    };
                    try validateId(pane_id);
                    if (!pane_ids.contains(pane_id) or referenced.contains(pane_id)) return Error.InvalidGraph;
                    try referenced.put(pane_id, {});
                }
            } else return Error.InvalidGraph;
        },
        else => return Error.InvalidGraph,
    }
}

pub fn validateSnapshot(allocator: std.mem.Allocator, json: []const u8) !void {
    if (json.len == 0 or json.len > limits.graph_snapshot_bytes_max) return Error.GraphTooLarge;
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, json, .{}) catch return Error.InvalidGraph;
    defer parsed.deinit();
    const root = switch (parsed.value) {
        .object => |object| object,
        else => return Error.InvalidGraph,
    };

    const version_value = root.get("schemaVersion") orelse return Error.InvalidGraph;
    const version = switch (version_value) {
        .integer => |item| item,
        else => return Error.InvalidGraph,
    };
    if (version != schema_version) return Error.UnsupportedSchema;
    const tabs_value = root.get("tabs") orelse return Error.InvalidGraph;
    const panes_value = root.get("panes") orelse return Error.InvalidGraph;
    const tabs = switch (tabs_value) {
        .array => |items| items.items,
        else => return Error.InvalidGraph,
    };
    const panes = switch (panes_value) {
        .array => |items| items.items,
        else => return Error.InvalidGraph,
    };
    if (tabs.len > limits.graph_tabs_max or panes.len > limits.graph_panes_max) return Error.GraphTooLarge;

    var pane_ids = std.StringHashMap(void).init(allocator);
    defer pane_ids.deinit();
    var pane_tabs = std.StringHashMap([]const u8).init(allocator);
    defer pane_tabs.deinit();
    var tab_ids = std.StringHashMap(void).init(allocator);
    defer tab_ids.deinit();
    for (panes) |pane_value| {
        const pane = switch (pane_value) {
            .object => |object| object,
            else => return Error.InvalidGraph,
        };
        const pane_id = stringField(pane, "id") orelse return Error.InvalidGraph;
        const tab_id = stringField(pane, "tabId") orelse return Error.InvalidGraph;
        const terminal_id = stringField(pane, "terminalId") orelse return Error.InvalidGraph;
        const pane_type = stringField(pane, "type") orelse return Error.InvalidGraph;
        // name is required by MuxPaneSurfaceSchema (may be empty string).
        _ = stringField(pane, "name") orelse return Error.InvalidGraph;
        try validateId(pane_id);
        try validateId(tab_id);
        try validateId(terminal_id);
        if (!std.mem.eql(u8, pane_type, "terminal") or pane_ids.contains(pane_id)) return Error.InvalidGraph;
        try pane_ids.put(pane_id, {});
        try pane_tabs.put(pane_id, tab_id);
    }

    var referenced = std.StringHashMap(void).init(allocator);
    defer referenced.deinit();
    for (tabs) |tab_value| {
        const tab = switch (tab_value) {
            .object => |object| object,
            else => return Error.InvalidGraph,
        };
        const tab_id = stringField(tab, "id") orelse return Error.InvalidGraph;
        // name + order are required by MuxTabSchema so desktop decode cannot reject daemon graphs.
        _ = stringField(tab, "name") orelse return Error.InvalidGraph;
        if (!numberFieldPresent(tab, "order")) return Error.InvalidGraph;
        try validateId(tab_id);
        if (tab_ids.contains(tab_id)) return Error.InvalidGraph;
        try tab_ids.put(tab_id, {});
        const layout = tab.get("root") orelse return Error.InvalidGraph;
        var tab_referenced = std.StringHashMap(void).init(allocator);
        defer tab_referenced.deinit();
        try validateNode(layout, &pane_ids, &tab_referenced, 0);
        var iterator = tab_referenced.keyIterator();
        while (iterator.next()) |pane_id| {
            const pane_tab_id = pane_tabs.get(pane_id.*) orelse return Error.InvalidGraph;
            if (!std.mem.eql(u8, pane_tab_id, tab_id) or referenced.contains(pane_id.*)) return Error.InvalidGraph;
            try referenced.put(pane_id.*, {});
        }
    }
    if (referenced.count() != pane_ids.count()) return Error.InvalidGraph;
    for (panes) |pane_value| {
        const pane = pane_value.object;
        const tab_id = stringField(pane, "tabId").?;
        if (!tab_ids.contains(tab_id)) return Error.InvalidGraph;
    }

    // MuxGraphSnapshotSchema requires activeTabId/activePaneId as NullOr(String), not omitted.
    const active_tab = root.get("activeTabId") orelse return Error.InvalidGraph;
    const active_tab_id: ?[]const u8 = switch (active_tab) {
        .null => null,
        .string => |id| blk: {
            if (!tab_ids.contains(id)) return Error.InvalidGraph;
            break :blk id;
        },
        else => return Error.InvalidGraph,
    };
    const active_pane = root.get("activePaneId") orelse return Error.InvalidGraph;
    const active_pane_id: ?[]const u8 = switch (active_pane) {
        .null => null,
        .string => |id| blk: {
            if (!pane_ids.contains(id)) return Error.InvalidGraph;
            break :blk id;
        },
        else => return Error.InvalidGraph,
    };
    // Selected pane must live on the selected tab when both are set.
    if (active_tab_id) |tab_id| {
        if (active_pane_id) |pane_id| {
            const pane_tab = pane_tabs.get(pane_id) orelse return Error.InvalidGraph;
            if (!std.mem.eql(u8, pane_tab, tab_id)) return Error.InvalidGraph;
        }
    }
}

fn validFixture() []const u8 {
    return
    \\{"schemaVersion":1,"tabs":[{"id":"t1","name":"Shell","order":0,"root":{"type":"split","direction":"row","children":["p1","p2"],"splitPercentages":[50,50]}}],"panes":[{"id":"p1","tabId":"t1","terminalId":"term1","type":"terminal","name":"one"},{"id":"p2","tabId":"t1","terminalId":"term2","type":"terminal","name":"two"}],"activeTabId":"t1","activePaneId":"p1"}
    ;
}

test "graph validates and revisions are monotonic" {
    var graph = Graph.init(std.testing.allocator);
    defer graph.deinit();
    try graph.replaceSnapshot(validFixture(), 0);
    try std.testing.expectEqual(@as(u64, 1), graph.graph_rev);
    try std.testing.expectError(Error.Conflict, graph.replaceSnapshot(validFixture(), 0));
    try graph.replaceSnapshot(validFixture(), 1);
    try std.testing.expectEqual(@as(u64, 2), graph.event_seq);
}

test "graph snapshot json embeds committed revision counters" {
    var graph = Graph.init(std.testing.allocator);
    defer graph.deinit();
    try graph.replaceSnapshot(validFixture(), 0);
    const snapshot = graph.snapshot();
    try std.testing.expect(std.mem.indexOf(u8, snapshot, "\"graphRev\":1") != null);
    try std.testing.expect(std.mem.indexOf(u8, snapshot, "\"eventSeq\":1") != null);

    const events = try graph.eventsJsonAlloc(0);
    defer std.testing.allocator.free(events);
    try std.testing.expect(std.mem.indexOf(u8, events, "\"at\":") != null);
    try std.testing.expect(std.mem.indexOf(u8, events, "layout-replaced") != null);
}

test "graph rejects duplicate and orphan panes" {
    const orphan =
        \\{"schemaVersion":1,"tabs":[{"id":"t1","name":"Shell","order":0,"root":"p1"}],"panes":[{"id":"p1","tabId":"t1","terminalId":"x","type":"terminal","name":"one"},{"id":"p2","tabId":"t1","terminalId":"y","type":"terminal","name":"two"}],"activeTabId":"t1","activePaneId":"p1"}
    ;
    try std.testing.expectError(Error.InvalidGraph, validateSnapshot(std.testing.allocator, orphan));
}

test "graph rejects active pane on a different tab than active tab" {
    const cross_tab_active =
        \\{"schemaVersion":1,"tabs":[{"id":"t1","name":"One","order":0,"root":"p1"},{"id":"t2","name":"Two","order":1,"root":"p2"}],"panes":[{"id":"p1","tabId":"t1","terminalId":"term1","type":"terminal","name":"one"},{"id":"p2","tabId":"t2","terminalId":"term2","type":"terminal","name":"two"}],"activeTabId":"t1","activePaneId":"p2"}
    ;
    try std.testing.expectError(Error.InvalidGraph, validateSnapshot(std.testing.allocator, cross_tab_active));
}

test "graph rejects panes and tabs missing desktop-required fields" {
    const missing_active_tab =
        \\{"schemaVersion":1,"tabs":[{"id":"t1","name":"Shell","order":0,"root":"p1"}],"panes":[{"id":"p1","tabId":"t1","terminalId":"term1","type":"terminal","name":"one"}],"activePaneId":"p1"}
    ;
    try std.testing.expectError(Error.InvalidGraph, validateSnapshot(std.testing.allocator, missing_active_tab));

    const missing_active_pane =
        \\{"schemaVersion":1,"tabs":[{"id":"t1","name":"Shell","order":0,"root":"p1"}],"panes":[{"id":"p1","tabId":"t1","terminalId":"term1","type":"terminal","name":"one"}],"activeTabId":"t1"}
    ;
    try std.testing.expectError(Error.InvalidGraph, validateSnapshot(std.testing.allocator, missing_active_pane));

    const pane_missing_terminal =
        \\{"schemaVersion":1,"tabs":[{"id":"t1","name":"Shell","order":0,"root":"p1"}],"panes":[{"id":"p1","tabId":"t1","type":"terminal","name":"one"}],"activeTabId":"t1","activePaneId":"p1"}
    ;
    try std.testing.expectError(Error.InvalidGraph, validateSnapshot(std.testing.allocator, pane_missing_terminal));

    const pane_missing_name =
        \\{"schemaVersion":1,"tabs":[{"id":"t1","name":"Shell","order":0,"root":"p1"}],"panes":[{"id":"p1","tabId":"t1","terminalId":"term1","type":"terminal"}],"activeTabId":"t1","activePaneId":"p1"}
    ;
    try std.testing.expectError(Error.InvalidGraph, validateSnapshot(std.testing.allocator, pane_missing_name));

    const tab_missing_name =
        \\{"schemaVersion":1,"tabs":[{"id":"t1","order":0,"root":"p1"}],"panes":[{"id":"p1","tabId":"t1","terminalId":"term1","type":"terminal","name":"one"}],"activeTabId":"t1","activePaneId":"p1"}
    ;
    try std.testing.expectError(Error.InvalidGraph, validateSnapshot(std.testing.allocator, tab_missing_name));

    const tab_missing_order =
        \\{"schemaVersion":1,"tabs":[{"id":"t1","name":"Shell","root":"p1"}],"panes":[{"id":"p1","tabId":"t1","terminalId":"term1","type":"terminal","name":"one"}],"activeTabId":"t1","activePaneId":"p1"}
    ;
    try std.testing.expectError(Error.InvalidGraph, validateSnapshot(std.testing.allocator, tab_missing_order));
}

test "graph accepts splits with more than two children" {
    const three_way =
        \\{"schemaVersion":1,"tabs":[{"id":"t1","name":"Shell","order":0,"root":{"type":"split","direction":"row","children":["p1","p2","p3"],"splitPercentages":[40,30,30]}}],"panes":[{"id":"p1","tabId":"t1","terminalId":"term1","type":"terminal","name":"one"},{"id":"p2","tabId":"t1","terminalId":"term2","type":"terminal","name":"two"},{"id":"p3","tabId":"t1","terminalId":"term3","type":"terminal","name":"three"}],"activeTabId":"t1","activePaneId":"p1"}
    ;
    try validateSnapshot(std.testing.allocator, three_way);
}

test "graph rejects nested tree nodes inside tabs entries" {
    const nested =
        \\{"schemaVersion":1,"tabs":[{"id":"t1","name":"Shell","order":0,"root":{"type":"tabs","tabs":[{"type":"split","direction":"row","children":["p1","p2"],"splitPercentages":[50,50]}],"activeTabIndex":0}}],"panes":[{"id":"p1","tabId":"t1","terminalId":"term1","type":"terminal","name":"one"},{"id":"p2","tabId":"t1","terminalId":"term2","type":"terminal","name":"two"}],"activeTabId":"t1","activePaneId":"p1"}
    ;
    try std.testing.expectError(Error.InvalidGraph, validateSnapshot(std.testing.allocator, nested));
}

test "graph requires nested tabs activeTabIndex bounds" {
    const missing_active =
        \\{"schemaVersion":1,"tabs":[{"id":"t1","name":"Shell","order":0,"root":{"type":"tabs","tabs":["p1","p2"]}}],"panes":[{"id":"p1","tabId":"t1","terminalId":"term1","type":"terminal","name":"one"},{"id":"p2","tabId":"t1","terminalId":"term2","type":"terminal","name":"two"}],"activeTabId":"t1","activePaneId":"p1"}
    ;
    try std.testing.expectError(Error.InvalidGraph, validateSnapshot(std.testing.allocator, missing_active));

    const active_oob =
        \\{"schemaVersion":1,"tabs":[{"id":"t1","name":"Shell","order":0,"root":{"type":"tabs","tabs":["p1","p2"],"activeTabIndex":2}}],"panes":[{"id":"p1","tabId":"t1","terminalId":"term1","type":"terminal","name":"one"},{"id":"p2","tabId":"t1","terminalId":"term2","type":"terminal","name":"two"}],"activeTabId":"t1","activePaneId":"p1"}
    ;
    try std.testing.expectError(Error.InvalidGraph, validateSnapshot(std.testing.allocator, active_oob));

    const active_ok =
        \\{"schemaVersion":1,"tabs":[{"id":"t1","name":"Shell","order":0,"root":{"type":"tabs","tabs":["p1","p2"],"activeTabIndex":1}}],"panes":[{"id":"p1","tabId":"t1","terminalId":"term1","type":"terminal","name":"one"},{"id":"p2","tabId":"t1","terminalId":"term2","type":"terminal","name":"two"}],"activeTabId":"t1","activePaneId":"p1"}
    ;
    try validateSnapshot(std.testing.allocator, active_ok);
}

test "graph recovers previous valid atomic checkpoint" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const current = try std.fmt.allocPrint(std.testing.allocator, ".zig-cache/tmp/{s}/graph.json", .{tmp.sub_path});
    defer std.testing.allocator.free(current);
    const previous = try std.fmt.allocPrint(std.testing.allocator, ".zig-cache/tmp/{s}/graph.previous.json", .{tmp.sub_path});
    defer std.testing.allocator.free(previous);

    var graph = Graph.init(std.testing.allocator);
    defer graph.deinit();
    try graph.replaceSnapshot(validFixture(), 0);
    try graph.persist(current, previous);
    try graph.replaceSnapshot(validFixture(), 1);
    try graph.persist(current, previous);
    try std.fs.cwd().writeFile(.{ .sub_path = current, .data = "truncated" });

    var restored = Graph.init(std.testing.allocator);
    defer restored.deinit();
    try std.testing.expect(try restored.restore(current, previous));
    try std.testing.expectEqual(@as(u64, 1), restored.graph_rev);
}
