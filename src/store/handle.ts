import type { Database } from "bun:sqlite";
import type { SearchConcepts } from "../config/config.ts";

export interface StoreHandle {
	readonly database: Database;
	readonly concepts: Readonly<SearchConcepts>;
}
