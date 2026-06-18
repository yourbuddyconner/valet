-- OpenCode reports tokens as a five-way breakdown
--   { input, output, reasoning, cache: { read, write } }
-- and Anthropic prices each bucket differently (cache reads are cheaper than
-- fresh input; cache writes are more expensive; reasoning is billed as output).
-- Persist the breakdown so cost-aware analyses can decompose what the model
-- saw. `input_tokens`/`output_tokens` continue to store the raw OpenCode
-- input/output values; consumers wanting the "billable input" view sum
-- input + cache_read + cache_write.
ALTER TABLE analytics_events ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE analytics_events ADD COLUMN cache_write_tokens INTEGER;
ALTER TABLE analytics_events ADD COLUMN reasoning_tokens INTEGER;
