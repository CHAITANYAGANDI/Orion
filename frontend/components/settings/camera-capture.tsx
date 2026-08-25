"use client";

/**
 * Take a profile photo with the webcam.
 *
 * <p>The whole of this component is about the camera light. A stream that
 * outlives the dialog leaves it on, and a person who granted access to set a
 * profile picture has not agreed to be filmed while they carry on using the
 * app. So the stream is started when it opens and stopped on every path out of
 * here — cancel, capture, unmount, and the browser tab going away.
 *
 * <p>Nothing is uploaded. The frame is drawn to a canvas and handed back as a
 * data URL, the same shape the file picker produces, so the dialog above does
 * not care which button was pressed.
 */

import * as React from "react";
import { Camera, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toSquareDataUrl } from "@/lib/avatar";

export function CameraCapture({
  open,
  onClose,
  onCapture,
}: {
  open: boolean;
  onClose: () => void;
  onCapture: (dataUrl: string) => void;
}) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [ready, setReady] = React.useState(false);

  const stop = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setReady(false);
  }, []);

  React.useEffect(() => {
    if (!open) {
      stop();
      return;
    }
    let cancelled = false;
    setError(null);

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("This browser cannot reach a camera.");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // A square-ish request, because the result is cropped to a square
          // anyway. Asking for 1920x1080 and throwing away the sides wastes
          // the bandwidth of the capture and the time of the downscale.
          video: { width: { ideal: 640 }, height: { ideal: 640 }, facingMode: "user" },
          audio: false,
        });
        if (cancelled) {
          // The dialog closed while the permission prompt was up. Nobody is
          // going to see this stream, and leaving it running leaves the light
          // on with no window to explain it.
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setReady(true);
      } catch (err) {
        setError(
          err instanceof DOMException && err.name === "NotAllowedError"
            ? "Camera access was blocked. Allow it in your browser, or upload a picture instead."
            : "No camera was available.",
        );
      }
    }

    void start();
    return () => {
      cancelled = true;
      stop();
    };
  }, [open, stop]);

  function take() {
    const video = videoRef.current;
    if (!video) return;
    try {
      onCapture(toSquareDataUrl(video, video.videoWidth, video.videoHeight));
    } catch {
      setError("That frame could not be captured.");
    } finally {
      stop();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          stop();
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Take a photo</DialogTitle>
          <DialogDescription>
            Nothing is sent anywhere until you press Finish on your profile.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <div className="relative overflow-hidden rounded-full bg-muted"
               style={{ aspectRatio: "1 / 1" }}>
            <video
              ref={videoRef}
              playsInline
              muted
              data-testid="camera-preview"
              // Mirrored, because an unmirrored preview of your own face reads
              // as broken -- every other camera surface a person has used shows
              // them the way a mirror does.
              className="h-full w-full -scale-x-100 object-cover"
            />
            {!ready && (
              <span className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </span>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              stop();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button onClick={take} disabled={!ready || !!error} className="gap-1.5">
            <Camera className="h-4 w-4" /> Capture
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
