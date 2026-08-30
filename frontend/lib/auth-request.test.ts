import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { api, isNotFoundError } from "@/lib/api";
import { fetchExportFile } from "@/lib/exports";
import { authStore, setTokenGetter, resetAuthReadiness } from "@/lib/auth-store";

/**
 * A signed-in application never knowingly sends a request without its
 * credential.
 *
 * <h2>What this replaces</h2>
 *
 * <p>`buildAuthHeaders` answered "I could not get a token" with `{}` and let
 * the call go out anonymously. Three things follow, in increasing order of
 * seriousness:
 *
 * <ul>
 *   <li>the API answers 401 and the UI is left to work out what that meant;</li>
 *   <li>a retry sends a second uncredentialed request;</li>
 *   <li>and any endpoint that tolerated anonymity would answer with an empty
 *       view of the world — which is indistinguishable from an account that has
 *       nothing in it. That is the shape of "No conversations" over a full
 *       archive.</li>
 * </ul>
 *
 * <p>So this file watches the wire. The real store, the real `fetchBaseQuery`,
 * the real `prepareHeaders`; only `fetch` is stubbed, and the assertion is
 * mostly about calls that must not happen at all.
 */

type Seen = { url: string; headers: Record<string, string> };

let seen: Seen[] = [];

function headersOf(input: unknown, init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const raw =
    (typeof input === "string" ? init?.headers : (input as Request | undefined)?.headers) ?? {};
  if (raw && typeof (raw as Headers).forEach === "function") {
    (raw as Headers).forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
  } else {
    for (const [key, value] of Object.entries(raw as Record<string, string>)) {
      out[key.toLowerCase()] = value;
    }
  }
  return out;
}

/**
 * A body each endpoint can actually be parsed into.
 *
 * <p>Shaped per URL rather than one object for everything, because
 * `providesTags` reads the body — `result.content.map(...)` on the list — and a
 * stub that answers every route with the same thing fails inside RTK Query
 * rather than in an assertion, which is a confusing way to learn nothing.
 */
function bodyFor(url: string): unknown {
  if (url.includes("/action-items")) return [];
  if (url.includes("/transcript")) {
    return { meetingId: "mtg_1", transcript: "", language: "en", segments: [], speakers: [] };
  }
  if (url.includes("/summary")) return { meetingId: "mtg_1", shortSummary: "" };
  if (/\/meetings\?/.test(url)) {
    return { content: [], page: 0, size: 50, totalElements: 0, totalPages: 0 };
  }
  return { id: "mtg_1", title: "A meeting" };
}

function stubFetch() {
  const stub = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    seen.push({ url, headers: headersOf(input, init) });
    const body = JSON.stringify(bodyFor(url));
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
        forEach: () => {},
      },
      json: async () => JSON.parse(body),
      blob: async () => new Blob(["x"]),
      text: async () => body,
      clone() {
        return this;
      },
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

function store() {
  return configureStore({
    reducer: { [api.reducerPath]: api.reducer },
    middleware: (getDefault) => getDefault().concat(api.middleware),
  });
}

const previousMode = authStore.mode;

beforeEach(() => {
  seen = [];
  authStore.mode = "clerk";
  setTokenGetter(null);
  resetAuthReadiness();
});

afterEach(() => {
  authStore.mode = previousMode;
  vi.unstubAllGlobals();
});

describe("a query with no usable token", () => {
  it("sends nothing at all", async () => {
    const fetchStub = stubFetch();
    setTokenGetter(async () => null);

    await store().dispatch(api.endpoints.getMeetings.initiate({ page: 0, size: 50 }));

    expect(fetchStub).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("fails explicitly instead of resolving with nothing", async () => {
    stubFetch();
    setTokenGetter(async () => null);

    const result = await store().dispatch(
      api.endpoints.getMeetings.initiate({ page: 0, size: 50 }),
    );

    // Not `data: undefined` with no error, which every panel in the app would
    // read as "still loading" for ever. An error is a thing a screen can say.
    expect(result.isError).toBe(true);
    expect(result.data).toBeUndefined();
  });

  it("is never mistaken for a missing resource", async () => {
    // If this came back as a 404 the meeting page would say "Meeting not
    // found" about a meeting that exists, which is the one sentence that makes
    // somebody close the tab.
    stubFetch();
    setTokenGetter(async () => null);

    const result = await store().dispatch(api.endpoints.getMeeting.initiate("mtg_1"));

    expect(isNotFoundError(result.error)).toBe(false);
  });

  it("carries one sentence a person can act on, and no detail", async () => {
    stubFetch();
    setTokenGetter(async () => {
      throw new Error("clerk: token template 'orion' missing on foo.clerk.accounts.dev");
    });

    const result = await store().dispatch(api.endpoints.getMeeting.initiate("mtg_1"));
    const message = (result.error as { data?: { message?: string } })?.data?.message ?? "";

    expect(message).toMatch(/sign in again/i);
    expect(message).not.toMatch(/clerk|token|template|bearer|401/i);
  });

  it("does not retry the failure into a second anonymous request", async () => {
    const fetchStub = stubFetch();
    setTokenGetter(async () => null);
    const s = store();

    await s.dispatch(api.endpoints.getMeetings.initiate({ page: 0, size: 50 }));
    await s.dispatch(
      api.endpoints.getMeetings.initiate({ page: 0, size: 50 }, { forceRefetch: true }),
    );

    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("a query with a token", () => {
  it("goes out once, credentialed", async () => {
    const fetchStub = stubFetch();
    setTokenGetter(async () => "tok_real");

    await store().dispatch(api.endpoints.getMeetings.initiate({ page: 0, size: 50 }));

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(seen[0].headers.authorization).toBe("Bearer tok_real");
    expect(seen[0].url).toContain("/api/v1/meetings");
  });

  it("puts a credential on every endpoint it reaches", async () => {
    stubFetch();
    setTokenGetter(async () => "tok_real");
    const s = store();

    await s.dispatch(api.endpoints.getMeetings.initiate({ page: 0, size: 50 }));
    await s.dispatch(api.endpoints.getMeeting.initiate("mtg_1"));
    await s.dispatch(api.endpoints.getSummary.initiate("mtg_1"));
    await s.dispatch(api.endpoints.getTranscript.initiate("mtg_1"));
    await s.dispatch(api.endpoints.getMeetingActionItems.initiate("mtg_1"));

    expect(seen).toHaveLength(5);
    for (const request of seen) {
      expect(request.url, request.url).toContain("/api/v1/");
      expect(request.headers.authorization, request.url).toBe("Bearer tok_real");
    }
  });
});

describe("the export path, which does not go through RTK Query", () => {
  it("sends no uncredentialed request either", async () => {
    // A second, entirely separate route to `/api/v1/**` -- a hand-written
    // `fetch` in lib/exports.ts. It reads the same headers from the same place,
    // so it inherits the same refusal.
    const fetchStub = stubFetch();
    setTokenGetter(async () => null);

    await expect(fetchExportFile("mtg_1", "pdf", {}, 0)).rejects.toThrow();

    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("dev mode", () => {
  it("keeps sending its header, with no token and no session", async () => {
    const fetchStub = stubFetch();
    authStore.mode = "dev";
    authStore.devUserId = "usr_dev";
    setTokenGetter(null);

    await store().dispatch(api.endpoints.getMeetings.initiate({ page: 0, size: 50 }));

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(seen[0].headers["x-dev-user"]).toBe("usr_dev");
  });
});
