import { z } from "zod";

const idSchema = z.string().trim().min(1);
const timestampSchema = z.number().int().nonnegative();

export const mattermostUserSchema = z.object({
	id: idSchema,
	username: z.string(),
	first_name: z.string().default(""),
	last_name: z.string().default(""),
	nickname: z.string().default(""),
	delete_at: timestampSchema.default(0),
	is_bot: z.boolean().default(false),
});

export const mattermostTeamSchema = z.object({
	id: idSchema,
	name: z.string(),
	display_name: z.string(),
	type: z.string(),
	delete_at: timestampSchema.default(0),
});

export const mattermostChannelSchema = z.object({
	id: idSchema,
	team_id: z.string(),
	type: z.string(),
	name: z.string(),
	display_name: z.string(),
	header: z.string().default(""),
	purpose: z.string().default(""),
	delete_at: timestampSchema.default(0),
});

export const mattermostPostSchema = z.object({
	id: idSchema,
	create_at: timestampSchema,
	update_at: timestampSchema,
	delete_at: timestampSchema,
	user_id: idSchema,
	channel_id: idSchema,
	root_id: z.string(),
	message: z.string(),
	type: z.string().default(""),
	props: z.record(z.string(), z.unknown()).default({}),
	file_ids: z.array(idSchema).default([]),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

export const mattermostPostListSchema = z.object({
	order: z.array(idSchema),
	posts: z.record(idSchema, mattermostPostSchema),
	next_post_id: z.string().optional(),
	prev_post_id: z.string().optional(),
});

export const mattermostPostSearchResultSchema = mattermostPostListSchema.extend(
	{
		order: z.array(idSchema).max(100),
	},
);

export const mattermostFileInfoSchema = z.object({
	id: idSchema,
	user_id: idSchema,
	post_id: z.string(),
	create_at: timestampSchema,
	update_at: timestampSchema,
	delete_at: timestampSchema,
	name: z.string(),
	extension: z.string().default(""),
	size: z.number().int().nonnegative(),
	mime_type: z.string(),
});

export type MattermostUser = z.output<typeof mattermostUserSchema>;
export type MattermostTeam = z.output<typeof mattermostTeamSchema>;
export type MattermostChannel = z.output<typeof mattermostChannelSchema>;
export type MattermostPost = z.output<typeof mattermostPostSchema>;
export type MattermostPostList = z.output<typeof mattermostPostListSchema>;
export type MattermostFileInfo = z.output<typeof mattermostFileInfoSchema>;
