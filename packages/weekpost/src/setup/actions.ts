// The actions `weekpost setup --apply` can run, by step id. Each module adds its own steps here.
import type { Actions } from "./apply.ts";
import { dbActions } from "./migrate.ts";
import { remoteActions } from "./remote.ts";

export const ACTIONS: Actions = {
  ...dbActions(),
  ...remoteActions,
};
