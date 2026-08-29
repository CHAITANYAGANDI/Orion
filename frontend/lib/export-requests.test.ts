import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { api } from "@/lib/api";
import { fetchExportFile, fetchSignedFile } from "@/lib/exports";
import { authStore } from "@/lib/auth-store";

/**
 * What actually goes on the wire for an export.
 *
 * <h2>Why this file exists</h2>
 *
 * <p>MP3 export was reported failing with "Meeting not found" on a meeting whose
 * summary and transcript exported perfectly. On the server that message is
 * written by one line — a lookup by meeting <em>and</em> owner coming back empty
 * — so the two candidates on this side were a different meeting id or a
 * different credential.
 *
 * <p>Neither was covered. Everywhere else in the suite `@/lib/api` is mocked,
 * which is right for testing components and useless for testing the request: a
 * mistyped path or an endpoint that quietly skipped the auth header would have
 * passed every test in the repository.
 *
 * <p>So this builds the real store, keeps the real `fetchBaseQuery`, and reads
 * the URL and headers off a stubbed `fetch`. The documents go through a plain
 * `fetch` in `lib/exports.ts` and the MP3 goes through RTK Query — two entirely
 * separate code paths to the same API — and the point of every assertion below
 * is that they agree.
 */

type Seen = { url: string; headers: Record<string, string> };

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

let seen: Seen[] = [];

function stubFetch() {
  const stub = vi.fn(async (input: unknown, init?: RequestInit) => {
    seen.push({
      url: typeof input === "string" ? input : (input as Request).url,
      headers: headersOf(input, init),
    });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null, forEach: () => {} },
      json: async () => ({ status: "preparing" }),
      blob: async () => new Blob(["x"]),
      text: async () => "{}",
      clone() {
        return this;
      },
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

/** A store with only the API slice in it, which is all the query needs. */
function store() {
  return configureStore({
    reducer: { [api.reducerPath]: api.reducer },
    middleware: (getDefault) => getDefault().concat(api.middleware),
  });
}

const previous = { mode: authStore.mode, devUserId: authStore.devUserId };

beforeEach(() => {
  seen = [];
  stubFetch();
  // Dev mode, because the header it produces is inspectable. Clerk mode goes
  // through exactly the same `buildAuthHeaders` and differs only in which
  // header comes back, which is not what is under test.
  authStore.mode = "dev";
  authStore.devUserId = "usr_probe";
});

afterEach(() => {
  vi.unstubAllGlobals();
  authStore.mode = previous.mode;
  authStore.devUserId = previous.devUserId;
});

describe("the requests an export makes", () => {
  it("asks for the document at /meetings/{id}/export", async () => {
    await fetchExportFile("mtg_1", "txt", {}, 0);

    expect(seen[0].url).toContain("/api/v1/meetings/mtg_1/export");
  });

  it("asks for the mp3 at /meetings/{id}/audio/mp3", async () => {
    await store().dispatch(api.endpoints.getMp3Export.initiate("mtg_1"));

    expect(seen[0].url).toBe("http://localhost:8080/api/v1/meetings/mtg_1/audio/mp3");
  });

  it("names the same meeting in both", async () => {
    // The first of the two candidates for "Meeting not found": a different id.
    await fetchExportFile("mtg_abc123", "txt", {}, 0);
    await store().dispatch(api.endpoints.getMp3Export.initiate("mtg_abc123"));

    for (const request of seen) {
      expect(request.url, request.url).toContain("/meetings/mtg_abc123/");
    }
    expect(seen).toHaveLength(2);
  });

  it("sends the same credential in both", async () => {
    // The second candidate. The document path builds its headers by hand and
    // the MP3 path goes through RTK Query's `prepareHeaders`; both call
    // `buildAuthHeaders`, and this is the only test that proves the second one
    // does.
    await fetchExportFile("mtg_1", "txt", {}, 0);
    await store().dispatch(api.endpoints.getMp3Export.initiate("mtg_1"));

    expect(seen[0].headers["x-dev-user"]).toBe("usr_probe");
    expect(seen[1].headers["x-dev-user"]).toBe("usr_probe");
  });

  it("sends a credential at all on the mp3 request", async () => {
    // Stated separately from the comparison above, because "both send nothing"
    // would satisfy that one. A request with no credential is a 401, which is
    // not the reported symptom -- but it is the failure this endpoint would
    // have if `prepareHeaders` were ever skipped.
    await store().dispatch(api.endpoints.getMp3Export.initiate("mtg_1"));

    expect(Object.keys(seen[0].headers)).toContain("x-dev-user");
  });

  it("hits the same origin in both", async () => {
    await fetchExportFile("mtg_1", "txt", {}, 0);
    await store().dispatch(api.endpoints.getMp3Export.initiate("mtg_1"));

    const origin = (url: string) => new URL(url).origin;
    expect(origin(seen[1].url)).toBe(origin(seen[0].url));
  });

  it("builds no double slash in either path", async () => {
    // The two paths are assembled differently — a template literal here, RTK
    // Query's `joinUrls` there — so a base URL with a trailing slash would
    // break them in different ways.
    await fetchExportFile("mtg_1", "txt", {}, 0);
    await store().dispatch(api.endpoints.getMp3Export.initiate("mtg_1"));

    for (const request of seen) {
      expect(request.url.replace("://", ""), request.url).not.toContain("//");
    }
  });

  it("polls the mp3 endpoint rather than answering from cache", async () => {
    // The endpoint's answer changes from `preparing` to `ready` while the
    // arguments stay the same, so a cached response would be a dialog that
    // waits forever.
    const s = store();
    await s.dispatch(api.endpoints.getMp3Export.initiate("mtg_1"));
    await s.dispatch(api.endpoints.getMp3Export.initiate("mtg_1", { forceRefetch: true }));

    expect(seen).toHaveLength(2);
  });
});

describe("the request the signed download makes", () => {
  it("goes to object storage with no headers of its own", async () => {
    // The credential is in the URL. An Authorization header would fall outside
    // the signature and turn a simple cross-origin GET into a preflighted one,
    // which the bucket would then have to be configured to answer.
    await fetchSignedFile("https://account.r2.cloudflarestorage.com/orion/x.mp3?sig=1", "a.mp3", 0);

    expect(seen[0].url).toContain("r2.cloudflarestorage.com");
    expect(seen[0].headers).toEqual({});
  });

  it("does not send the session credential to a third party", async () => {
    // Worth asserting on its own: this is the one request in the app that goes
    // somewhere other than the API, and the session token has no business
    // being on it.
    await fetchSignedFile("https://account.r2.cloudflarestorage.com/orion/x.mp3", "a.mp3", 0);

    expect(Object.keys(seen[0].headers)).not.toContain("x-dev-user");
    expect(Object.keys(seen[0].headers)).not.toContain("authorization");
  });
});
