import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

interface UiState {
  sidebarOpen: boolean;
  // Local-only notification preference (settings page).
  notifyEmail: boolean;
}

const initialState: UiState = {
  sidebarOpen: false,
  notifyEmail: true,
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
  },
});

export const {
  toggleSidebar,
  setSidebarOpen,
  setNotifyEmail,
} = uiSlice.actions;

export default uiSlice.reducer;
