CREATE TABLE `biometric_epochs` (
	`epoch_start` integer PRIMARY KEY NOT NULL,
	`mean_hr` real,
	`min_hr` real,
	`max_hr` real,
	`hr_sd` real,
	`rr_count` integer DEFAULT 0 NOT NULL,
	`valid_rr_count` integer DEFAULT 0 NOT NULL,
	`rmssd` real,
	`motion` real,
	`worn` integer DEFAULT false NOT NULL,
	`stage` text,
	`sleep_session_id` integer,
	`stress` real
);
--> statement-breakpoint
CREATE TABLE `coach_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`provider` text,
	`model` text
);
--> statement-breakpoint
CREATE INDEX `coach_messages_ts_idx` ON `coach_messages` (`ts`);--> statement-breakpoint
CREATE TABLE `daily_summaries` (
	`date` text NOT NULL,
	`source` text NOT NULL,
	`recovery` real,
	`recovery_inputs` text,
	`hrv_rmssd` real,
	`hrv_sdnn` real,
	`resting_hr` real,
	`resp_rate` real,
	`skin_temp_c` real,
	`skin_temp_dev_c` real,
	`spo2` real,
	`day_strain` real,
	`day_trimp` real,
	`day_edwards` real,
	`kcal` real,
	`sleep_performance` real,
	`sleep_need_ms` integer,
	`sleep_actual_ms` integer,
	`sleep_debt_ms` integer,
	`sleep_consistency` real,
	`sleep_efficiency` real,
	`stress_avg` real,
	`stress_max` real,
	`stress_high_minutes` real,
	`worn_minutes` real,
	`calibrating` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`date`, `source`)
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`transport` text NOT NULL,
	`service_variant` text,
	`model` text,
	`serial` text,
	`firmware` text,
	`hardware` text,
	`battery_pct` integer,
	`battery_at` integer,
	`last_connected_at` integer,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE TABLE `hr_rr_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`bpm` real,
	`rr_ms` text DEFAULT '[]' NOT NULL,
	`rr_count` integer DEFAULT 0 NOT NULL,
	`rr_candidate_ms` real,
	`source` text NOT NULL,
	`sensor_contact` text,
	`raw_packet_id` integer,
	FOREIGN KEY (`raw_packet_id`) REFERENCES `raw_packets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hr_rr_samples_ts_idx` ON `hr_rr_samples` (`ts`);--> statement-breakpoint
CREATE INDEX `hr_rr_samples_raw_idx` ON `hr_rr_samples` (`raw_packet_id`);--> statement-breakpoint
CREATE INDEX `hr_rr_samples_source_ts_idx` ON `hr_rr_samples` (`source`,`ts`);--> statement-breakpoint
CREATE TABLE `import_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`filename` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`counts` text,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `motion_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`activity_g` real NOT NULL,
	`sample_count` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`raw_packet_id` integer,
	FOREIGN KEY (`raw_packet_id`) REFERENCES `raw_packets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `motion_samples_ts_idx` ON `motion_samples` (`ts`);--> statement-breakpoint
CREATE INDEX `motion_samples_raw_idx` ON `motion_samples` (`raw_packet_id`);--> statement-breakpoint
CREATE TABLE `raw_packets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`received_at` integer NOT NULL,
	`device_id` text,
	`characteristic_uuid` text NOT NULL,
	`payload_hex` text NOT NULL,
	`decoded_status` text DEFAULT 'pending' NOT NULL,
	`packet_type` integer,
	`frame_count` integer DEFAULT 0 NOT NULL,
	`decode_error` text,
	`parser_version` integer,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `raw_packets_received_idx` ON `raw_packets` (`received_at`);--> statement-breakpoint
CREATE INDEX `raw_packets_status_idx` ON `raw_packets` (`decoded_status`);--> statement-breakpoint
CREATE INDEX `raw_packets_device_idx` ON `raw_packets` (`device_id`,`id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sleep_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`external_id` text,
	`date` text NOT NULL,
	`start_ts` integer NOT NULL,
	`end_ts` integer NOT NULL,
	`is_nap` integer DEFAULT false NOT NULL,
	`in_bed_ms` integer,
	`awake_ms` integer,
	`light_ms` integer,
	`deep_ms` integer,
	`rem_ms` integer,
	`no_data_ms` integer,
	`efficiency` real,
	`disturbances` integer,
	`resp_rate` real,
	`overnight_rmssd` real,
	`resting_hr` real,
	`performance` real,
	`consistency` real,
	`need_ms` integer,
	`need_baseline_ms` integer,
	`need_strain_ms` integer,
	`need_debt_ms` integer,
	`stages_json` text,
	`computed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sleep_sessions_date_idx` ON `sleep_sessions` (`date`);--> statement-breakpoint
CREATE INDEX `sleep_sessions_start_idx` ON `sleep_sessions` (`start_ts`);--> statement-breakpoint
CREATE UNIQUE INDEX `sleep_sessions_external_idx` ON `sleep_sessions` (`source`,`external_id`);--> statement-breakpoint
CREATE TABLE `user_baseline` (
	`date` text NOT NULL,
	`metric` text NOT NULL,
	`mean` real NOT NULL,
	`sd` real NOT NULL,
	`n` integer NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`date`, `metric`)
);
--> statement-breakpoint
CREATE TABLE `workouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`external_id` text,
	`date` text NOT NULL,
	`start_ts` integer NOT NULL,
	`end_ts` integer NOT NULL,
	`sport` text NOT NULL,
	`strain` real,
	`avg_hr` real,
	`max_hr` real,
	`kcal` real,
	`trimp` real,
	`edwards_load` real,
	`zone0_ms` integer,
	`zone1_ms` integer,
	`zone2_ms` integer,
	`zone3_ms` integer,
	`zone4_ms` integer,
	`zone5_ms` integer,
	`distance_m` real,
	`computed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workouts_date_idx` ON `workouts` (`date`);--> statement-breakpoint
CREATE INDEX `workouts_start_idx` ON `workouts` (`start_ts`);--> statement-breakpoint
CREATE UNIQUE INDEX `workouts_external_idx` ON `workouts` (`source`,`external_id`);