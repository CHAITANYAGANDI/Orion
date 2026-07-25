import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import { buildAuthHeaders } from "@/lib/auth-store";
import type {
  ActionItemListQuery,
  ActionItemPatchRequest,
  ActionItemResponse,
  AgentAction,
  AgentPlanResponse,
  ChatMessage,
  CheckoutRequest,
  CheckoutResponse,
  DecisionResponse,
  IntegrationProvider,
  IntegrationResponse,
  MeetingCreateRequest,
  MeetingListQuery,
  MeetingResponse,
  Page,
  ReprocessResponse,
  RiskResponse,
  SummaryResponse,
  TranscriptResponse,
  TranslateResult,
  UploadUrlRequest,
  UploadUrlResponse,
  UsageResponse,
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
    "Integrations",
    "AgentActions",
    "Chat",
    "Transcript",
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

    getTranscript: builder.query<TranscriptResponse, string>({
      query: (id) => `/meetings/${id}/transcript`,
      providesTags: (_r, _e, id) => [{ type: "Transcript", id }],
    }),

    getSummary: builder.query<SummaryResponse, string>({
      query: (id) => `/meetings/${id}/summary`,
    }),

    getMeetingActionItems: builder.query<ActionItemResponse[], string>({
      query: (id) => `/meetings/${id}/action-items`,
      providesTags: [{ type: "ActionItems", id: "LIST" }],
    }),

    getDecisions: builder.query<DecisionResponse[], string>({
      query: (id) => `/meetings/${id}/decisions`,
    }),

    getRisks: builder.query<RiskResponse[], string>({
      query: (id) => `/meetings/${id}/risks`,
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

    // ---- Billing & usage ----
    checkout: builder.mutation<CheckoutResponse, CheckoutRequest>({
      query: (body) => ({ url: "/billing/checkout", method: "POST", body }),
    }),

    getUsage: builder.query<UsageResponse, void>({
      query: () => "/usage",
      providesTags: [{ type: "Usage", id: "ME" }],
    }),

    // ---- Phase 2: Integrations ----
    getIntegrations: builder.query<IntegrationResponse[], void>({
      query: () => "/integrations",
      providesTags: [{ type: "Integrations", id: "LIST" }],
    }),

    connectIntegration: builder.mutation<
      IntegrationResponse,
      IntegrationProvider
    >({
      query: (provider) => ({
        url: `/integrations/${provider}/connect`,
        method: "POST",
      }),
      invalidatesTags: [{ type: "Integrations", id: "LIST" }],
    }),

    disconnectIntegration: builder.mutation<void, IntegrationProvider>({
      query: (provider) => ({
        url: `/integrations/${provider}`,
        method: "DELETE",
      }),
      invalidatesTags: [{ type: "Integrations", id: "LIST" }],
    }),

    // ---- Phase 2: Agent ----
    planAgent: builder.mutation<AgentPlanResponse, string>({
      query: (meetingId) => ({
        url: `/meetings/${meetingId}/agent/plan`,
        method: "POST",
      }),
      invalidatesTags: [{ type: "AgentActions", id: "LIST" }],
    }),

    getAgentActions: builder.query<AgentAction[], void>({
      query: () => "/agent/actions",
      providesTags: [{ type: "AgentActions", id: "LIST" }],
    }),

    approveAgentAction: builder.mutation<AgentAction, string>({
      query: (id) => ({ url: `/agent/actions/${id}/approve`, method: "POST" }),
      invalidatesTags: [{ type: "AgentActions", id: "LIST" }],
    }),

    executeAgentAction: builder.mutation<AgentAction, string>({
      query: (id) => ({ url: `/agent/actions/${id}/execute`, method: "POST" }),
      invalidatesTags: [{ type: "AgentActions", id: "LIST" }],
    }),
  }),
});

export const {
  useGetMeetingsQuery,
  useGetMeetingQuery,
  useCreateUploadUrlMutation,
  useCreateMeetingMutation,
  useGetTranscriptQuery,
  useGetSummaryQuery,
  useGetMeetingActionItemsQuery,
  useGetDecisionsQuery,
  useGetRisksQuery,
  useReprocessMeetingMutation,
  useDeleteMeetingMutation,
  useGetChatQuery,
  useAskChatMutation,
  useTranslateSummaryMutation,
  useRenameSpeakersMutation,
  useGetActionItemsQuery,
  usePatchActionItemMutation,
  useCheckoutMutation,
  useGetUsageQuery,
  useGetIntegrationsQuery,
  useConnectIntegrationMutation,
  useDisconnectIntegrationMutation,
  usePlanAgentMutation,
  useGetAgentActionsQuery,
  useApproveAgentActionMutation,
  useExecuteAgentActionMutation,
} = api;
