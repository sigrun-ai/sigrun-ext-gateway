/**
 * The core session-meta document token, re-declared structurally from
 * the shared wire type. Standalone doc tokens compare by kind/scope;
 * declaring it here avoids a runtime import of core's server modules.
 * Core-contract follow-up: version drift here silently reads job meta as absent.
 */
import { defineDoc } from "@earendil-works/pi-durable";
export const SessionMetaDoc = defineDoc({
    kind: "sigrun.session-meta",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({
        pinned: false,
        tagged: [],
        archived: false,
        draft: { text: "", attachments: [] },
        source: "user",
    }),
});
