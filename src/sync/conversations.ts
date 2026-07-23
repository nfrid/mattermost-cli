import type { MattermostConfig } from "../config/config.ts";
import type { ConversationRecord, MattermostStore } from "../store/index.ts";

/** Configured conversation with optional routing priority (no search evidence). */
export interface ConfiguredConversation extends ConversationRecord {
	priority: number;
}

/**
 * Resolve the configured channel/DM allowlist against the local index.
 * Shared by search routing and file-download (must not live under search/).
 */
export function resolveConfiguredAllowlist(
	config: MattermostConfig,
	store: MattermostStore,
): ConfiguredConversation[] {
	const indexed = new Map(
		store
			.listConversations()
			.map((conversation) => [conversation.alias, conversation]),
	);
	const result: ConfiguredConversation[] = [];
	for (const [alias, channel] of Object.entries(config.channels)) {
		const indexedConversation = indexed.get(alias);
		const local =
			indexedConversation?.kind === "channel" &&
			indexedConversation.name === channel.name &&
			(!channel.id || indexedConversation.id === channel.id)
				? indexedConversation
				: undefined;
		const id = channel.id ?? local?.id;
		if (!id) continue;
		result.push({
			id,
			alias,
			kind: "channel",
			name: channel.name,
			description: channel.description,
			priority: channel.priority,
		});
	}
	for (const [alias, directMessage] of Object.entries(config.directMessages)) {
		const indexedConversation = indexed.get(alias);
		const local =
			indexedConversation?.kind === "direct_message" &&
			indexedConversation.id === directMessage.channelId
				? indexedConversation
				: undefined;
		result.push({
			id: directMessage.channelId,
			alias,
			kind: "direct_message",
			name: local?.name ?? alias,
			description: directMessage.description,
			priority: directMessage.priority,
		});
	}
	return result.sort(configuredConversationTieBreak);
}

function configuredConversationTieBreak(
	left: ConfiguredConversation,
	right: ConfiguredConversation,
): number {
	return (
		right.priority - left.priority ||
		left.alias.localeCompare(right.alias) ||
		left.id.localeCompare(right.id)
	);
}
