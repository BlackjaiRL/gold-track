import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import "./style.css";

function App() {
  const [message, setMessage] = useState("Click the button");

  const checkBackend = async () => {
    try {
      const res = await fetch("http://localhost:3000/api/health");
      const data = await res.json();
      setMessage(JSON.stringify(data, null, 2));
    } catch (err) {
      setMessage(`Error: ${err.message}`);
    }
  };

  return (
    <div className="container">
      <h1>Gold Track</h1>
      <p>Frontend + Backend + MySQL + Docker</p>
      <button onClick={checkBackend}>Check Backend</button>
      <pre>{message}</pre>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);