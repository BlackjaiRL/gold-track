import React, { useEffect, useRef, useState } from "react";
import { apiFetch, setToken, setUser } from "../api";

export default function AuthPage({ onAuthSuccess }) {
  const [mode, setMode] = useState("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const googleInitializedRef = useRef(false);

  const googleClientId =
    import.meta.env.VITE_GOOGLE_CLIENT_ID ||
    "762224078192-tv7o5kl9e7u8841te2g0j7kvdd2q3jhl.apps.googleusercontent.com";

  useEffect(() => {
    let cancelled = false;

    function tryInitGoogle() {
      if (cancelled) return false;
      if (googleInitializedRef.current) return true;

      const g = window.google?.accounts?.id;
      if (!g) return false;

      g.initialize({
        client_id: googleClientId,
        callback: handleGoogleResponse,
      });

      const el = document.getElementById("googleSignInDiv");
      if (el) {
        g.renderButton(el, {
          theme: "outline",
          size: "large",
          width: 260,
        });
      }

      googleInitializedRef.current = true;
      return true;
    }

    // The GIS script is loaded async/defer in index.html. On first render,
    // window.google may not exist yet, so we poll briefly.
    if (tryInitGoogle()) return;

    const timer = setInterval(() => {
      if (tryInitGoogle()) {
        clearInterval(timer);
      }
    }, 200);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleGoogleResponse(response) {
    try {
      setMessage("Signing in with Google...");
      const data = await apiFetch("/auth/google", {
        method: "POST",
        body: JSON.stringify({
          credential: response.credential,
        }),
      });

      setToken(data.token);
      setUser(data.user);

      setMessage(
        data.cloudreveSetupRequired
          ? "Google login successful. Storage setup required..."
          : "Google login successful",
      );

      onAuthSuccess();
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();

    try {
      setMessage(mode === "login" ? "Logging in..." : "Registering...");

      const path = mode === "login" ? "/auth/login" : "/auth/register";
      const body =
        mode === "login" ? { email, password } : { name, email, password };

      const data = await apiFetch(path, {
        method: "POST",
        body: JSON.stringify(body),
      });

      setToken(data.token);
      setUser(data.user);

      setMessage(
        data.cloudreveSetupRequired
          ? mode === "login"
            ? "Login successful. Storage setup required..."
            : "Registration successful. Storage setup required..."
          : mode === "login"
            ? "Login successful"
            : "Registration successful",
      );

      onAuthSuccess();
    } catch (err) {
      setMessage(err.message);
    }
  }

  return (
    <div className="auth-page">
      <div className="card auth-card">
        <h1>Gold Track</h1>
        <p className="subtitle">Track the value of your gold items</p>

        <div className="tab-row">
          <button
            className={mode === "login" ? "tab active" : "tab"}
            onClick={() => setMode("login")}
            type="button"
          >
            Login
          </button>
          <button
            className={mode === "register" ? "tab active" : "tab"}
            onClick={() => setMode("register")}
            type="button"
          >
            Register
          </button>
        </div>

        <form onSubmit={handleSubmit} className="form">
          {mode === "register" && (
            <div className="field">
              <label>Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
              />
            </div>
          )}

          <div className="field">
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </div>

          <div className="field">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              required
            />
          </div>

          <button className="primary-btn" type="submit">
            {mode === "login" ? "Login" : "Register"}
          </button>
        </form>

        <div className="divider">or</div>

        <div id="googleSignInDiv" className="google-box"></div>

        {message && <p className="message">{message}</p>}
      </div>
    </div>
  );
}
