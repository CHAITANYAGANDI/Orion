import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import { buildAuthHeaders } from "@/lib/auth-store";
import type {
  ActionItemComment,
  ActionItemCreateRequest,
  ActionItemListQuery,
  ActionItemStatus,
  ChatConversation,
  ActionItemPatchRequest,
  ActionItemResponse,
  MomentCreateRequest,
  TranscriptMoment,
  ChatMessage,
  SpeakerRematchResult,
  SpeakerSettings,
  Insight,
  MeetingCreateRequest,
  MeetingUpdateRequest,
  PreferencesResponse,
  PreferencesUpdateRequest,
  MeetingListQuery,
  MeetingResponse,
  Page,
  Project,
  ProjectInput,
  ReprocessResponse,
  SearchFacets,
  SearchQueryArgs,
  SearchResponse,
  SemanticSearchHit,
  SegmentEdit,
  SemanticSearchRequest,
  SummaryResponse,
  SummaryTemplateResponse,
  TranscriptResponse,
  AppNotification,
  AudioDownload,
  AvailableTranslation,
  LanguageOption,
  MeetingTranslation,
  NotificationCount,
  NotificationKindOption,
  AccountClosed,
  ChatMode,
  ChatModeOption,
  PrivacyOverview,
  RetentionPolicy,
  RetentionUpdateRequest,
  UploadUrlRequest,
  UploadUrlResponse,
  UsageResponse,
  WorkspaceAskRequest,
} from "@/lib/types";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

const baseQuery = fetchBaseQuery({
  baseUrl: `${API_BASE}/api/v1`,
  prepareHeaders: async (headers) => {
    const authHeaders = await buildAuthHeaders();
    Object.entries(authHeaders).forEach(([k, v]) => headers.set(k, v));
    return headers;
  },
});

/**
 * Serialises a search, omitting anything unset.
 *
 * Every absent filter left out rather than sent empty, because the query string
 * is also the RTK Query cache key: `?q=stripe` and `?q=stripe&tag=` are the same
 * search and would otherwise be cached, and re-fetched, as two.
 */
function searchParams(args: SearchQueryArgs): string {
  const params = new URLSearchParams();
  params.set("q", args.q);
  if (args.groups?.length) params.set("groups", args.groups.join(","));
  if (args.limit != null) params.set("limit", String(args.limit));
  if (args.offset) params.set("offset", String(args.offset));
  if (args.from) params.set("from", args.from);
  if (args.to) params.set("to", args.to);
  if (args.status) params.set("status", args.status);
  if (args.type) params.set("type", args.type);
  if (args.tag) params.set("tag", args.tag);
  if (args.project) params.set("project", args.project);
  if (args.speaker) params.set("speaker", args.speaker);
  if (args.owner) params.set("owner", args.owner);
  if (args.withDecisions) params.set("withDecisions", "true");
  return params.toString();
}

