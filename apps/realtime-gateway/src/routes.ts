/**
 * The API's route catalog: one declaration the router and the OpenAPI document both
 * read.
 *
 * The document used to be checked against a hand-written list of paths, which meant a
 * route could gain a method, a query parameter, or a status code and the "covers exactly
 * the implemented paths" test would keep passing (adversarial review 2026-07-26 found
 * four such drifts at once). Adding a route here is what makes it dispatchable *and*
 * documented; the two cannot disagree because there is only one list.
 *
 * This describes the shape of the surface — paths, methods, parameters, which
 * operations cost quota. The per-operation detail (request bodies, response schemas)
 * lives in discovery.ts, keyed by these paths, and a test refuses either side having an
 * entry the other lacks.
 */

export interface ApiRoute {
  /** The OpenAPI path, `{id}` for parameters. */
  path: string;
  /** Matches a concrete pathname when the path is templated. */
  match?: RegExp;
  /** Methods the router dispatches; anything else is 405. */
  methods: readonly string[];
  /** Methods charged against the account quota (docs/auth.md phase 4). */
  charged?: readonly string[];
  /** Reads `?engine=` to target a named instance instead of the role default. */
  engineParam?: boolean;
  /** Served only when the capture library is enabled; 404 `library_disabled` otherwise. */
  library?: boolean;
  /** Registry writes that demo mode refuses with 403 `demo_mode`. */
  demoRefusable?: readonly string[];
  /** Answers without a credential. Everything else is 401 without one. */
  public?: boolean;
  /** Served only on a hosted (accounts) deployment. */
  hosted?: boolean;
}

/**
 * Every route this gateway serves under `/v1`, plus the two public ones. Deliberately
 * absent: `/v1/realtime` (a WebSocket, not an OpenAPI shape) and `/v1/auth/*` (the
 * authentication library's own browser surface, which this project does not stabilize).
 * Both are named in the documents' prose instead.
 */
export const apiRoutes: readonly ApiRoute[] = [
  { path: "/healthz", methods: ["GET", "HEAD"], public: true },
  {
    path: "/v1/audio/speech",
    methods: ["POST"],
    charged: ["POST"],
    engineParam: true,
  },
  {
    path: "/v1/audio/transcriptions",
    methods: ["POST"],
    charged: ["POST"],
    engineParam: true,
  },
  {
    path: "/v1/chat/completions",
    methods: ["POST"],
    charged: ["POST"],
    engineParam: true,
  },
  { path: "/v1/engines", methods: ["GET"] },
  {
    path: "/v1/agents",
    methods: ["GET", "POST"],
    demoRefusable: ["POST"],
  },
  {
    path: "/v1/agents/{id}",
    match: /^\/v1\/agents\/[A-Za-z0-9._-]{1,64}$/,
    methods: ["GET", "PATCH", "DELETE"],
    demoRefusable: ["PATCH", "DELETE"],
  },
  {
    path: "/v1/agents/{id}/publish",
    match: /^\/v1\/agents\/[A-Za-z0-9._-]{1,64}\/publish$/,
    methods: ["POST"],
    demoRefusable: ["POST"],
  },
  {
    path: "/v1/agents/{id}/audit",
    match: /^\/v1\/agents\/[A-Za-z0-9._-]{1,64}\/audit$/,
    methods: ["POST"],
  },
  {
    path: "/v1/agents/{id}/versions",
    match: /^\/v1\/agents\/[A-Za-z0-9._-]{1,64}\/versions$/,
    methods: ["GET"],
  },
  {
    path: "/v1/voices",
    methods: ["GET", "POST"],
    charged: ["POST"],
    engineParam: true,
    demoRefusable: ["POST"],
  },
  {
    path: "/v1/voices/{id}",
    match: /^\/v1\/voices\/[A-Za-z0-9._-]{1,64}$/,
    methods: ["GET", "DELETE"],
    engineParam: true,
    demoRefusable: ["DELETE"],
  },
  {
    path: "/v1/design-profiles",
    methods: ["POST"],
    charged: ["POST"],
    engineParam: true,
    demoRefusable: ["POST"],
  },
  { path: "/v1/library", methods: ["GET"], library: true },
  {
    path: "/v1/library/{id}",
    match: /^\/v1\/library\/[A-Za-z0-9-]{1,64}$/,
    methods: ["GET", "PATCH", "DELETE"],
    library: true,
  },
  {
    path: "/v1/library/{id}/audio",
    match: /^\/v1\/library\/[A-Za-z0-9-]{1,64}\/audio$/,
    methods: ["GET"],
    library: true,
  },
  {
    path: "/v1/library/{id}/promote",
    match: /^\/v1\/library\/[A-Za-z0-9-]{1,64}\/promote$/,
    methods: ["POST"],
    charged: ["POST"],
    engineParam: true,
    library: true,
  },
];

/**
 * Charges that are not HTTP routes, and so cannot be read off `apiRoutes`: the realtime
 * conversation and the spoken Studio tool. Declared here so the discovery documents can
 * state the whole charged set from one place — the enumeration in `/agent` drifted from
 * enforcement once already, by omitting exactly these.
 */
export const chargedBeyondRoutes = [
  "starting a realtime session (session.start)",
  "each turn within a realtime conversation",
  "registering a voice through the spoken Studio tool",
] as const;

/** The discovery documents, served unauthenticated on hosted deployments only. */
export const discoveryPaths = ["/agent", "/llms.txt", "/openapi.json"] as const;

/**
 * The discovery routes as catalog entries: hosted-only, public, read-only. Kept apart
 * from `apiRoutes` because they are documentation rather than API — but they are real
 * routes, so the document describes them too.
 */
export const discoveryRoutesCatalog: readonly ApiRoute[] = discoveryPaths.map(path => ({
  path,
  methods: ["GET", "HEAD"],
  public: true,
  hosted: true,
}));

/** The route serving `pathname`, or undefined when nothing claims it. */
export function routeFor(pathname: string): ApiRoute | undefined {
  return apiRoutes.find(route => (route.match ? route.match.test(pathname) : route.path === pathname));
}

/** Whether this operation costs the caller a quota charge. */
export function isCharged(pathname: string, method: string): boolean {
  return routeFor(pathname)?.charged?.includes(method) ?? false;
}
