// SQL queries for the audit. All take `from` and `to` as ISO strings on the
// `created_at` column (datetime('now') format that the worker uses).
//
// Bridging analytics_events.turn_id → messages.id works because the streaming
// turn protocol persists each assistant message with id = turn_id
// (see MessageStore.createTurn). LEFT JOIN — rows that don't match still
// contribute to totals via the "unattributed" bucket.

// Diagnostic: what fraction of llm_call rows in the window can be attributed
// to a thread? Reaching a message via turn_id is the first hop; the message
// must also have a non-null thread_id (v2 assistant turns sometimes don't).
export const SQL_JOIN_DIAGNOSTIC = `
  SELECT
    COUNT(*) AS llm_call_rows,
    SUM(CASE WHEN m.id IS NOT NULL THEN 1 ELSE 0 END) AS joined_to_message,
    SUM(CASE WHEN m.thread_id IS NOT NULL THEN 1 ELSE 0 END) AS attributed_to_thread
  FROM analytics_events ae
  LEFT JOIN messages m ON m.id = ae.turn_id
  WHERE ae.event_type = 'llm_call'
    AND ae.created_at >= ?
    AND ae.created_at < ?
`;

// Per-thread × model token totals. Rows where the join fails get a synthetic
// thread_id of `__unattributed__:<session_id>` so they still show up in
// attribution rollups even when they can't be classified.
export const SQL_THREAD_MODEL_TOTALS = `
  SELECT
    COALESCE(m.thread_id, '__unattributed__:' || ae.session_id) AS thread_id,
    ae.session_id AS session_id,
    COALESCE(ae.model, '__unknown__') AS model,
    SUM(COALESCE(ae.input_tokens, 0)) AS input_tokens,
    SUM(COALESCE(ae.output_tokens, 0)) AS output_tokens,
    COUNT(*) AS calls,
    MIN(ae.created_at) AS first_call_at,
    MAX(ae.created_at) AS last_call_at
  FROM analytics_events ae
  LEFT JOIN messages m ON m.id = ae.turn_id
  WHERE ae.event_type = 'llm_call'
    AND ae.created_at >= ?
    AND ae.created_at < ?
  GROUP BY 1, 2, 3
`;

// Tool call histogram per thread (from analytics_events rows with tool_name set).
export const SQL_THREAD_TOOL_HISTOGRAM = `
  SELECT
    COALESCE(m.thread_id, '__unattributed__:' || ae.session_id) AS thread_id,
    ae.tool_name AS tool_name,
    COUNT(*) AS calls
  FROM analytics_events ae
  LEFT JOIN messages m ON m.id = ae.turn_id
  WHERE ae.tool_name IS NOT NULL
    AND ae.created_at >= ?
    AND ae.created_at < ?
  GROUP BY 1, 2
`;

// Thread + session + user metadata for a chunk of thread IDs.
// The IN (...) placeholders are bound dynamically at call time.
//
// has_user_message powers the orchestrator-chat vs orchestrator-internal
// split (origin_channel_type is too sparsely populated to use). EXISTS
// short-circuits per thread; cheap with the (session_id, role) index.
export function sqlThreadsByIds(threadIds: string[]): { sql: string; params: string[] } {
  const placeholders = threadIds.map(() => '?').join(', ');
  return {
    sql: `
      SELECT
        st.id AS thread_id,
        st.session_id AS session_id,
        st.origin_type AS origin_type,
        st.origin_channel_type AS origin_channel_type,
        st.origin_channel_id AS origin_channel_id,
        st.origin_trigger_id AS origin_trigger_id,
        st.origin_trigger_type AS origin_trigger_type,
        st.title AS thread_title,
        s.user_id AS user_id,
        s.is_orchestrator AS is_orchestrator,
        s.purpose AS purpose,
        s.title AS session_title,
        u.email AS user_email,
        EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = st.id AND m.role = 'user') AS has_user_message,
        EXISTS (SELECT 1 FROM channel_thread_mappings ctm WHERE ctm.thread_id = st.id) AS has_channel_mapping
      FROM session_threads st
      JOIN sessions s ON s.id = st.session_id
      LEFT JOIN users u ON u.id = s.user_id
      WHERE st.id IN (${placeholders})
    `,
    params: threadIds,
  };
}

export const SQL_THREAD_MESSAGES = `
  SELECT id, thread_id, session_id, role, content, channel_type, created_at
  FROM messages
  WHERE thread_id = ?
  ORDER BY COALESCE(created_at_epoch, CAST(strftime('%s', created_at) AS INTEGER)) ASC
  LIMIT 200
`;

export const SQL_SESSION_BY_ID = `
  SELECT id, title, parent_session_id, is_orchestrator
  FROM sessions
  WHERE id = ?
  LIMIT 1
`;

export function sqlUsersByIds(userIds: string[]): { sql: string; params: string[] } {
  const placeholders = userIds.map(() => '?').join(', ');
  return {
    sql: `SELECT id, email FROM users WHERE id IN (${placeholders})`,
    params: userIds,
  };
}
