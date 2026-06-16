// App-facing tracing surface. Re-exports the Node-safe helpers; the runtime
// `instrument()` / `instrumentDO()` wiring against `@microlabs/otel-cf-workers`
// lives in `src/index.ts` (the only place that imports the Workers-only library).
export * from './config.js';
export * from './spans.js';
