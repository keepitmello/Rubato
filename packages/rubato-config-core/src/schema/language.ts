import * as z from "zod"

// The language the small models write in when nothing in the situation says otherwise: session
// titles, summaries, stories. A code ("ko", "pt-BR") or an English name ("Korean"). Unset means each
// call follows the language of what it is writing about.
export const RubatoLanguageSchema = z.string().trim().min(2).max(41)
