CREATE TABLE `edit_intent` (
	`videoId` varchar(15) NOT NULL,
	`generation` int NOT NULL,
	`intentId` varchar(64) NOT NULL,
	`sourceId` text NOT NULL,
	`canonicalSpec` json NOT NULL,
	`mappingVersion` int NOT NULL,
	`encoderProfile` json NOT NULL,
	`draftVersion` int NOT NULL,
	`draftSession` varchar(64) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	CONSTRAINT `edit_intent_video_generation` PRIMARY KEY(`videoId`,`generation`)
);
--> statement-breakpoint
CREATE TABLE `edit_revision` (
	`revisionId` varchar(64) NOT NULL,
	`videoId` varchar(15) NOT NULL,
	`intentId` varchar(64) NOT NULL,
	`sourceId` text NOT NULL,
	`generation` int NOT NULL,
	`state` varchar(32) NOT NULL,
	`attempt` int NOT NULL,
	`error` text,
	`createdAt` datetime(3) NOT NULL,
	`updatedAt` datetime(3) NOT NULL,
	CONSTRAINT `edit_revision_revisionId` PRIMARY KEY(`revisionId`)
);
--> statement-breakpoint
CREATE TABLE `revision_artifact_status` (
	`revisionId` varchar(64) NOT NULL,
	`artifact` varchar(32) NOT NULL,
	`state` varchar(32) NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`leaseUntil` datetime(3),
	`heartbeatAt` datetime(3),
	CONSTRAINT `revision_artifact_status_pk` PRIMARY KEY(`revisionId`,`artifact`)
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` int AUTO_INCREMENT NOT NULL,
	`videoId` varchar(15) NOT NULL,
	`revisionId` varchar(64) NOT NULL,
	`job` varchar(32) NOT NULL,
	`payload` json NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	CONSTRAINT `outbox_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `source_object` (
	`videoId` varchar(15) NOT NULL,
	`liveKey` varchar(512) NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`relocationState` varchar(32) NOT NULL DEFAULT 'LIVE',
	`codec` varchar(64),
	`timebase` varchar(32),
	`frameMode` varchar(16),
	`a1Digest` varchar(64),
	`indexId` varchar(128),
	`warmExpiresAt` datetime(3),
	CONSTRAINT `source_object_videoId` PRIMARY KEY(`videoId`)
);
--> statement-breakpoint
CREATE TABLE `source_relocation` (
	`id` int AUTO_INCREMENT NOT NULL,
	`videoId` varchar(15) NOT NULL,
	`revisionId` varchar(64) NOT NULL,
	`oldKey` varchar(512) NOT NULL,
	`newKey` varchar(512) NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`state` varchar(32) NOT NULL,
	`createdAt` datetime(3) NOT NULL,
	CONSTRAINT `source_relocation_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `video_publication` (
	`videoId` varchar(15) NOT NULL,
	`currentRevisionId` varchar(64),
	`generation` int NOT NULL DEFAULT 0,
	`latestDraftVersion` int NOT NULL DEFAULT 0,
	`draftSession` varchar(64) NOT NULL DEFAULT '',
	`publicationEpoch` int NOT NULL DEFAULT 0,
	`policyEpoch` int NOT NULL DEFAULT 0,
	CONSTRAINT `video_publication_videoId` PRIMARY KEY(`videoId`)
);
--> statement-breakpoint
ALTER TABLE `edit_intent` ADD CONSTRAINT `edit_intent_video_id_fk` FOREIGN KEY (`videoId`) REFERENCES `videos`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `edit_revision` ADD CONSTRAINT `edit_revision_video_id_fk` FOREIGN KEY (`videoId`) REFERENCES `videos`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `video_publication` ADD CONSTRAINT `video_publication_video_id_fk` FOREIGN KEY (`videoId`) REFERENCES `videos`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `edit_intent_video_intent_idx` ON `edit_intent` (`videoId`,`intentId`);--> statement-breakpoint
CREATE INDEX `edit_revision_video_state_idx` ON `edit_revision` (`videoId`,`state`);--> statement-breakpoint
CREATE INDEX `edit_revision_intent_idx` ON `edit_revision` (`intentId`);--> statement-breakpoint
CREATE INDEX `outbox_video_created_idx` ON `outbox` (`videoId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `source_relocation_video_idx` ON `source_relocation` (`videoId`,`createdAt`);