import { installSessionTitle } from "./extension.mjs";

export const SESSION_TITLE_FACTORY_NAME = "rubato-session-title";

export function createSessionTitleFactories() {
  return [{
    name: SESSION_TITLE_FACTORY_NAME,
    factory: (pi) => {
      if (process.env.SENPI_TASK_MEMBER) return;
      installSessionTitle(pi);
    },
  }];
}

export { installSessionTitle } from "./extension.mjs";
export {
  TITLE_ENTRY,
  TITLE_MODEL,
  parseTitle,
  sanitizeTitle,
  shouldRetitle,
  tabTitle,
} from "./session-title.mjs";
export default createSessionTitleFactories;
