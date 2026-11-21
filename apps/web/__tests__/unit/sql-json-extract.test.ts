import { json, MySqlDialect, mysqlTable } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";
import { jsonExtractString } from "@/utils/sql";

const notifications = mysqlTable("sql_helper_notifications", {
	data: json("data").$type<{ authorId?: string; videoId?: string }>().notNull(),
});

describe("jsonExtractString", () => {
	it("infers the JSON column keys and retains bound path parameters", () => {
		const dialect = new MySqlDialect();
		for (const field of ["authorId", "videoId"] as const) {
			const query = dialect.sqlToQuery(
				jsonExtractString(notifications.data, field),
			);
			expect(query.sql).toBe(
				"JSON_UNQUOTE(JSON_EXTRACT(`sql_helper_notifications`.`data`, ?))",
			);
			expect(query.params).toEqual([`$.${field}`]);
		}
	});
});
