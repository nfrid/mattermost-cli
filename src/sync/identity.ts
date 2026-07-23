import type {
	ConfiguredChannel,
	ConfiguredDirectMessage,
} from "../config/config.ts";
import type { MattermostChannel } from "../mattermost/schemas.ts";

/** Shared channel identity checks for sync resolution and setup validation. */
export function channelIdentityMatches(
	remote: MattermostChannel,
	configured: ConfiguredChannel,
	teamId: string,
): boolean {
	return (
		(remote.type === "O" || remote.type === "P") &&
		remote.team_id === teamId &&
		remote.name === configured.name &&
		(!configured.id || remote.id === configured.id)
	);
}

/** Shared DM / group-DM identity checks for sync resolution and setup validation. */
export function directMessageIdentityMatches(
	remote: MattermostChannel,
	configured: ConfiguredDirectMessage,
): boolean {
	return (
		(remote.type === "D" || remote.type === "G") &&
		remote.id === configured.channelId
	);
}
