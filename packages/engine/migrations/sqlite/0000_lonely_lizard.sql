CREATE TABLE `engine_decision_gate_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`gate_id` text NOT NULL,
	`channel_type` text NOT NULL,
	`ref` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `engine_decision_gate_refs_gate` ON `engine_decision_gate_refs` (`gate_id`);--> statement-breakpoint
CREATE TABLE `engine_decision_gates` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`actions` text NOT NULL,
	`origin` text,
	`context` text,
	`resolution` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `engine_decision_gates_thread` ON `engine_decision_gates` (`session_id`,`thread_id`,`status`);--> statement-breakpoint
CREATE TABLE `engine_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`parent_id` text,
	`entry_type` text NOT NULL,
	`role` text,
	`content` text,
	`parts` text,
	`author` text,
	`channel` text,
	`model` text,
	`summary` text,
	`covered_entry_ids` text,
	`token_count_before` integer,
	`token_count_after` integer,
	`file_context` text,
	`branch_root_id` text,
	`branch_leaf_id` text,
	`gate_id` text,
	`resolved_at` text,
	`resolution` text,
	`withdrawn_reason` text,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `engine_entries_thread` ON `engine_entries` (`session_id`,`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `engine_entries_gate` ON `engine_entries` (`gate_id`);--> statement-breakpoint
CREATE TABLE `engine_queue_items` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`status` text NOT NULL,
	`mode` text NOT NULL,
	`content` text NOT NULL,
	`author` text,
	`channel` text,
	`reply_target` text,
	`model` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `engine_queue_items_thread` ON `engine_queue_items` (`session_id`,`thread_id`,`status`);--> statement-breakpoint
CREATE TABLE `engine_queue_state` (
	`thread_id` text NOT NULL,
	`session_id` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`active_item_id` text,
	`pending` text NOT NULL,
	`collect_buffer` text,
	`blocked_gate_id` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `thread_id`)
);
--> statement-breakpoint
CREATE TABLE `engine_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`workspace` text NOT NULL,
	`purpose` text NOT NULL,
	`status` text NOT NULL,
	`sandbox_id` text,
	`snapshot_id` text,
	`parent_session_id` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `engine_sessions_user` ON `engine_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `engine_sessions_status` ON `engine_sessions` (`status`);--> statement-breakpoint
CREATE TABLE `engine_suspended_turns` (
	`session_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`queue_item_id` text NOT NULL,
	`gate_id` text NOT NULL,
	`model` text NOT NULL,
	`leaf_entry_id` text,
	`tool_call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`tool_args` text NOT NULL,
	`resume_key` text NOT NULL,
	`attempt` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `thread_id`)
);
--> statement-breakpoint
CREATE INDEX `engine_suspended_turns_gate` ON `engine_suspended_turns` (`gate_id`);--> statement-breakpoint
CREATE TABLE `engine_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`key` text NOT NULL,
	`status` text NOT NULL,
	`active_leaf_entry_id` text,
	`queue_mode` text NOT NULL,
	`model` text,
	`summary` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `engine_threads_session` ON `engine_threads` (`session_id`);--> statement-breakpoint
CREATE INDEX `engine_threads_session_key` ON `engine_threads` (`session_id`,`key`);