import { createContext, useContext, useState, useEffect } from "react";
import api from "../services/api";

const AuthContext = createContext(null);

// Grace date: users created before this date are not forced to verify email
const VERIFICATION_GRACE_DATE = "2026-04-13T00:00:00";

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (token) {
      api
        .get("/auth/me")
        .then((res) => setUser(res.data))
        .catch(() => localStorage.removeItem("token"))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (email, password) => {
    const res = await api.post("/auth/login", { email, password });
    localStorage.setItem("token", res.data.access_token);
    setUser(res.data.user);
    return res.data;
  };

  const register = async (data) => {
    const res = await api.post("/auth/register", data);
    localStorage.setItem("token", res.data.access_token);
    setUser(res.data.user);
    return res.data;
  };

  const googleLogin = async (credential) => {
    const res = await api.post("/auth/google", { credential });
    localStorage.setItem("token", res.data.access_token);
    setUser(res.data.user);
    return res.data;
  };

  const logout = () => {
    localStorage.removeItem("token");
    setUser(null);
  };

  /** Mark email as verified in local state (after successful verification) */
  const setEmailVerified = () => {
    setUser((prev) => prev ? { ...prev, email_verified: true } : prev);
  };

  /**
   * Whether this user needs email verification.
   * Returns false for legacy users created before the grace date,
   * and false for already-verified users.
   */
  const needsEmailVerification = () => {
    if (!user) return false;
    if (user.email_verified) return false;
    // Grace: users created before the feature launch date are exempt
    if (user.created_at && new Date(user.created_at) < new Date(VERIFICATION_GRACE_DATE)) {
      return false;
    }
    // If created_at is not available in the response, check email_verified only
    // (new users will have email_verified=false, legacy users who got the column
    //  added via migration also get false but won't have created_at in response,
    //  so we default to NOT forcing them — safe fallback)
    if (!user.created_at) return false;
    return true;
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, googleLogin, logout, setEmailVerified, needsEmailVerification }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