export const api = createApi({
  reducerPath: "api",
  baseQuery,
  // Keep unused data briefly so navigation between pages feels instant.
  keepUnusedDataFor: 30,
  tagTypes: [
    "Meeting",
    "Meetings",
    "ActionItem",
    "ActionItems",
    "ActionItemComments",
    "Usage",
    "Preferences",
    "Chat",
    "WorkspaceChat",
    "Transcript",
    "Summary",
    "SummaryTemplates",
    "Insights",
    "Moments",
    "Conversations",
    "Search",
    "Projects",
    "Translations",
    "Notifications",
    "Privacy",
    "Speakers",
  ],
  endpoints: (builder) => ({
    // ---- Meetings ----
    getMeetings: builder.query<Page<MeetingResponse>, MeetingListQuery | void>({
      query: (q) => {
        const params = new URLSearchParams();
        const query = q || {};
        params.set("page", String(query.page ?? 0));
        params.set("size", String(query.size ?? 20));
        if (query.search) params.set("search", query.search);
        if (query.tag) params.set("tag", query.tag);
        if (query.status) params.set("status", query.status);
        if (query.from) params.set("from", query.from);
        if (query.to) params.set("to", query.to);
        // Only when it is on. `?unfiled=false` and no parameter at all are the
        // same request and would be cached, and refetched, as two.
        if (query.unfiled) params.set("unfiled", "true");
        return `/meetings?${params.toString()}`;
      },
      providesTags: (result) =>
        result
          ? [
              ...result.content.map((m) => ({
                type: "Meeting" as const,
                id: m.id,
              })),
              { type: "Meetings" as const, id: "LIST" },
            ]
          : [{ type: "Meetings" as const, id: "LIST" }],
    }),

    getMeeting: builder.query<MeetingResponse, string>({
      query: (id) => `/meetings/${id}`,
      providesTags: (_r, _e, id) => [{ type: "Meeting", id }],
    }),

    /**
     * Rename a meeting, or change its tags.
     *
     * Invalidates the list as well as the meeting: the title is what the list
     * shows, so a rename that only refreshed the detail page would leave the
     * old name behind the moment the user navigated back.
     */
    updateMeeting: builder.mutation<
      MeetingResponse,
      { id: string; body: MeetingUpdateRequest }
    >({
      query: ({ id, body }) => ({ url: `/meetings/${id}`, method: "PATCH", body }),
      invalidatesTags: (_r, _e, arg) => [
        { type: "Meeting", id: arg.id },
        { type: "Meetings", id: "LIST" },
        // A rename or a re-tag changes what this meeting matches, and the tag
        // facet is read from the same column.
        { type: "Search", id: "RESULTS" },
        { type: "Search", id: "FACETS" },
      ],
    }),

    /**
     * Starter questions for the workspace chat.
     *
     * Cached server-side per user and regenerated when a meeting arrives or a
     * few hours pass, so this is a cheap read even though a miss costs a model
     * call. Untagged deliberately: nothing in the app should invalidate it, and
     * a refetch on every mutation would defeat the cache it is fronting.
     */
    /**
     * Starter questions for the workspace chat.
     *
     * <p>Takes the meetings the composer has been narrowed to, so the chips
     * follow Add context instead of sitting there describing the whole archive
     * after somebody has just picked three calls out of it. Undefined means the
     * whole workspace, and produces the same request URL it always did — so the
     * cached, unscoped set stays one cache entry rather than fragmenting.
     */
    getWorkspaceSuggestions: builder.query<{ suggestions: string[] }, string[] | void>({
      query: (meetingIds) => {
        const ids = Array.isArray(meetingIds) ? meetingIds : [];
        if (ids.length === 0) return "/suggestions/workspace";
        const params = new URLSearchParams();
        for (const id of ids) params.append("meetingIds", id);
        return `/suggestions/workspace?${params.toString()}`;
      },
    }),

    // ---- Decisions and risks ----
    // One list for both kinds: they differ by a field, and two requests could
    // arrive out of step and render a meeting whose decisions and risks came
    // from different moments.
    getInsights: builder.query<Insight[], string>({
      query: (meetingId) => `/meetings/${meetingId}/insights`,
      providesTags: (_r, _e, id) => [{ type: "Insights", id }],
    }),

    addInsight: builder.mutation<
      Insight,
      { meetingId: string; kind: Insight["kind"]; text: string }
    >({
      query: ({ meetingId, ...body }) => ({
        url: `/meetings/${meetingId}/insights`,
        method: "POST",
        body,
      }),
      invalidatesTags: (_r, _e, arg) => [{ type: "Insights", id: arg.meetingId }],
    }),

    updateInsight: builder.mutation<
      Insight,
      { id: string; meetingId: string; text: string }
    >({
      query: ({ id, text }) => ({ url: `/insights/${id}`, method: "PATCH", body: { text } }),
      invalidatesTags: (_r, _e, arg) => [{ type: "Insights", id: arg.meetingId }],
    }),

    deleteInsight: builder.mutation<void, { id: string; meetingId: string }>({
      query: ({ id }) => ({ url: `/insights/${id}`, method: "DELETE" }),
      invalidatesTags: (_r, _e, arg) => [{ type: "Insights", id: arg.meetingId }],
    }),

    createUploadUrl: builder.mutation<UploadUrlResponse, UploadUrlRequest>({
      query: (body) => ({ url: "/meetings/upload-url", method: "POST", body }),
    }),

    createMeeting: builder.mutation<MeetingResponse, MeetingCreateRequest>({
      query: (body) => ({ url: "/meetings", method: "POST", body }),
      invalidatesTags: [
        { type: "Meetings", id: "LIST" },
        { type: "Usage", id: "ME" },
      ],
    }),

    getPreferences: builder.query<PreferencesResponse, void>({
      query: () => "/preferences",
      providesTags: [{ type: "Preferences", id: "ME" }],
    }),

    updatePreferences: builder.mutation<PreferencesResponse, PreferencesUpdateRequest>({
      query: (body) => ({ url: "/preferences", method: "PATCH", body }),
      invalidatesTags: [{ type: "Preferences", id: "ME" }],
    }),

    getTranscript: builder.query<TranscriptResponse, string>({
      query: (id) => `/meetings/${id}/transcript`,
      providesTags: (_r, _e, id) => [{ type: "Transcript", id }],
    }),

    getSummary: builder.query<SummaryResponse, string>({
      query: (id) => `/meetings/${id}/summary`,
      providesTags: (_r, _e, id) => [{ type: "Summary", id }],
    }),

    // ---- Summary templates ----
    getSummaryTemplates: builder.query<SummaryTemplateResponse[], void>({
      query: () => "/summary-templates",
      providesTags: [{ type: "SummaryTemplates", id: "LIST" }],
      // The set changes only when the ai-service is redeployed, so re-fetching
      // it on every meeting page is pure waste.
      keepUnusedDataFor: 3600,
    }),

    /**
     * Rewrite a meeting's summary under a different template. Only the summary
     * is invalidated: the transcript is reused and the extractions are left
     * alone, so nothing else on the page changes.
     */
    resummarize: builder.mutation<SummaryResponse, { id: string; template: string }>({
      query: ({ id, template }) => ({
        url: `/meetings/${id}/summary`,
        method: "POST",
        body: { template },
      }),
      invalidatesTags: (_r, _e, arg) => [
        { type: "Summary", id: arg.id },
        { type: "Meeting", id: arg.id },
      ],
    }),

    getMeetingActionItems: builder.query<ActionItemResponse[], string>({
      query: (id) => `/meetings/${id}/action-items`,
      providesTags: [{ type: "ActionItems", id: "LIST" }],
    }),

    /**
     * Record a commitment the extraction pass missed.
     *
     * Invalidates the whole list, not just this meeting's: the action-items page
     * is the one that answers "what did we promise", and an item added from a
     * transcript that never showed up there would be worse than not adding it.
     */
    createActionItem: builder.mutation<
      ActionItemResponse,
      { meetingId: string; body: ActionItemCreateRequest }
    >({
      query: ({ meetingId, body }) => ({
        url: `/meetings/${meetingId}/action-items`,
        method: "POST",
        body,
      }),
      invalidatesTags: [{ type: "ActionItems", id: "LIST" }],
    }),

    /**
     * Record something nobody said out loud (V36).
     *
     * The home panel's one write. Same table and same list as a commitment
     * lifted from a transcript — "what did I promise" is one question.
     */
    createStandaloneActionItem: builder.mutation<
      ActionItemResponse,
      ActionItemCreateRequest
    >({
      query: (body) => ({ url: "/action-items", method: "POST", body }),
      invalidatesTags: [
        { type: "ActionItems", id: "LIST" },
        { type: "Privacy", id: "ME" },
      ],
    }),

    // ---- Chat modes ----

    getChatModes: builder.query<ChatModeOption[], void>({
      query: () => "/chat/modes",
      // Changes when the code does, so there is nothing to revalidate.
      keepUnusedDataFor: 3600,
    }),

    // ---- Transcript moments ----
    // Highlights, bookmarks and notes in one list: they are drawn over the same
    // transcript in one pass, and three requests could paint a page whose
    // highlights and notes came from different moments.
    getMoments: builder.query<TranscriptMoment[], string>({
      query: (meetingId) => `/meetings/${meetingId}/moments`,
      providesTags: (_r, _e, id) => [{ type: "Moments", id }],
    }),

    createMoment: builder.mutation<
      TranscriptMoment,
      { meetingId: string; body: MomentCreateRequest }
    >({
      query: ({ meetingId, body }) => ({
        url: `/meetings/${meetingId}/moments`,
        method: "POST",
        body,
      }),
      invalidatesTags: (_r, _e, arg) => [{ type: "Moments", id: arg.meetingId }],
    }),

    /** Edits the body only — a note's text, or a bookmark's label. */
    updateMoment: builder.mutation<
      TranscriptMoment,
      { id: string; meetingId: string; body: string }
    >({
      query: ({ id, body }) => ({ url: `/moments/${id}`, method: "PATCH", body: { body } }),
      invalidatesTags: (_r, _e, arg) => [{ type: "Moments", id: arg.meetingId }],
    }),

    deleteMoment: builder.mutation<void, { id: string; meetingId: string }>({
      query: ({ id }) => ({ url: `/moments/${id}`, method: "DELETE" }),
      invalidatesTags: (_r, _e, arg) => [{ type: "Moments", id: arg.meetingId }],
    }),

    /**
     * Run the whole pipeline again over the same audio.
     *
     * Invalidates everything derived from the recording, not just the meeting
     * row. The server answers 202 and queues a job, so nothing here is correct
     * yet — but everything on screen is about to be replaced, and a transcript
     * left cached while it is being rewritten reads as current when it is not.
     *
     * `Chat` and `Insights` are included because they are downstream of text
     * that no longer exists: the retrieval passages are rebuilt from the new
     * segments, so answers grounded in the old ones cite lines that are gone.
     */
    reprocessMeeting: builder.mutation<ReprocessResponse, string>({
      query: (id) => ({ url: `/meetings/${id}/reprocess`, method: "POST" }),
      invalidatesTags: (_r, _e, id) => [
        { type: "Meeting", id },
        { type: "Meetings", id: "LIST" },
        { type: "Transcript", id },
        { type: "Summary", id },
        { type: "Insights", id },
        { type: "Moments", id },
        { type: "Chat", id },
        { type: "Translations", id },
      ],
    }),

    /**
     * Say what language a meeting is in, and transcribe it again.
     *
     * Invalidates the transcript and the summary as well as the meeting: this
     * queues a job that replaces both, and leaving the old ones cached would
     * show a transcript that is being rewritten as though it were current.
     */
    setMeetingLanguage: builder.mutation<
      ReprocessResponse,
      { id: string; language: string }
    >({
      query: ({ id, language }) => ({
        url: `/meetings/${id}/language`,
        method: "POST",
        body: { language },
      }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: "Meeting", id },
        { type: "Meetings", id: "LIST" },
        { type: "Transcript", id },
        { type: "Summary", id },
      ],
    }),

    // ---- RAG chat ----
    // `conversationId` is part of the query *argument*, so RTK Query caches each
    // thread separately on its own — without it, switching threads would serve
    // the previous one's messages from cache before replacing them, which reads
    // as the app losing the history.
    //
    // The invalidation tag is deliberately coarser than the cache key: one tag
    // per scope, so a mutation refreshes every thread cached for that chat. A
    // per-thread tag would be exact right up until deleting the last exchange
    // deletes the thread, at which point the open view has no tag left to
    // invalidate and stays on screen showing messages that no longer exist.
    getChat: builder.query<ChatMessage[], { id: string; conversationId?: string }>({
      query: ({ id, conversationId }) =>
        `/meetings/${id}/chat${conversationId ? `?conversationId=${conversationId}` : ""}`,
      providesTags: (_r, _e, arg) => [{ type: "Chat", id: arg.id }],
    }),

    askChat: builder.mutation<
      ChatMessage,
      { id: string; question: string; conversationId?: string; mode?: ChatMode }
    >({
      query: ({ id, question, conversationId, mode }) => ({
        url: `/meetings/${id}/chat`,
        method: "POST",
        // `mode` is Quick or Thorough, the same choice the workspace chat
        // offers. It goes over the wire as `express`/`advanced`, which is what
        // the ai-service speaks. Omitted means Quick on the server, so nothing has to be
        // sent by a caller that does not offer the picker.
        body: { question, conversationId, mode },
      }),
      // The thread list too: a first question names its thread, and an unnamed
      // row left in the picker is the one the user is looking at.
      invalidatesTags: (_r, _e, arg) => [
        { type: "Chat", id: arg.id },
        { type: "Conversations", id: arg.id },
      ],
    }),

    // ---- Chat conversations (history) ----
    getMeetingConversations: builder.query<ChatConversation[], string>({
      query: (id) => `/meetings/${id}/chat/conversations`,
      providesTags: (_r, _e, id) => [{ type: "Conversations", id }],
    }),

    createMeetingConversation: builder.mutation<ChatConversation, string>({
      query: (id) => ({ url: `/meetings/${id}/chat/conversations`, method: "POST" }),
      invalidatesTags: (_r, _e, id) => [{ type: "Conversations", id }],
    }),

    getWorkspaceConversations: builder.query<ChatConversation[], void>({
      query: () => "/chat/conversations",
      providesTags: [{ type: "Conversations", id: "ME" }],
    }),

    createWorkspaceConversation: builder.mutation<ChatConversation, void>({
      query: () => ({ url: "/chat/conversations", method: "POST" }),
      invalidatesTags: [{ type: "Conversations", id: "ME" }],
    }),

    // Renaming and deleting need no scope: a conversation id already says which
    // chat it belongs to. `scope` is carried only to invalidate the right list.
    renameConversation: builder.mutation<
      ChatConversation,
      { conversationId: string; title: string; scope: string }
    >({
      query: ({ conversationId, title }) => ({
        url: `/chat/conversations/${conversationId}`,
        method: "PATCH",
        body: { title },
      }),
      invalidatesTags: (_r, _e, arg) => [{ type: "Conversations", id: arg.scope }],
    }),

    deleteConversation: builder.mutation<void, { conversationId: string; scope: string }>({
      query: ({ conversationId }) => ({
        url: `/chat/conversations/${conversationId}`,
        method: "DELETE",
      }),
      invalidatesTags: (_r, _e, arg) => [{ type: "Conversations", id: arg.scope }],
    }),

    /**
     * Remove one exchange — the message named and the turn that answers it.
     *
     * Returns `conversationDeleted`, which the caller must act on: deleting the
     * last exchange deletes the thread, and a page still holding that thread's
     * id will 404 on every request it makes afterwards.
     *
     * `scope` is the meeting id, or "ME" for the workspace. Both chats' tags are
     * invalidated rather than the one the caller claims: a message id does not
     * say which chat it came from without a round-trip, and refetching a chat
     * the user is not looking at costs one cached request.
     */
    deleteChatExchange: builder.mutation<
      { deletedMessages: number; conversationDeleted: boolean },
      { messageId: string; scope: string }
    >({
      query: ({ messageId }) => ({ url: `/chat/messages/${messageId}`, method: "DELETE" }),
      invalidatesTags: (_r, _e, arg) => [
        { type: "Chat", id: arg.scope },
        { type: "Conversations", id: arg.scope },
        { type: "WorkspaceChat", id: "ME" },
      ],
    }),

    // ---- Workspace-wide chat (grounded across every meeting) ----
    getWorkspaceChat: builder.query<ChatMessage[], { conversationId?: string } | void>({
      query: (arg) =>
        arg && arg.conversationId ? `/chat?conversationId=${arg.conversationId}` : "/chat",
      providesTags: [{ type: "WorkspaceChat", id: "ME" }],
    }),

    askWorkspaceChat: builder.mutation<ChatMessage, WorkspaceAskRequest>({
      query: (body) => ({ url: "/chat", method: "POST", body }),
      invalidatesTags: [
        { type: "WorkspaceChat", id: "ME" },
        { type: "Conversations", id: "ME" },
      ],
    }),

    clearWorkspaceChat: builder.mutation<void, void>({
      query: () => ({ url: "/chat", method: "DELETE" }),
      invalidatesTags: [
        { type: "WorkspaceChat", id: "ME" },
        { type: "Conversations", id: "ME" },
      ],
    }),

    clearMeetingChat: builder.mutation<void, string>({
      query: (id) => ({ url: `/meetings/${id}/chat`, method: "DELETE" }),
      invalidatesTags: (_r, _e, id) => [
        { type: "Chat", id },
        { type: "Conversations", id },
      ],
    }),

    // ---- Semantic search (find meetings by what was said) ----
    semanticSearch: builder.mutation<SemanticSearchHit[], SemanticSearchRequest>({
      query: (body) => ({ url: "/search/semantic", method: "POST", body }),
    }),

    // ---- Projects ----
    getProjects: builder.query<Project[], void>({
      query: () => "/projects",
      providesTags: [{ type: "Projects" as const, id: "LIST" }],
    }),

    getProject: builder.query<Project, string>({
      query: (id) => `/projects/${id}`,
      providesTags: (_r, _e, id) => [{ type: "Projects" as const, id }],
    }),

    getProjectMeetings: builder.query<MeetingResponse[], string>({
      query: (id) => `/projects/${id}/meetings`,
      providesTags: (_r, _e, id) => [{ type: "Projects" as const, id: `MEETINGS-${id}` }],
    }),

    /** Everything filed nowhere — shown at the bottom of the tree, not hidden. */
    getUnfiledMeetings: builder.query<MeetingResponse[], void>({
      query: () => "/projects/unfiled",
      providesTags: [{ type: "Projects" as const, id: "UNFILED" }],
    }),

    createProject: builder.mutation<Project, ProjectInput>({
      query: (body) => ({ url: "/projects", method: "POST", body }),
      invalidatesTags: [{ type: "Projects", id: "LIST" }],
    }),

    updateProject: builder.mutation<Project, { id: string; body: ProjectInput }>({
      query: ({ id, body }) => ({ url: `/projects/${id}`, method: "PATCH", body }),
      invalidatesTags: (_r, _e, arg) => [
        { type: "Projects", id: "LIST" },
        { type: "Projects", id: arg.id },
      ],
    }),

    /** Deletes the project; its meetings are unfiled, not deleted. */
    deleteProject: builder.mutation<{ unfiledMeetings: number }, string>({
      query: (id) => ({ url: `/projects/${id}`, method: "DELETE" }),
      invalidatesTags: [
        { type: "Projects", id: "LIST" },
        { type: "Projects", id: "UNFILED" },
        { type: "Meetings", id: "LIST" },
        { type: "Search", id: "RESULTS" },
      ],
    }),

    /**
     * File a meeting, or send a null project to unfile it.
     *
     * Invalidates broadly on purpose: a meeting moving changes two projects'
     * counts, both their lists, the unfiled list, and what the search filter
     * returns. Working out which two would save one request and cost the
     * correctness of five views.
     */
    assignProject: builder.mutation<
      MeetingResponse,
      { meetingId: string; projectId: string | null }
    >({
      query: ({ meetingId, projectId }) => ({
        url: `/projects/meetings/${meetingId}`,
        method: "PUT",
        body: { projectId },
      }),
      invalidatesTags: (_r, _e, arg) => [
        { type: "Meeting", id: arg.meetingId },
        { type: "Meetings", id: "LIST" },
        { type: "Projects", id: "LIST" },
        { type: "Projects", id: "UNFILED" },
        { type: "Search", id: "RESULTS" },
      ],
    }),

    // ---- Project chat ----
    getProjectChat: builder.query<
      ChatMessage[],
      { id: string; conversationId?: string }
    >({
      query: ({ id, conversationId }) =>
        `/projects/${id}/chat${conversationId ? `?conversationId=${conversationId}` : ""}`,
      providesTags: (_r, _e, arg) => [{ type: "Chat", id: `PRJ-${arg.id}` }],
    }),

    askProjectChat: builder.mutation<
      ChatMessage,
      { id: string; question: string; conversationId?: string }
    >({
      query: ({ id, question, conversationId }) => ({
        url: `/projects/${id}/chat`,
        method: "POST",
        body: { question, conversationId },
      }),
      invalidatesTags: (_r, _e, arg) => [
        { type: "Chat", id: `PRJ-${arg.id}` },
        { type: "Conversations", id: `PRJ-${arg.id}` },
      ],
    }),

    getProjectConversations: builder.query<ChatConversation[], string>({
      query: (id) => `/projects/${id}/chat/conversations`,
      providesTags: (_r, _e, id) => [{ type: "Conversations", id: `PRJ-${id}` }],
    }),

    createProjectConversation: builder.mutation<ChatConversation, string>({
      query: (id) => ({ url: `/projects/${id}/chat/conversations`, method: "POST" }),
      invalidatesTags: (_r, _e, id) => [{ type: "Conversations", id: `PRJ-${id}` }],
    }),

    clearProjectChat: builder.mutation<void, string>({
      query: (id) => ({ url: `/projects/${id}/chat`, method: "DELETE" }),
      invalidatesTags: (_r, _e, id) => [
        { type: "Chat", id: `PRJ-${id}` },
        { type: "Conversations", id: `PRJ-${id}` },
      ],
    }),

    /**
     * Workspace search: one request, every kind of result.
     *
     * A query rather than a mutation, and deliberately: it is idempotent, so
     * RTK Query dedupes the identical request that a re-render or a second
     * component would otherwise repeat, and typing back over a term you just
     * deleted answers from cache instead of the network.
     *
     * The `Search` tag is coarse — one tag, not one per query. Results are
     * assembled from meetings, insights and action items, so anything that
     * changes those can invalidate this without having to know which searches
     * are in flight.
     */
    search: builder.query<SearchResponse, SearchQueryArgs>({
      query: (args) => `/search?${searchParams(args)}`,
      providesTags: [{ type: "Search" as const, id: "RESULTS" }],
    }),

    /**
     * What the filters can be set to. Read from the user's own rows, so the
     * dropdowns offer what exists and nothing that does not.
     */
    getSearchFacets: builder.query<SearchFacets, void>({
      query: () => "/search/facets",
      providesTags: [{ type: "Search" as const, id: "FACETS" }],
    }),

    // ---- Translation ----
    /**
     * The languages Recallix works in.
     *
     * A property of the product rather than of the caller, so it is fetched
     * once and kept: `keepUnusedDataFor` is deliberately long here because this
     * list changes when the transcription model does, which is never within a
     * session.
     */
    getLanguages: builder.query<LanguageOption[], void>({
      query: () => "/languages",
      keepUnusedDataFor: 3600,
    }),

    /** Which languages this meeting already exists in. */
    getTranslations: builder.query<AvailableTranslation[], string>({
      query: (id) => `/meetings/${id}/translations`,
      providesTags: (_r, _e, id) => [{ type: "Translations", id }],
    }),

    /**
     * Translate the meeting, or refresh a translation it has outgrown.
     *
     * Safe to fire on every language switch: the server returns what it already
     * has without spending a model call, so the client does not have to track
     * what exists. `includeTranscript` is the expensive half and is asked for
     * separately — see the backend for why.
     */
    translateMeeting: builder.mutation<
      MeetingTranslation,
      { id: string; targetLanguage: string; includeTranscript?: boolean }
    >({
      query: ({ id, targetLanguage, includeTranscript }) => ({
        url: `/meetings/${id}/translations`,
        method: "POST",
        body: { targetLanguage, includeTranscript: !!includeTranscript },
      }),
      invalidatesTags: (_r, _e, arg) => [{ type: "Translations", id: arg.id }],
    }),

    // ---- Notifications ----

    /**
     * The bell's list.
     *
     * <p>One tag for the lot: every mutation here changes the badge as well as
     * the list, and a finer-grained scheme would mean each of them remembering
     * to invalidate both.
     */
    getNotifications: builder.query<Page<AppNotification>, { page?: number; size?: number; unread?: boolean } | void>({
      query: (q) => {
        const params = new URLSearchParams();
        const query = q || {};
        if (query.page != null) params.set("page", String(query.page));
        if (query.size != null) params.set("size", String(query.size));
        if (query.unread) params.set("unread", "true");
        return `/notifications?${params.toString()}`;
      },
      providesTags: [{ type: "Notifications", id: "LIST" }],
    }),

    /** The badge, and the socket channel that keeps it live. */
    getUnreadCount: builder.query<NotificationCount, void>({
      query: () => "/notifications/unread-count",
      providesTags: [{ type: "Notifications", id: "COUNT" }],
    }),

    /** What can be switched off. Served, so the client keeps no copy of the enum. */
    getNotificationKinds: builder.query<NotificationKindOption[], void>({
      query: () => "/notifications/kinds",
      keepUnusedDataFor: 3600,
    }),

    markNotificationRead: builder.mutation<AppNotification, { id: string; read: boolean }>({
      query: ({ id, read }) => ({
        url: `/notifications/${id}/${read ? "read" : "unread"}`,
        method: "POST",
      }),
      invalidatesTags: [{ type: "Notifications", id: "LIST" }, { type: "Notifications", id: "COUNT" }],
    }),

    markAllNotificationsRead: builder.mutation<NotificationCount, void>({
      query: () => ({ url: "/notifications/read-all", method: "POST" }),
      invalidatesTags: [{ type: "Notifications", id: "LIST" }, { type: "Notifications", id: "COUNT" }],
    }),

    deleteNotification: builder.mutation<void, string>({
      query: (id) => ({ url: `/notifications/${id}`, method: "DELETE" }),
      invalidatesTags: [{ type: "Notifications", id: "LIST" }, { type: "Notifications", id: "COUNT" }],
    }),

    clearNotifications: builder.mutation<void, void>({
      query: () => ({ url: "/notifications", method: "DELETE" }),
      invalidatesTags: [{ type: "Notifications", id: "LIST" }, { type: "Notifications", id: "COUNT" }],
    }),

    /**
     * A short-lived link to the original recording.
     *
     * Asked for on click rather than loaded with the meeting, because the link
     * is signed and expires: one fetched when the page opened would be dead by
     * the time somebody left the tab overnight and came back to it.
     */
    getAudioDownload: builder.query<AudioDownload, string>({
      query: (id) => `/meetings/${id}/audio`,
      keepUnusedDataFor: 60,
    }),

    /**
     * Correct what the transcriber heard. Invalidates the transcript and the
     * meeting's chat: saving re-indexes the meeting, so previous answers were
     * grounded in text that no longer exists.
     */
    editSegments: builder.mutation<
      TranscriptResponse,
      { id: string; edits: SegmentEdit[] }
    >({
      query: ({ id, edits }) => ({
        url: `/meetings/${id}/segments`,
        method: "PATCH",
        body: { edits },
      }),
      invalidatesTags: (_r, _e, arg) => [
        { type: "Transcript", id: arg.id },
        { type: "Chat", id: arg.id },
      ],
    }),

    /**
     * Move one turn, or part of one, to a different speaker.
     *
     * Invalidates the same two tags as a text edit and for the same reason: the
     * server re-indexes, so any chat answer already on screen was grounded in a
     * transcript that attributed these words to somebody else.
     *
     * `fromWord`/`toWord` are optional and omitted for a whole turn. When they
     * are sent the server splits the segment, so the response is the whole
     * transcript rather than one line -- there is no way to patch the cache
     * locally without reimplementing the split.
     */
    setSegmentSpeaker: builder.mutation<
      TranscriptResponse,
      {
        id: string;
        segmentId: string;
        speakerKey: string;
        fromWord?: number;
        toWord?: number;
      }
    >({
      query: ({ id, segmentId, speakerKey, fromWord, toWord }) => ({
        url: `/meetings/${id}/segments/${segmentId}/speaker`,
        method: "PATCH",
        body: { speakerKey, fromWord, toWord },
      }),
      invalidatesTags: (_r, _e, arg) => [
        { type: "Transcript", id: arg.id },
        { type: "Chat", id: arg.id },
      ],
    }),

    // ---- Speaker rename ----
    renameSpeakers: builder.mutation<
      TranscriptResponse,
      { id: string; mapping: Record<string, string> }
    >({
      query: ({ id, mapping }) => ({
        url: `/meetings/${id}/speakers`,
        method: "PATCH",
        body: { mapping },
      }),
      invalidatesTags: (_r, _e, arg) => [{ type: "Transcript", id: arg.id }],
    }),

    /**
     * Rematch speakers: identify the unresolved ones against known voices.
     *
     * One call, no body. Every speaker still labelled "Speaker N" is compared
     * acoustically against the voice profiles this account has built by naming
     * people in other meetings. Nobody who has already been named is touched,
     * and a weak or ambiguous match renames nobody.
     *
     * Invalidates the transcript and the chat because a successful rematch
     * rewrites both the labels and the retrieval passages behind them — chat
     * would otherwise keep citing a name the transcript no longer shows.
     * Invalidated even when nothing matched, which costs one refetch and closes
     * the case where two tabs are open on the same meeting.
     */
    rematchSpeakers: builder.mutation<SpeakerRematchResult, string>({
      query: (id) => ({
        url: `/meetings/${id}/speakers/rematch`,
        method: "POST",
      }),
      invalidatesTags: (_r, _e, id) => [
        { type: "Transcript", id },
        { type: "Chat", id },
      ],
    }),

    // ---- Voice profiles ----
    // The consent switch and the list of voices held under it. Separate from
    // /preferences on purpose: switching this off *deletes* every voice
    // template the account holds, and that must not be reachable from a
    // null-means-unchanged bulk patch that the settings page sends whenever
    // anything on it moves.
    getSpeakerSettings: builder.query<SpeakerSettings, void>({
      query: () => "/speakers",
      providesTags: ["Speakers"],
    }),

    setSpeakerLearning: builder.mutation<SpeakerSettings, boolean>({
      query: (enabled) => ({
        url: "/speakers/learning",
        method: "PUT",
        body: { enabled },
      }),
      invalidatesTags: ["Speakers"],
    }),

    deleteSpeakerProfile: builder.mutation<void, string>({
      query: (id) => ({ url: `/speakers/profiles/${id}`, method: "DELETE" }),
      invalidatesTags: ["Speakers"],
    }),

    deleteMeeting: builder.mutation<void, string>({
      query: (id) => ({ url: `/meetings/${id}`, method: "DELETE" }),
      invalidatesTags: [
        { type: "Meetings", id: "LIST" },
        { type: "Usage", id: "ME" },
        // Its decisions, commitments and utterances went with it; leaving them
        // in a cached result list means clicking through to a 404.
        { type: "Search", id: "RESULTS" },
        { type: "Search", id: "FACETS" },
        { type: "Privacy", id: "ME" },
      ],
    }),

    // ---- Privacy & data (V35) ----

    /**
     * Erase the recording, keep everything drawn from it.
     *
     * Invalidates the transcript and summary too, even though neither changed:
     * a link that offered the audio was narrowed by the same call, and the
     * meeting page reads all three.
     */
    eraseAudio: builder.mutation<{ audioDeletedAt: string }, string>({
      query: (id) => ({ url: `/meetings/${id}/audio`, method: "DELETE" }),
      invalidatesTags: (_r, _e, id) => [
        { type: "Meeting", id },
        { type: "Meetings", id: "LIST" },
        { type: "Privacy", id: "ME" },
      ],
    }),

    /** Erase the transcript, its marks, its translations and its embeddings. */
    eraseTranscript: builder.mutation<{ transcriptDeletedAt: string }, string>({
      query: (id) => ({ url: `/meetings/${id}/transcript`, method: "DELETE" }),
      invalidatesTags: (_r, _e, id) => [
        { type: "Meeting", id },
        { type: "Transcript", id },
        { type: "Moments", id },
        { type: "Translations", id },
        // Chat answered out of those embeddings a moment ago and cannot any
        // more; a cached answer citing text that is gone is the worst of both.
        { type: "Chat", id },
        { type: "Search", id: "RESULTS" },
        { type: "Privacy", id: "ME" },
      ],
    }),

    getPrivacyOverview: builder.query<PrivacyOverview, void>({
      query: () => "/privacy",
      providesTags: [{ type: "Privacy", id: "ME" }],
    }),

    updateRetention: builder.mutation<RetentionPolicy, RetentionUpdateRequest>({
      query: (body) => ({ url: "/privacy/retention", method: "PATCH", body }),
      invalidatesTags: [{ type: "Privacy", id: "ME" }],
    }),

    /**
     * Close the account. Immediate and irreversible.
     *
     * Invalidates nothing, on purpose: there is no cache left to correct, and
     * the caller is about to leave the app entirely.
     */
    closeAccount: builder.mutation<AccountClosed, { confirm: string }>({
      query: (body) => ({ url: "/privacy/account", method: "DELETE", body }),
    }),

    // ---- Action items ----
    getActionItems: builder.query<
      Page<ActionItemResponse>,
      ActionItemListQuery | void
    >({
      query: (q) => {
        const params = new URLSearchParams();
        const query = q || {};
        params.set("page", String(query.page ?? 0));
        params.set("size", String(query.size ?? 50));
        if (query.status) params.set("status", query.status);
        if (query.owner) params.set("owner", query.owner);
        if (query.due) params.set("due", query.due);
        if (query.meetingId) params.set("meetingId", query.meetingId);
        // Only what nobody's transcript produced. Not `meetingId` with a magic
        // value — that filter names one meeting, and there is no id for "none".
        if (query.standalone) params.set("standalone", "true");
        if (query.mine) params.set("mine", "true");
        return `/action-items?${params.toString()}`;
      },
      providesTags: (result) =>
        result
          ? [
              ...result.content.map((a) => ({
                type: "ActionItem" as const,
                id: a.id,
              })),
              { type: "ActionItems" as const, id: "LIST" },
            ]
          : [{ type: "ActionItems" as const, id: "LIST" }],
    }),

    /* No `overview` and no bulk `PATCH` here any more. Both existed for the
       tracker page's filter tabs and its select-many toolbar, and both left
       with it. The endpoints are still on the server; nothing in the app calls
       them. */

    patchActionItem: builder.mutation<
      ActionItemResponse,
      { id: string; body: ActionItemPatchRequest }
    >({
      query: ({ id, body }) => ({
        url: `/action-items/${id}`,
        method: "PATCH",
        body,
      }),
      invalidatesTags: (_r, _e, arg) => [
        { type: "ActionItem", id: arg.id },
        { type: "ActionItems", id: "LIST" },
      ],
    }),

    deleteActionItem: builder.mutation<void, string>({
      query: (id) => ({ url: `/action-items/${id}`, method: "DELETE" }),
      invalidatesTags: [{ type: "ActionItems", id: "LIST" }],
    }),

    // ---- Action item comments ----
    // Fetched per item and only when one is opened: a list of fifty tasks would
    // otherwise be fifty requests for logs nobody is reading.
    getActionItemComments: builder.query<ActionItemComment[], string>({
      query: (id) => `/action-items/${id}/comments`,
      providesTags: (_r, _e, id) => [{ type: "ActionItemComments", id }],
    }),

    addActionItemComment: builder.mutation<
      ActionItemComment,
      { id: string; body: string }
    >({
      query: ({ id, body }) => ({
        url: `/action-items/${id}/comments`,
        method: "POST",
        body: { body },
      }),
      // The row shows a comment count, so the item list is stale too.
      invalidatesTags: (_r, _e, arg) => [
        { type: "ActionItemComments", id: arg.id },
        { type: "ActionItems", id: "LIST" },
      ],
    }),

    deleteActionItemComment: builder.mutation<
      void,
      { id: string; commentId: string }
    >({
      query: ({ id, commentId }) => ({
        url: `/action-items/${id}/comments/${commentId}`,
        method: "DELETE",
      }),
      invalidatesTags: (_r, _e, arg) => [
        { type: "ActionItemComments", id: arg.id },
        { type: "ActionItems", id: "LIST" },
      ],
    }),

    // ---- Sharing ----
    // ---- Usage ----

    getUsage: builder.query<UsageResponse, void>({
      query: () => "/usage",
      providesTags: [{ type: "Usage", id: "ME" }],
    }),

  }),
});

