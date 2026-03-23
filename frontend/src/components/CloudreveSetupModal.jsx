import React, { useEffect, useRef, useState } from "react";

// Cloudflare recommends explicit rendering for SPAs.
// Script URL must be fetched from Cloudflare directly.
const TURNSTILE_SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function ensureScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "true") return resolve();
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error(`Failed to load script: ${src}`)),
        { once: true },
      );
      return;
    }

    const s = document.createElement("script");
    s.src = src;
    s.defer = true;
    s.async = true;
    s.dataset.loaded = "false";
    s.onload = () => {
      s.dataset.loaded = "true";
      resolve();
    };
    s.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(s);
  });
}

export default function CloudreveSetupModal({
  open,
  setup,
  onSubmit,
  onRefreshCaptcha,
  onClose,
}) {
  const [captchaText, setCaptchaText] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileStatus, setTurnstileStatus] = useState("");

  const widgetContainerRef = useRef(null);
  const widgetIdRef = useRef(null);

  const captchaType =
    setup?.captchaType || setup?.cfg?.captcha_type || "unknown";
  const cfg = setup?.cfg || {};
  const cap = setup?.captcha || {};
  const ticket = cap.ticket || "";
  const image = cap.image || "";

  useEffect(() => {
    if (!open) return;
    setCaptchaText("");
    setTurnstileToken("");
    setTurnstileStatus("");
  }, [open, captchaType]);

  useEffect(() => {
    if (!open) return;
    if (captchaType !== "turnstile") return;

    const siteKey = cfg.turnstile_site_id;
    if (!siteKey) {
      setTurnstileStatus("Turnstile site key missing in Cloudreve config.");
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        await ensureScript(TURNSTILE_SCRIPT);
        if (cancelled) return;

        if (!window.turnstile) {
          setTurnstileStatus(
            "Turnstile script loaded but window.turnstile is missing.",
          );
          return;
        }
        if (!widgetContainerRef.current) return;

        // Remove previous widget if any
        if (widgetIdRef.current != null && window.turnstile.remove) {
          try {
            window.turnstile.remove(widgetIdRef.current);
          } catch {
            // ignore
          }
        }

        widgetIdRef.current = window.turnstile.render(
          widgetContainerRef.current,
          {
            sitekey: siteKey,
            callback: (token) => {
              setTurnstileToken(token);
              setTurnstileStatus("");
            },
            "expired-callback": () => {
              setTurnstileToken("");
              setTurnstileStatus("Security check expired. Please try again.");
            },
            "error-callback": () => {
              setTurnstileToken("");
              setTurnstileStatus("Security check failed. Please try again.");
            },
            "timeout-callback": () => {
              setTurnstileToken("");
              setTurnstileStatus("Security check timed out. Please try again.");
            },
          },
        );
      } catch (e) {
        setTurnstileStatus(e.message || "Failed to load Turnstile.");
      }
    })();

    return () => {
      cancelled = true;
      if (widgetIdRef.current != null && window.turnstile?.remove) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // ignore
        }
      }
      widgetIdRef.current = null;
    };
  }, [open, captchaType, cfg.turnstile_site_id]);

  if (!open) return null;

  // Minimal inline styles so we don't need to touch style.css
  const styles = {
    backdrop: {
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.6)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 9999,
    },
    modal: {
      width: "min(520px, 92vw)",
      background: "#111",
      border: "1px solid rgba(255,255,255,0.12)",
      borderRadius: 12,
      padding: 18,
      color: "white",
    },
    row: {
      display: "flex",
      gap: 10,
      justifyContent: "flex-end",
      marginTop: 12,
    },
    img: {
      maxWidth: "100%",
      borderRadius: 8,
      border: "1px solid rgba(255,255,255,0.15)",
    },
    input: {
      width: "100%",
      padding: "10px 12px",
      borderRadius: 10,
      border: "1px solid rgba(255,255,255,0.15)",
      background: "#0b0b0b",
      color: "white",
      marginTop: 10,
    },
    small: { opacity: 0.8, fontSize: 13 },
  };

  return (
    <div style={styles.backdrop}>
      <div style={styles.modal}>
        <h2 style={{ marginTop: 0 }}>Storage setup required</h2>

        {setup?.requiresActivation ? (
          <>
            <p>
              Your Cloudreve account was created, but it is not active yet.
              Please check your email and complete activation, then click Retry.
            </p>
            <div style={styles.row}>
              <button type="button" className="secondary-btn" onClick={onClose}>
                Close
              </button>
              <button
                type="button"
                className="primary-btn"
                onClick={() => onSubmit({})}
              >
                Retry
              </button>
            </div>
          </>
        ) : null}

        {!setup?.requiresActivation && captchaType === "normal" ? (
          <>
            <p>Please enter the CAPTCHA to continue.</p>
            <p style={styles.small}>
              (This appears only when your Cloudreve server requires captcha for
              sign-up or login.)
            </p>

            {image ? (
              <img
                style={styles.img}
                alt="captcha"
                src={
                  image.startsWith("data:")
                    ? image
                    : `data:image/png;base64,${image}`
                }
              />
            ) : (
              <p>Loading captcha…</p>
            )}

            <input
              style={styles.input}
              value={captchaText}
              onChange={(e) => setCaptchaText(e.target.value)}
              placeholder="Captcha"
            />

            <div style={styles.row}>
              <button
                type="button"
                className="secondary-btn"
                onClick={onRefreshCaptcha}
              >
                Refresh
              </button>
              <button
                type="button"
                className="primary-btn"
                disabled={!captchaText || !ticket}
                onClick={() => onSubmit({ captcha: captchaText, ticket })}
              >
                Continue
              </button>
            </div>
          </>
        ) : null}

        {!setup?.requiresActivation && captchaType === "turnstile" ? (
          <>
            <p>Please complete the security check to continue.</p>

            <div ref={widgetContainerRef} />

            {turnstileStatus ? (
              <p className="message">{turnstileStatus}</p>
            ) : null}

            <div style={styles.row}>
              <button type="button" className="secondary-btn" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-btn"
                disabled={!turnstileToken}
                onClick={() =>
                  onSubmit({ captcha: turnstileToken, ticket: "" })
                }
              >
                Continue
              </button>
            </div>
          </>
        ) : null}

        {!setup?.requiresActivation &&
        captchaType !== "normal" &&
        captchaType !== "turnstile" ? (
          <>
            <p>
              Unsupported captcha type: <strong>{captchaType}</strong>
            </p>
            <p style={styles.small}>
              Cloudreve supports multiple captcha providers. This app currently
              implements:
              <strong> normal</strong> (image captcha) and{" "}
              <strong>turnstile</strong>. If your Cloudreve is configured for
              reCAPTCHA or another type, add the appropriate widget to this
              modal.
            </p>

            <div style={styles.row}>
              <button type="button" className="secondary-btn" onClick={onClose}>
                Close
              </button>
              <button
                type="button"
                className="primary-btn"
                onClick={() => onSubmit({})}
              >
                Retry anyway
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
