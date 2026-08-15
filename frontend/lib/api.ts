import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import { buildAuthHeaders } from "@/lib/auth-store";
import type {
  ActionItemCreateRequest,
  ActionItemListQuery,
  ActionItemPatchRequest,
  ActionItemResponse,
  MomentCreateRequest,
  TranscriptMoment,
  ChatMessage,
  CheckoutRequest,
  CheckoutResponse,
  EmailDraft,
  KnownSpeaker,
  ShareCreateRequest,
  ShareResponse,
  SpeakerRematch,
  VocabularyTerm,
  VocabularyTermInput,
  Insight,
  MeetingCreateRequest,
  MeetingUpdateRequest,
  MeetingImportRequest,
  PreferencesResponse,
  PreferencesUpdateRequest,
  MeetingListQuery,
  MeetingResponse,
  Page,
  ReprocessResponse,
  SemanticSearchHit,
  SegmentEdit,
  SemanticSearchRequest,
  SummaryResponse,
  SummaryTemplateResponse,
  TranscriptResponse,
  TranslateResult,
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
    "Usage",
    "Preferences",
    "Chat",
    "WorkspaceChat",
    "Transcript",
    "Summary",
    "SummaryTemplates",
    "Share",
    "Vocabulary",
    "KnownSpeakers",
    "Insights",
    "Moments",
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
    getWorkspaceSuggestions: builder.query<{ suggestions: string[] }, void>({
      query: () => "/suggestions/workspace",
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

    /** Import from a URL (YouTube) — no upload step; the worker fetches it. */
    importMeeting: builder.mutation<MeetingResponse, MeetingImportRequest>({
      query: (body) => ({ url: "/meetings/import", method: "POST", body }),
      invalidatesTags: [
        { type: "Meetings", id: "LIST" },
        { type: "Usage", id: "ME" },
      ],
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

    reprocessMeeting: builder.mutation<ReprocessResponse, string>({
      query: (id) => ({ url: `/meetings/${id}/reprocess`, method: "POST" }),
      invalidatesTags: (_r, _e, id) => [
        { type: "Meeting", id },
        { type: "Meetings", id: "LIST" },
      ],
    }),

    // ---- RAG chat ----
    getChat: builder.query<ChatMessage[], string>({
      query: (id) => `/meetings/${id}/chat`,
      providesTags: (_r, _e, id) => [{ type: "Chat", id }],
    }),

    askChat: builder.mutation<ChatMessage, { id: string; question: string }>({
      query: ({ id, question }) => ({
        url: `/meetings/${id}/chat`,
        method: "POST",
        body: { question },
      }),
      invalidatesTags: (_r, _e, arg) => [{ type: "Chat", id: arg.id }],
    }),

    // ---- Workspace-wide chat (grounded across every meeting) ----
    getWorkspaceChat: builder.query<ChatMessage[], void>({
      query: () => "/chat",
      providesTags: [{ type: "WorkspaceChat", id: "ME" }],
    }),

    askWorkspaceChat: builder.mutation<ChatMessage, WorkspaceAskRequest>({
      query: (body) => ({ url: "/chat", method: "POST", body }),
      invalidatesTags: [{ type: "WorkspaceChat", id: "ME" }],
    }),

    clearWorkspaceChat: builder.mutation<void, void>({
      query: () => ({ url: "/chat", method: "DELETE" }),
      invalidatesTags: [{ type: "WorkspaceChat", id: "ME" }],
    }),

    // ---- Semantic search (find meetings by what was said) ----
    semanticSearch: builder.mutation<SemanticSearchHit[], SemanticSearchRequest>({
      query: (body) => ({ url: "/search/semantic", method: "POST", body }),
    }),

    // ---- Translation ----
    translateSummary: builder.mutation<
      TranslateResult,
      { id: string; targetLanguage: string }
    >({
      query: ({ id, targetLanguage }) => ({
        url: `/meetings/${id}/translate`,
        method: "POST",
        body: { targetLanguage },
      }),
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
      // KnownSpeakers too: a rename records the names for next time, so the
      // suggestion list is stale the moment this succeeds.
      invalidatesTags: (_r, _e, arg) => [
        { type: "Transcript", id: arg.id },
        { type: "KnownSpeakers", id: "LIST" },
      ],
    }),

    /**
     * Fix diarization: merge a label that was split across two speakers, or
     * move individual turns to whoever actually said them.
     *
     * Invalidates chat as well as the transcript — a rematch re-indexes the
     * meeting, so earlier answers attributed quotes to a speaker the transcript
     * no longer names.
     */
    rematchSpeaker: builder.mutation<
      TranscriptResponse,
      { id: string } & SpeakerRematch
    >({
      query: ({ id, ...body }) => ({
        url: `/meetings/${id}/speakers/rematch`,
        method: "PATCH",
        body,
      }),
      invalidatesTags: (_r, _e, arg) => [
        { type: "Transcript", id: arg.id },
        { type: "Chat", id: arg.id },
        { type: "KnownSpeakers", id: "LIST" },
      ],
    }),

    // ---- Known speakers ----
    getKnownSpeakers: builder.query<KnownSpeaker[], void>({
      query: () => ({ url: "/speakers" }),
      providesTags: [{ type: "KnownSpeakers", id: "LIST" }],
    }),

    deleteKnownSpeaker: builder.mutation<void, string>({
      query: (id) => ({ url: `/speakers/${id}`, method: "DELETE" }),
      invalidatesTags: [{ type: "KnownSpeakers", id: "LIST" }],
    }),

    // ---- Custom vocabulary ----
    getVocabulary: builder.query<VocabularyTerm[], void>({
      query: () => ({ url: "/vocabulary" }),
      providesTags: [{ type: "Vocabulary", id: "LIST" }],
    }),

    createVocabularyTerm: builder.mutation<VocabularyTerm, VocabularyTermInput>({
      query: (body) => ({ url: "/vocabulary", method: "POST", body }),
      invalidatesTags: [{ type: "Vocabulary", id: "LIST" }],
    }),

    updateVocabularyTerm: builder.mutation<
      VocabularyTerm,
      { id: string } & VocabularyTermInput
    >({
      query: ({ id, ...body }) => ({
        url: `/vocabulary/${id}`,
        method: "PUT",
        body,
      }),
      invalidatesTags: [{ type: "Vocabulary", id: "LIST" }],
    }),

    deleteVocabularyTerm: builder.mutation<void, string>({
      query: (id) => ({ url: `/vocabulary/${id}`, method: "DELETE" }),
      invalidatesTags: [{ type: "Vocabulary", id: "LIST" }],
    }),

    deleteMeeting: builder.mutation<void, string>({
      query: (id) => ({ url: `/meetings/${id}`, method: "DELETE" }),
      invalidatesTags: [
        { type: "Meetings", id: "LIST" },
        { type: "Usage", id: "ME" },
      ],
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
        if (query.priority) params.set("priority", query.priority);
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

    // ---- Sharing ----
    getShare: builder.query<ShareResponse | null, string>({
      // 204 (never shared) arrives as an empty body; normalise it to null.
      query: (id) => ({
        url: `/meetings/${id}/share`,
        responseHandler: async (r) => (r.status === 204 ? null : r.json()),
      }),
      providesTags: (_r, _e, id) => [{ type: "Share", id }],
    }),

    createShare: builder.mutation<
      ShareResponse,
      { id: string; body?: ShareCreateRequest }
    >({
      query: ({ id, body }) => ({
        url: `/meetings/${id}/share`,
        method: "POST",
        body: body ?? {},
      }),
      invalidatesTags: (_r, _e, arg) => [{ type: "Share", id: arg.id }],
    }),

    revokeShare: builder.mutation<void, string>({
      query: (id) => ({ url: `/meetings/${id}/share`, method: "DELETE" }),
      invalidatesTags: (_r, _e, id) => [{ type: "Share", id }],
    }),

    // ---- Follow-up email ----
    draftFollowUpEmail: builder.mutation<EmailDraft, string>({
      query: (id) => ({ url: `/meetings/${id}/follow-up-email`, method: "POST" }),
    }),

    // ---- Billing & usage ----
    checkout: builder.mutation<CheckoutResponse, CheckoutRequest>({
      query: (body) => ({ url: "/billing/checkout", method: "POST", body }),
    }),

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
  useImportMeetingMutation,
  useGetPreferencesQuery,
  useUpdatePreferencesMutation,
  useGetTranscriptQuery,
  useGetSummaryQuery,
  useGetSummaryTemplatesQuery,
  useResummarizeMutation,
  useGetMeetingActionItemsQuery,
  useCreateActionItemMutation,
  useGetMomentsQuery,
  useCreateMomentMutation,
  useUpdateMomentMutation,
  useDeleteMomentMutation,
  useReprocessMeetingMutation,
  useDeleteMeetingMutation,
  useGetChatQuery,
  useAskChatMutation,
  useGetWorkspaceChatQuery,
  useAskWorkspaceChatMutation,
  useClearWorkspaceChatMutation,
  useSemanticSearchMutation,
  useTranslateSummaryMutation,
  useRenameSpeakersMutation,
  useRematchSpeakerMutation,
  useGetKnownSpeakersQuery,
  useDeleteKnownSpeakerMutation,
  useGetVocabularyQuery,
  useCreateVocabularyTermMutation,
  useUpdateVocabularyTermMutation,
  useDeleteVocabularyTermMutation,
  useEditSegmentsMutation,
  useGetActionItemsQuery,
  usePatchActionItemMutation,
  useGetShareQuery,
  useCreateShareMutation,
  useRevokeShareMutation,
  useDraftFollowUpEmailMutation,
  useCheckoutMutation,
  useGetUsageQuery,
} = api;
