import type { IndexedPost, IndexedUser } from "./types.ts";

export function rowToPost(row: Record<string, unknown>): IndexedPost {
	return {
		id: String(row.id),
		rootId: String(row.root_id),
		threadId: String(row.thread_id),
		conversationId: String(row.conversation_id),
		userId: String(row.user_id),
		createAt: Number(row.create_at),
		updateAt: Number(row.update_at),
		deleteAt: Number(row.delete_at),
		message: String(row.message),
		props: JSON.parse(String(row.props_json)),
		metadata: row.metadata_json
			? JSON.parse(String(row.metadata_json))
			: undefined,
	};
}

export function rowToUser(row: Record<string, unknown>): IndexedUser {
	return {
		id: String(row.id),
		username: String(row.username),
		firstName: String(row.first_name),
		lastName: String(row.last_name),
		nickname: String(row.nickname),
		deleteAt: Number(row.delete_at),
		isBot: Number(row.is_bot ?? 0) !== 0,
	};
}
