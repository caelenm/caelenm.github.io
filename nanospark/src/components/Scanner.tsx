import { useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

/** The platform barcode API, where it exists (Chrome on Android, Safari 17+, some desktops). */
type NativeDetector = { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> };

const SCAN_INTERVAL_MS = 180;
/** Frames are downscaled before decoding; a QR code does not need 4K to read. */
const MAX_DECODE_EDGE = 720;

/**
 * Camera QR scanning.
 *
 * The camera is opened here with getUserMedia and frames are decoded on a
 * timer, rather than handing the video element to zxing's continuous decoder.
 * That decoder owns the stream, and when the effect restarted (the parent
 * re-renders often, and StrictMode mounts twice) a late stop() from the old
 * instance tore down the new instance's stream on the shared <video> — the
 * "black screen with the camera light on" failure.
 *
 * Every stream is stopped on unmount; a wallet should not leave the camera
 * running behind a closed sheet.
 */
export function Scanner({ onResult, onCancel }: { onResult: (text: string) => void; onCancel: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onResultRef = useRef(onResult);
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      const v = videoRef.current;
      if (v) v.srcObject = null;
    };

    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setErr("This browser cannot open the camera here (it needs HTTPS). Paste instead.");
        return;
      }

      let s: MediaStream;
      try {
        s = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" } },
        });
      } catch (e) {
        if (stopped) return;
        const name = e instanceof DOMException ? e.name : "";
        setErr(
          name === "NotAllowedError" || name === "SecurityError"
            ? "Camera access was denied. Allow it in the browser's site settings, or paste instead."
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "No camera was found. Paste instead."
              : name === "NotReadableError"
                ? "The camera is in use by another app. Close it and try again, or paste instead."
                : "The camera could not be opened. Paste instead.",
        );
        return;
      }
      // Unmounted while the permission prompt was open.
      if (stopped) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = s;

      const video = videoRef.current;
      if (!video) {
        stop();
        return;
      }
      video.muted = true;
      video.playsInline = true;
      video.srcObject = s;
      try {
        await video.play();
      } catch {
        /* autoplay of a muted inline stream is allowed; if not, frames still arrive */
      }
      if (stopped) return;
      setLive(true);

      let native: NativeDetector | null = null;
      const Ctor = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => NativeDetector })
        .BarcodeDetector;
      if (Ctor) {
        try {
          native = new Ctor({ formats: ["qr_code"] });
        } catch {
          native = null;
        }
      }
      const zxing = new BrowserQRCodeReader();
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      const decode = async (): Promise<string | null> => {
        if (native) {
          try {
            const codes = await native.detect(video);
            return codes[0]?.rawValue || null;
          } catch {
            native = null; // fall through to zxing from now on
          }
        }
        if (!ctx) return null;
        const scale = Math.min(1, MAX_DECODE_EDGE / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        try {
          return zxing.decodeFromCanvas(canvas).getText() || null;
        } catch {
          return null; // no code in this frame
        }
      };

      const tick = async () => {
        if (stopped) return;
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
          const text = await decode();
          if (text && !stopped) {
            stop();
            onResultRef.current(text);
            return;
          }
        }
        if (!stopped) timer = setTimeout(() => void tick(), SCAN_INTERVAL_MS);
      };
      void tick();
    })();

    return stop;
  }, []);

  return (
    <div>
      {err ? (
        <div className="err">{err}</div>
      ) : (
        <div className="scanner-wrap">
          <video ref={videoRef} className="scanner" muted playsInline autoPlay />
          {!live && (
            <div className="scanner-status muted">
              Starting camera…
            </div>
          )}
        </div>
      )}
      <button className="btn ghost" style={{ width: "100%", marginTop: 12 }} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
