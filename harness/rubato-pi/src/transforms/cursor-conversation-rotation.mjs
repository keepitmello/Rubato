import { replaceOnce } from "./replace-once.mjs";

export function isCursorConversationRotationUrl(url) {
  return url.includes("@earendil-works/pi-ai/dist/api/cursor-conversation-rotation.js");
}

const FORGET_NEEDLE = `            persist();
            return { kind: "rotated", wireId };
        },
    };
}`;

const FORGET_REPLACEMENT = `            persist();
            return { kind: "rotated", wireId };
        },
        /**
         * Drop the rotation record for a disposed conversation lineage.
         *
         * Without this the store keeps one entry per base conversation for the life
         * of the persist file, and the session-disposal cleanup below cannot finish
         * the job: the state caches would be freed while the rotation record that
         * points at their wire id stays behind forever.
         *
         * Poison handling is unchanged for live conversations. Forgetting a disposed
         * lineage is not the same as clearing poison: a later conversation reusing
         * the same base id is a genuinely new conversation and earns its own
         * surface-first pass, which is what a missing record already means.
         */
        forget(baseId) {
            if (!(baseId in records))
                return false;
            delete records[baseId];
            persist();
            return true;
        },
    };
}`;

/** 20260827-1400Z-cursor-terminal-failure-kind: forget disposed lineages. */
export function injectCursorConversationRotation(source) {
  return replaceOnce(source, FORGET_NEEDLE, FORGET_REPLACEMENT, "cursor-conversation-rotation forget");
}
