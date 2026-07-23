import type { MattermostConfig } from "../config/config.ts";
import { loadMattermostConfig } from "../config/config.ts";
import { MattermostStore } from "../store/index.ts";
import type { ContextClient, ContextDependencies } from "./types.ts";

export async function withResources<T>(
	dependencies: ContextDependencies,
	operation: (
		config: MattermostConfig,
		store: MattermostStore,
		client: ContextClient | undefined,
	) => Promise<T>,
): Promise<T> {
	const config = dependencies.config ?? (await loadMattermostConfig());
	const ownedStore = dependencies.store
		? undefined
		: await MattermostStore.open(config.databasePath, {
				concepts: config.concepts,
			});
	const store = dependencies.store ?? ownedStore;
	if (!store) throw new Error("Mattermost store initialization failed.");
	try {
		return await operation(config, store, dependencies.client);
	} finally {
		ownedStore?.close();
	}
}
