import { useState } from "react";
import { authUpdateMe, authChangePassword } from "../../api.js";
import { useAuth } from "../../context/AuthContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  title: string;
}

export default function UserSettingsPanel({ title }: Props) {
  const { user, logout } = useAuth();

  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSaving, setPasswordSaving] = useState(false);

  const isLocal = !user?.authSource || user.authSource === "local";

  async function handleSaveProfile() {
    setProfileError(null);
    setProfileSaved(false);
    setProfileSaving(true);
    try {
      await authUpdateMe({ name: name.trim(), email: email.trim() });
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 2500);
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setProfileSaving(false);
    }
  }

  async function handleChangePassword() {
    setPasswordError(null);
    setPasswordSaved(false);
    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords do not match");
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError("New password must be at least 8 characters");
      return;
    }
    setPasswordSaving(true);
    try {
      await authChangePassword({ currentPassword, newPassword });
      setPasswordSaved(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setTimeout(() => setPasswordSaved(false), 2500);
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setPasswordSaving(false);
    }
  }

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">

        {/* Profile */}
        <div className="section">
          <div className="card">
            <div className="card-header">
              <h3>Profile</h3>
            </div>
            <div className="form-group">
              <label>Display Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={{ maxWidth: 360 }}
              />
            </div>
            <div className="form-group">
              <label>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={{ maxWidth: 360 }}
              />
            </div>
            {profileError && <div className="error-msg">{profileError}</div>}
            <button
              className="btn btn-primary"
              onClick={handleSaveProfile}
              disabled={profileSaving}
            >
              {profileSaved ? "Saved" : profileSaving ? "Saving…" : "Save Profile"}
            </button>
          </div>
        </div>

        {/* Password — local accounts only */}
        {isLocal && (
          <div className="section">
            <div className="card">
              <div className="card-header">
                <h3>Change Password</h3>
              </div>
              <div className="form-group">
                <label>Current Password</label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  autoComplete="current-password"
                  style={{ maxWidth: 360 }}
                />
              </div>
              <div className="form-group">
                <label>New Password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  style={{ maxWidth: 360 }}
                />
              </div>
              <div className="form-group">
                <label>Confirm New Password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  style={{ maxWidth: 360 }}
                />
              </div>
              {passwordError && <div className="error-msg">{passwordError}</div>}
              <button
                className="btn btn-primary"
                onClick={handleChangePassword}
                disabled={passwordSaving || !currentPassword || !newPassword || !confirmPassword}
              >
                {passwordSaved ? "Password Changed" : passwordSaving ? "Saving…" : "Change Password"}
              </button>
            </div>
          </div>
        )}

        {/* Session */}
        <div className="section">
          <div className="card">
            <div className="card-header">
              <h3>Session</h3>
            </div>
            <div className="form-group">
              <div className="settings-description">
                Signed in as <strong>{user?.email}</strong>
                {user?.authSource && user.authSource !== "local" && (
                  <span style={{ marginLeft: 8, opacity: 0.6 }}>via {user.authSource}</span>
                )}
              </div>
            </div>
            <button className="btn btn-danger" onClick={logout}>
              Sign Out
            </button>
          </div>
        </div>

      </div>
    </CanvasPanelHost>
  );
}
