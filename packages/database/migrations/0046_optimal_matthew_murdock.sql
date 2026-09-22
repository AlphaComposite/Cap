ALTER TABLE `video_uploads` ADD `recovery_attempt_count` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `video_uploads` ADD `recovery_claim_id` varchar(64);--> statement-breakpoint
ALTER TABLE `video_uploads` ADD `recovery_lease_expires_at` datetime(3);--> statement-breakpoint
CREATE INDEX `phase_recovery_lease_updated_video_idx` ON `video_uploads` (`phase`,`recovery_attempt_count`,`recovery_lease_expires_at`,`updated_at`,`video_id`);