export const {
  useGetMeetingsQuery,
  useGetMeetingQuery,
  useCreateUploadUrlMutation,
  useCreateMeetingMutation,
  useUpdateMeetingMutation,
  useGetWorkspaceSuggestionsQuery,
  useGetInsightsQuery,
  useAddInsightMutation,
  useUpdateInsightMutation,
  useDeleteInsightMutation,
  useGetPreferencesQuery,
  useUpdatePreferencesMutation,
  useGetTranscriptQuery,
  useGetSummaryQuery,
  useGetSummaryTemplatesQuery,
  useResummarizeMutation,
  useGetMeetingActionItemsQuery,
  useCreateActionItemMutation,
  useCreateStandaloneActionItemMutation,
  useGetChatModesQuery,
  useGetMomentsQuery,
  useCreateMomentMutation,
  useUpdateMomentMutation,
  useDeleteMomentMutation,
  useReprocessMeetingMutation,
  useSetMeetingLanguageMutation,
  useDeleteMeetingMutation,
  useGetChatQuery,
  useAskChatMutation,
  useClearMeetingChatMutation,
  useGetWorkspaceChatQuery,
  useAskWorkspaceChatMutation,
  useClearWorkspaceChatMutation,
  useGetMeetingConversationsQuery,
  useCreateMeetingConversationMutation,
  useGetWorkspaceConversationsQuery,
  useCreateWorkspaceConversationMutation,
  useRenameConversationMutation,
  useDeleteConversationMutation,
  useDeleteChatExchangeMutation,
  useSemanticSearchMutation,
  useSearchQuery,
  useGetSearchFacetsQuery,
  useGetProjectsQuery,
  useGetProjectQuery,
  useGetProjectMeetingsQuery,
  useGetUnfiledMeetingsQuery,
  useCreateProjectMutation,
  useUpdateProjectMutation,
  useDeleteProjectMutation,
  useAssignProjectMutation,
  useGetProjectChatQuery,
  useAskProjectChatMutation,
  useGetProjectConversationsQuery,
  useCreateProjectConversationMutation,
  useClearProjectChatMutation,
  useGetLanguagesQuery,
  useGetTranslationsQuery,
  useTranslateMeetingMutation,
  useLazyGetAudioDownloadQuery,
  useGetNotificationsQuery,
  useGetUnreadCountQuery,
  useGetNotificationKindsQuery,
  useMarkNotificationReadMutation,
  useMarkAllNotificationsReadMutation,
  useDeleteNotificationMutation,
  useClearNotificationsMutation,
  useEraseAudioMutation,
  useEraseTranscriptMutation,
  useGetPrivacyOverviewQuery,
  useUpdateRetentionMutation,
  useCloseAccountMutation,
  useRenameSpeakersMutation,
  useRematchSpeakersMutation,
  useGetSpeakerSettingsQuery,
  useSetSpeakerLearningMutation,
  useDeleteSpeakerProfileMutation,
  useEditSegmentsMutation,
  useSetSegmentSpeakerMutation,
  useGetActionItemsQuery,
  usePatchActionItemMutation,
  useDeleteActionItemMutation,
  useGetActionItemCommentsQuery,
  useAddActionItemCommentMutation,
  useDeleteActionItemCommentMutation,
  useGetUsageQuery,
} = api;
