"""Developer-only measurement harnesses.

Not imported by the application and not shipped in the runtime image — the
Dockerfile copies `app` and `scripts` only. Everything here is run by hand, by a
developer, against fixtures that are never committed.
"""
