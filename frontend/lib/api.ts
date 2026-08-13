import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import { buildAuthHeaders } from "@/lib/auth-store";
import type {
  ActionItemListQuery,
  ActionItemPatchRequest,
  ActionItemResponse,
  ChatMessage,
  CheckoutRequest,
  CheckoutResponse,
  EmailDraft,
  ShareCreateRequest,
  ShareResponse,
  MeetingCreateRequest,
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
      invalidatesTags: (_r, _e, arg) => [{ type: "Transcript", id: arg.id }],
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
  useImportMeetingMutation,
  useGetPreferencesQuery,
  useUpdatePreferencesMutation,
  useGetTranscriptQuery,
  useGetSummaryQuery,
  useGetSummaryTemplatesQuery,
  useResummarizeMutation,
  useGetMeetingActionItemsQuery,
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
