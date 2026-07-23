import type { MattermostSubject } from "../search/index.ts";

export function subjectValue(subject: MattermostSubject): string {
	switch (subject.kind) {
		case "ticket":
			return subject.ticketKey;
		case "post":
			return subject.postId;
		case "text":
			return subject.text;
	}
}

export function formatSubject(subject: MattermostSubject): string {
	return subjectValue(subject);
}

export function isoTimestamp(timestamp: number): string {
	return new Date(timestamp).toISOString();
}

export function conversationLabel(kind: string, alias: string): string {
	return `${kind === "channel" ? "#" : "DM "}${alias}`;
}
