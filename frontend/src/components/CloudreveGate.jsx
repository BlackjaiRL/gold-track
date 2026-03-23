import React, { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api";
import CloudreveSetupModal from "./CloudreveSetupModal";

async function ensureCloudreve(payload) {
  return apiFetch("/auth/cloudreve/ensure", {
    method: "POST",
    body: JSON.stringify(payload || {}),
  });
}

async function getCloudreveConfig() {
  return apiFetch("/auth/cloudreve/config");
}

async function getCloudreveCaptcha() {
  return apiFetch("/auth/cloudreve/captcha");
}

export default function CloudreveGate({ children }) {
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [setup, setSetup] = useState(null);
  const [message, setMessage] = useState("");

  async function hydrateSetup(base) {
    // Ensure we have cfg for captcha_type/site keys.
    let cfg = base?.cfg;
    if (!cfg) {
      try {
        cfg = await getCloudreveConfig();
      } catch {
        cfg = null;
      }
    }

    const captchaType = base?.captchaType || cfg?.captcha_type || null;

    let captcha = base?.captcha;
    if (captchaType === "normal") {
      // Ensure we have image + ticket.
      if (!captcha?.image || !captcha?.ticket) {
        try {
          captcha = await getCloudreveCaptcha();
        } catch {
          // leave as-is
        }
      }
    }

    return {
      ...base,
      cfg,
      captchaType,
      captcha,
    };
  }

  async function refreshCaptcha() {
    setMessage("Refreshing captcha...");
    try {
      const cap = await getCloudreveCaptcha();
      setSetup((prev) => ({
        ...(prev || {}),
        captchaType: prev?.captchaType || prev?.cfg?.captcha_type,
        captcha: cap,
      }));
      setMessage("");
    } catch (e) {
      setMessage(e.message || "Failed to refresh captcha");
    }
  }

  async function runEnsure(payload) {
    setLoading(true);
    setMessage("");

    try {
      await ensureCloudreve(payload);
      setReady(true);
      setModalOpen(false);
      setSetup(null);
      setMessage("");
    } catch (err) {
      // 428 is our contract: captcha required / activation required
      if (err instanceof ApiError && err.status === 428) {
        const hydrated = await hydrateSetup(err.data || {});
        setSetup(hydrated);
        setModalOpen(true);
        setReady(false);
        setMessage("");
      } else {
        // Unexpected error; still show modal so user can retry.
        const hydrated = await hydrateSetup({
          captchaRequired: true,
          captchaType: null,
          cfg: null,
          reason: err.message || "Storage setup failed",
        });
        setSetup(hydrated);
        setModalOpen(true);
        setReady(false);
        setMessage(err.message || "Storage setup failed");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // One-time ensure on mount. If captcha is required, we show the modal.
    runEnsure({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading && !ready) {
    return (
      <div style={{ padding: 24 }}>
        <p>Preparing your account...</p>
      </div>
    );
  }

  return (
    <>
      {ready ? children : null}

      <CloudreveSetupModal
        open={modalOpen}
        setup={setup}
        onClose={() => setModalOpen(false)}
        onRefreshCaptcha={refreshCaptcha}
        onSubmit={(payload) => runEnsure(payload)}
      />

      {message && !modalOpen && (
        <div style={{ padding: 16 }}>
          <p className="message">{message}</p>
        </div>
      )}
    </>
  );
}
