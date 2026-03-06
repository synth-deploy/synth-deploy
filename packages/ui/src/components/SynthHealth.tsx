import { useState, useEffect } from "react";
import { getHealth } from "../api.js";

export default function SynthHealth() {
  const [health, setHealth] = useState<{ status: string; timestamp: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch(() => setError("Synth unreachable"));
  }, []);

  if (error) {
    return (
      <div className="card">
        <div className="card-header">
          <h3>Synth Health</h3>
        </div>
        <div className="badge badge-failed">Offline</div>
        <p className="text-muted" style={{ marginTop: 8, fontSize: 12 }}>{error}</p>
      </div>
    );
  }

  if (!health) {
    return (
      <div className="card">
        <div className="card-header">
          <h3>Synth Health</h3>
        </div>
        <p className="text-muted" style={{ fontSize: 12 }}>Checking...</p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-header">
        <h3>Synth Health</h3>
      </div>
      <div className="badge badge-succeeded">Online</div>
      <p className="text-muted" style={{ marginTop: 8, fontSize: 11 }}>
        {new Date(health.timestamp).toLocaleString()}
      </p>
    </div>
  );
}
