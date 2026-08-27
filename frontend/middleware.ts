import { NextResponse, type NextRequest } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Nobody reaches the app without being somebody.
 *
 * ## Why this exists at all
 *
 * The Clerk integration was complete on both sides — the backend validated
 * tokens against the JWKS, the browser attached them, and row-level security
 * scoped every read to the owner — and none of that stopped an unauthenticated
 * visitor loading `/home`. It stopped them *reading* anything: every API call
 * came back 401. So the app rendered in full, with an empty sidebar, an empty
 * list and errors behind each panel, which reads as a broken product rather
 * than as a locked door.
 *
 * The gate has to be in front of the page, not behind the data.
 *
 * ## Why middleware rather than a check in the layout
 *
 * A client-side redirect runs after the shell has mounted, so there is a frame
 * of the application on screen before it disappears. That frame is the thing
 * this is for. Middleware answers before anything is sent.
 *
 * ## Why it is conditional
 *
 * `clerkMiddleware` needs `CLERK_SECRET_KEY` and throws without it. Dev mode
 * exists so the whole stack runs with no keys at all, and a middleware that
 * crashed every request in that mode would make the dev story a lie. So the
 * mode is read here, and dev passes straight through.
 *
 * That is a switch with an authentication bypass on one side of it, so it fails
 * closed: anything other than the exact string `dev` — unset, misspelt, empty —
 * is treated as clerk. The same default is applied in lib/auth-store.ts and in
 * AuthenticationFilter, so no single missing variable can quietly open the
 * door.
 */
const DEV_MODE = process.env.NEXT_PUBLIC_AUTH_MODE === "dev";

/**
 * Everything that is not the front door.
 *
 * <p>Written as what is *public* rather than as what is protected, so a route
 * added later is private until somebody says otherwise. The alternative gets
 * this backwards exactly once and nobody notices.
 */
const isPublic = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
]);

/*
 * `signInUrl` is given here as well as in the provider and the environment.
 * `redirectToSignIn` resolves it server-side, where the provider's props do not
 * reach — without this it sent people to Clerk's own hosted page on
 * accounts.dev, which is a different domain, a different look, and a route out
 * of the product to get back into it.
 */
const guard = DEV_MODE
  ? null
  : clerkMiddleware((auth, request) => {
      if (isPublic(request)) return;
      // `auth()` first: in Clerk 5 the handler is handed a getter, and the
      // object it returns is what carries the session.
      const { userId, redirectToSignIn } = auth();
      if (userId) return;
      /*
       * An explicit redirect, not `protect()`.
       *
       * `protect()` is written for API routes: it *rewrites* rather than
       * redirects, and on a development instance with no dev-browser cookie
       * that rewrite points at an internal `/clerk_<timestamp>` path which no
       * route serves -- so asking for /home while signed out answered 500
       * Internal Server Error. A locked door that reports a server fault is
       * worse than an open one, because it sends somebody to look for a bug.
       *
       * `returnBackUrl` is what makes a bookmarked meeting still work: sign in,
       * and you land on the page you asked for rather than at the top of the
       * app wondering where it went.
       *
       * Relative, not `request.url`. Inside the container that reads
       * `http://0.0.0.0:3000/...` — the address the server bound to rather than
       * the one the browser typed — so an absolute return URL sent people to a
       * host that only exists from inside Docker. A path has no host to get
       * wrong.
       */
      const back = request.nextUrl.pathname + request.nextUrl.search;
      return redirectToSignIn({ returnBackUrl: back });
    }, { signInUrl: "/sign-in" });

export default function middleware(
  request: NextRequest,
  event: Parameters<NonNullable<typeof guard>>[1],
) {
  if (!guard) return NextResponse.next();
  return guard(request, event);
}

export const config = {
  /*
   * Everything except Next's own assets and anything with a file extension.
   * Running on `/_next/static/*` would put a session lookup in front of every
   * chunk of the bundle, on a page whose whole job is to load before anything
   * else does.
   */
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
