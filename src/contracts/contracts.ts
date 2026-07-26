/**
 * V1 JSON contract.
 *
 * The schemas live in `./schema/`, split along the three groups the single
 * 1000-line module had grown: `primitives.ts` (warnings, subjects, probes,
 * routing, packed posts and threads, ranked candidates), `context.ts` (the
 * `context` / `thread` packet body and its evidence axes), and `results.ts`
 * (per-command envelopes and the parsed union).
 *
 * This module is the stable import site; the split is internal. Contract
 * changes still belong in `docs/json-contract.md` and `docs/agent-output.md`.
 */
export {
	type ChannelsResultV1,
	type ChannelsValidateResultV1,
	type CommandResultV1,
	type ContextCommandResultV1,
	channelsResultV1Schema,
	channelsValidateResultV1Schema,
	commandResultV1Schema,
	contextResultV1Schema,
	type DoctorResultV1,
	doctorResultV1Schema,
	type FileCommandResultV1,
	type FilesCommandResultV1,
	failureResultV1Schema,
	fileResultV1Schema,
	filesResultV1Schema,
	type PeopleCommandResultV1,
	parseCommandResultV1,
	peopleResultV1Schema,
	type SearchCommandResultV1,
	type SyncCommandResultV1,
	searchResultV1Schema,
	syncResultV1Schema,
	type ThreadCommandResultV1,
	threadResultV1Schema,
	type WhoamiResultV1,
	whoamiResultV1Schema,
} from "./schema/results.ts";
