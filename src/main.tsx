import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import App from './App';
import AppShell from './components/AppShell';
import AnalysisPage from './routes/AnalysisPage';
import ComparePage from './routes/ComparePage';
import DocsPage from './routes/DocsPage';
import SearchesPage from './routes/SearchesPage';
import SessionsPage from './routes/SessionsPage';
import SettingsPage from './routes/SettingsPage';
import './styles/global.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={window.CRIBL_BASE_PATH ?? '/'}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<App />} />
          <Route path="searches" element={<SearchesPage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="compare" element={<ComparePage />} />
          <Route path="analysis" element={<AnalysisPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="docs" element={<DocsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
