const std = @import("std");

const assert = std.debug.assert;

/// Central resource budgets for the Zig daemon. These are deliberately high
/// enough to avoid changing normal Tau behavior, but explicit so accidental
/// unbounded growth is reviewed in one place.
pub const sessions_max = 16 * 1024;
pub const subscribers_per_session_max = 1024;
pub const pending_output_frames_max = 4096;
pub const pending_output_bytes_max = 1024 * 1024;
pub const pending_client_bytes_max = 1024 * 1024;
pub const control_connections_max = 256;
pub const control_first_line_timeout_ms: i32 = 5000;
pub const session_dirs_scan_max = 64 * 1024;
pub const db_event_log_refs_max = 64 * 1024;
pub const db_search_results_max = 1024;
pub const graph_tabs_max = 1024;
pub const graph_panes_max = 4096;
pub const graph_tree_depth_max = 64;
pub const graph_id_bytes_max = 128;
/// Raw snapshot body max. Graph RPCs embed this as a JSON string (escapes + envelope), so the
/// value must stay well under control_payload_bytes_max and desktop CONTROL_RESPONSE_MAX_BYTES.
pub const graph_snapshot_bytes_max = 3 * 1024 * 1024;
/// Whole control request/response NDJSON line budget (includes escaped graphSnapshotJson).
pub const control_payload_bytes_max = 8 * 1024 * 1024;
pub const control_argv_items_max = 256;
pub const control_argv_item_bytes_max = 64 * 1024;
pub const control_path_bytes_max = 16 * 1024;
pub const control_title_bytes_max = 4096;
pub const graph_wait_timeout_ms_max: u32 = 30_000;

/// Wire/file format payload limits. These must remain compatible with already
/// persisted event logs, snapshots, and live stream clients.
pub const event_log_payload_bytes_max: u32 = 64 * 1024 * 1024;
pub const event_log_replay_bytes_max: usize = 1024 * 1024;
pub const event_log_excerpt_bytes_max: usize = 1024 * 1024;
pub const stream_payload_bytes_max: u32 = 64 * 1024 * 1024;
pub const snapshot_backend_name_bytes_max: usize = 128;
pub const snapshot_payload_bytes_max: usize = 16 * 1024 * 1024;

comptime {
    assert(sessions_max > 0);
    assert(subscribers_per_session_max > 0);
    assert(pending_output_frames_max > 0);
    assert(pending_output_bytes_max > 0);
    assert(pending_client_bytes_max > 0);
    assert(control_connections_max > 0);
    assert(control_first_line_timeout_ms > 0);
    assert(session_dirs_scan_max > 0);
    assert(db_event_log_refs_max > 0);
    assert(db_search_results_max > 0);
    assert(graph_tabs_max > 0);
    assert(graph_panes_max > 0);
    assert(graph_tree_depth_max > 0);
    assert(graph_id_bytes_max > 0);
    assert(graph_snapshot_bytes_max > 0);
    assert(control_payload_bytes_max > 0);
    assert(control_argv_items_max > 0);
    assert(control_argv_item_bytes_max > 0);
    assert(control_path_bytes_max > 0);
    assert(control_title_bytes_max > 0);
    assert(graph_wait_timeout_ms_max > 0);
    assert(event_log_payload_bytes_max > 0);
    assert(event_log_replay_bytes_max > 0);
    assert(event_log_excerpt_bytes_max > 0);
    assert(stream_payload_bytes_max > 0);
    assert(snapshot_backend_name_bytes_max > 0);
    assert(snapshot_payload_bytes_max > 0);
}
