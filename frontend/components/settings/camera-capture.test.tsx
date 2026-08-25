import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CameraCapture } from "@/components/settings/camera-capture";

/**
 * Almost all of this is about the camera light going off.
 *
 * A stream that outlives the dialog leaves the webcam running, and somebody who
 * granted access to set a profile picture has not agreed to be filmed while
 * they carry on using the app. Every exit has to stop it: cancel, capture,
 * closing, and unmounting.
 */
const stop = vi.fn();
let tracks: { stop: () => void }[];
let getUserMedia: ReturnType<typeof vi.fn>;

function fakeStream() {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

beforeEach(() => {
  stop.mockClear();
  tracks = [{ stop }, { stop }];
  getUserMedia = vi.fn().mockResolvedValue(fakeStream());
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  // jsdom has no media pipeline; play() rejecting is normal there.
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function show(open = true) {
  const onClose = vi.fn();
  const onCapture = vi.fn();
  const view = render(
    <CameraCapture open={open} onClose={onClose} onCapture={onCapture} />,
  );
  return { onClose, onCapture, view };
}

describe("CameraCapture", () => {
  it("asks for no audio", async () => {
    show();
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());

    // A profile photo needs a picture. Requesting the microphone as well would
    // put a recording indicator on a dialog that records nothing.
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ audio: false }),
    );
  });

  it("does not touch the camera until it is opened", () => {
    show(false);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("stops every track when cancelled", async () => {
    const { onClose } = show();
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(stop).toHaveBeenCalledTimes(tracks.length);
    expect(onClose).toHaveBeenCalled();
  });

  it("stops every track when unmounted", async () => {
    const { view } = show();
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());

    view.unmount();

    expect(stop).toHaveBeenCalledTimes(tracks.length);
  });

  it("stops the stream that arrives after the dialog has already closed", async () => {
    // The permission prompt can outlive the dialog. Nobody will ever see this
    // stream, and leaving it running leaves the light on with no window to
    // explain why.
    let release: (s: MediaStream) => void = () => {};
    getUserMedia.mockReturnValue(new Promise<MediaStream>((r) => { release = r; }));

    const { view } = show();
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    view.unmount();
    release(fakeStream());

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(tracks.length));
  });

  it("explains a blocked camera instead of failing silently", async () => {
    getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    show();

    await waitFor(() =>
      expect(screen.getByText(/Camera access was blocked/)).toBeInTheDocument(),
    );
    // And points at the way out, which is the other button on the profile.
    expect(screen.getByText(/upload a picture instead/)).toBeInTheDocument();
  });

  it("says so when the browser has no camera API at all", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });
    show();

    await waitFor(() =>
      expect(screen.getByText(/cannot reach a camera/)).toBeInTheDocument(),
    );
  });

  it("cannot capture before the stream is ready", async () => {
    getUserMedia.mockReturnValue(new Promise(() => {}));
    show();

    expect(screen.getByRole("button", { name: /Capture/ })).toBeDisabled();
  });

  it("promises nothing is sent until Finish", async () => {
    show();
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());

    expect(screen.getByText(/Nothing is sent anywhere until you press Finish/))
      .toBeInTheDocument();
  });
});
