import { type ColumnBaseConfig, sql } from "drizzle-orm";
import type { MySqlColumn } from "drizzle-orm/mysql-core";

export function jsonExtractString<
	C extends ColumnBaseConfig<"json", "MySqlJson">,
>(column: MySqlColumn<C>, field: Extract<keyof C["data"], string>) {
	const jsonParam = `$.${field}`;
	return sql<
		string | undefined
	>`JSON_UNQUOTE(JSON_EXTRACT(${column}, ${jsonParam}))`;
}
