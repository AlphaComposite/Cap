export function originObjectPolicy(bucket: string, keys: string[]) {
	const unique = [
		...new Set(
			keys.filter(
				(key) =>
					key.startsWith("private/source/") ||
					key.startsWith("private/rollback/"),
			),
		),
	];
	if (
		unique.some(
			(key) =>
				key.includes("*") ||
				key.includes("?") ||
				key.includes("..") ||
				key.startsWith("/"),
		)
	) {
		throw new Error("origin policy refuses a wildcard or escaped key");
	}
	if (unique.length === 0) {
		return {
			Version: "2012-10-17",
			Statement: [] as const,
		};
	}
	return {
		Version: "2012-10-17",
		Statement: [
			{
				Sid: "ReadRecordedLiveKeys",
				Effect: "Allow",
				Action: ["s3:GetObject", "s3:GetObjectVersion"],
				Resource: unique.map((key) => `arn:aws:s3:::${bucket}/${key}`),
			},
			{
				Sid: "ListRecordedLiveKeys",
				Effect: "Allow",
				Action: ["s3:ListBucket"],
				Resource: [`arn:aws:s3:::${bucket}`],
				Condition: {
					StringEquals: {
						"s3:prefix": unique,
					},
				},
			},
		],
	};
}

export function deletionPlan(
	items: { Key?: string; VersionId?: string }[],
	key: string,
) {
	const versionIds = items
		.filter(
			(item) =>
				item.Key === key &&
				typeof item.VersionId === "string" &&
				item.VersionId.length > 0 &&
				item.VersionId !== "null",
		)
		.map((item) => item.VersionId as string);
	return {
		versionIds,
		deleteCurrent: versionIds.length === 0,
	};
}
