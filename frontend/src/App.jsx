import React, { useEffect, useState } from "react";
import AuthPage from "./components/AuthPage";
import Dashboard from "./components/Dashboard";
import { getToken, getUser, clearToken, clearUser } from "./api";

export default function App() {
  const [token, setTokenState] = useState(getToken());
  const [user, setUserState] = useState(getUser());

  useEffect(() => {
    setTokenState(getToken());
    setUserState(getUser());
  }, []);

  const handleAuthSuccess = () => {
    setTokenState(getToken());
    setUserState(getUser());
  };

  const handleLogout = () => {
    clearToken();
    clearUser();
    setTokenState(null);
    setUserState(null);
  };

  return (
    <div className="app-shell">
      {!token ? (
        <AuthPage onAuthSuccess={handleAuthSuccess} />
      ) : (
        <Dashboard user={user} onLogout={handleLogout} />
      )}
    </div>
  );
}