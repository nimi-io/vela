import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles.css";
import { SessionProvider, useSession } from "./lib/session";
import { ToastProvider, Loading } from "./components/ui";
import { Layout } from "./components/Layout";
import { AuthPage } from "./pages/Auth";
import { OverviewPage } from "./pages/Overview";
import { VideosPage } from "./pages/Videos";
import { VideoPage } from "./pages/Video";
import { LiveListPage, LivePage } from "./pages/Live";
import { AnalyticsPage } from "./pages/Analytics";
import { ApiKeysPage, SigningKeysPage } from "./pages/Keys";
import { WebhooksPage, WebhookPage } from "./pages/Webhooks";
import { DrmPage } from "./pages/Drm";
import { UsagePage } from "./pages/Usage";
import { SettingsPage } from "./pages/Settings";
import { DocsPage } from "./pages/Docs";

const qc = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 5_000 } },
});

function Protected() {
  const { me, loading, env } = useSession();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (!env) return <div className="page">You don't have access to any environment yet. Ask an owner to invite you.</div>;
  return <Layout />;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/signup" element={<AuthPage mode="signup" />} />
      <Route element={<Protected />}>
        <Route index element={<OverviewPage />} />
        <Route path="videos" element={<VideosPage />} />
        <Route path="videos/:id" element={<VideoPage />} />
        <Route path="live" element={<LiveListPage />} />
        <Route path="live/:id" element={<LivePage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="api-keys" element={<ApiKeysPage />} />
        <Route path="signing-keys" element={<SigningKeysPage />} />
        <Route path="webhooks" element={<WebhooksPage />} />
        <Route path="webhooks/:id" element={<WebhookPage />} />
        <Route path="docs" element={<DocsPage />} />
        <Route path="docs/:section" element={<DocsPage />} />
        <Route path="drm" element={<DrmPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<div className="page">Page not found.</div>} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ToastProvider>
          <SessionProvider>
            <App />
          </SessionProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
