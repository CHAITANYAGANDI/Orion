import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

interface UiState {
  sidebarOpen: boolean;
  // Local-only notification preferences (settings page).
  notifyEmail: boolean;
  notifyProcessingDone: boolean;
}

const initialState: UiState = {
  sidebarOpen: false,
  notifyEmail: true,
  notifyProcessingDone: true,
};

const uiSlice = createSlice({
  name: "ui",
  initialState,
  reducers: {
    toggleSidebar(state) {
      state.sidebarOpen = !state.sidebarOpen;
    },
    setSidebarOpen(state, action: PayloadAction<boolean>) {
      state.sidebarOpen = action.payload;
    },
    setNotifyEmail(state, action: PayloadAction<boolean>) {
      state.notifyEmail = action.payload;
    },
    setNotifyProcessingDone(state, action: PayloadAction<boolean>) {
      state.notifyProcessingDone = action.payload;
    },
  },
});

export const {
  toggleSidebar,
  setSidebarOpen,
  setNotifyEmail,
  setNotifyProcessingDone,
} = uiSlice.actions;

export default uiSlice.reducer;
