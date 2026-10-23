/**
 * The admin status route (spec §8.12): `GET /v1/ext/gateway/status` →
 * `{ channels, pairing }`. Auth is declared `admin` — core's route
 * mount enforces the principal's admin flag (403 otherwise); this
 * module only renders the read it is handed.
 *
 * `pairing` ships empty until Task 4 (the pairing store lands there);
 * the field is present from day one so clients see a stable shape.
 * Sender ids in the pairing rows are HASHED (8-hex, spec §8.12's log
 * rule generalized to operator output) — Task 4 fills the rows.
 */
/**
 * Build the status route over a status read. The handler is a pure
 * render: the engine owns the rows, the route never touches the host.
 */
export function createStatusRoute(read) {
    return {
        method: "GET",
        path: "status",
        auth: "admin",
        handler: async () => new Response(`${JSON.stringify(read())}\n`, {
            status: 200,
            headers: { "content-type": "application/json" },
        }),
    };
}
